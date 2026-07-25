import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import type { Server as HttpServer } from 'http';
import { state } from '../state.js';
import { navApi } from '../api/navigation.js';
import { speak } from './ttsService.js';
import { poiApi } from '../api/poi.js';
import { debugOdom, getTagMap, setTagMapEntry, deleteTagMapEntry, getTagFusionStatus, lastTagPose, pushPosToEsp } from './tcp.js';
import { broadcast } from './websocket.js';
import { startTagNav, cancelTagNav, getTagNavStatus } from '../api/tagNav.js';
import { goodsApi } from '../api/goods.js';
import { startTurnCalib, startDriveCalib, cancelCalib, getCalibStatus } from './motionCalib.js';

let sendToEsp: ((msg: string) => void) | null = null;
export function setSendToEsp(fn: (msg: string) => void) { sendToEsp = fn; }

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

/** Set by main.ts to enable pushing regenerated maps to all connected ESP32s */
let pushMapToEsp: (() => void) | null = null;
export function setMapPusher(fn: () => void) { pushMapToEsp = fn; }

export function createExpressApp(httpServer?: HttpServer) {
  const app = express();
  app.use(express.json());

  // REST API
  app.get('/api/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));
  app.get('/api/robot', (_req, res) => res.json({ ...state.robot, tcp_connected: state.robot.tcpConnected }));
  app.post('/api/robot/position', (req, res) => {
    const { x, y, angle } = req.body || {};
    if (x == null || y == null) return res.status(400).json({ error: 'x,y required' });
    lastTagPose.x = Number(x); lastTagPose.y = Number(y);
    lastTagPose.angle = Number(angle || 0); lastTagPose.ts = Date.now();
    state.updateRobot({ position: { x: lastTagPose.x, y: lastTagPose.y, angle: lastTagPose.angle } });
    pushPosToEsp(lastTagPose.x, lastTagPose.y, lastTagPose.angle * 180 / Math.PI);
    console.log(`[robot] Position set: (${lastTagPose.x}, ${lastTagPose.y})`);
    broadcast({ type: 'state', robot: state.robot });
    res.json({ ok: true, position: { x: lastTagPose.x, y: lastTagPose.y, angle: lastTagPose.angle } });
  });
  app.get('/api/map', (_req, res) => {
    const m = state.gridMap;
    if (!m) return res.status(404).json({ error: 'no map' });
    res.json({ width: m.width, height: m.height, res: m.res, ox: m.ox, oy: m.oy });
  });
  app.get('/api/map/data', (_req, res) => {
    const m = state.gridMap;
    if (!m || !m.data) return res.status(404).json({ error: 'no map data' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Map-Width', String(m.width));
    res.setHeader('X-Map-Height', String(m.height));
    res.send(Buffer.from(m.data.buffer, m.data.byteOffset, m.width * m.height));
  });

  /* Upload binary grid map generated from client-side Three.js raycasting */
  app.post('/api/map/upload', (req, res) => {
    try {
      const w = parseInt(req.headers['x-map-width'] as string);
      const h = parseInt(req.headers['x-map-height'] as string);
      const cellRes = parseFloat(req.headers['x-map-res'] as string);
      const ox = parseFloat(req.headers['x-map-ox'] as string);
      const oy = parseFloat(req.headers['x-map-oy'] as string);
      if (!w || !h || !cellRes) return res.status(400).json({ error: 'missing headers' });

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length !== w * h) {
          res.status(400).json({ error: `size mismatch: got ${buf.length} expected ${w * h}` });
          return;
        }
        state.setMap({ width: w, height: h, res: cellRes, ox, oy, data: new Uint8Array(buf) });
        // Persist to disk so the map survives server restart
        const mapsDir = join(__dirname, '..', '..', 'maps');
        const pgmPath = join(mapsDir, 'uploaded_map.pgm');
        const yamlPath = join(mapsDir, 'uploaded_map.yaml');
        try {
          fs.writeFileSync(pgmPath, Buffer.from('P5\n' + w + ' ' + h + '\n255\n'));
          const pixelData = buf; // already 0=occupied, 255=free
          fs.appendFileSync(pgmPath, pixelData);
          const yamlContent =
            `image: uploaded_map.pgm\nresolution: ${cellRes}\norigin: [${ox}, ${oy}, 0.0]\nnegate: 1\noccupied_thresh: 0.5\nfree_thresh: 0.5\n`;
          fs.writeFileSync(yamlPath, yamlContent);
          console.log(`[map] Persisted to ${pgmPath}`);
        } catch (e) {
          console.warn(`[map] Failed to persist: ${e}`);
        }
        console.log(`[map] Uploaded ${w}×${h} @ ${cellRes}m`);
        pushMapToEsp?.();
        res.json({ ok: true, width: w, height: h, res: cellRes });
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Debug
  app.get('/api/debug', (_req, res) => {
    const pos = state.robot.position;
    res.json({
      angleDeg: (pos.angle * 180 / Math.PI) % 360,
      angleRad: pos.angle,
      position: { x: pos.x, y: pos.y },
      odom: debugOdom,
      tagFusion: getTagFusionStatus(),
    });
  });

  // AprilTag map management
  app.get('/api/tags', (_req, res) => {
    res.json(getTagMap());
  });
  app.post('/api/tags', (req, res) => {
    const { id, x, y, z, yaw, desc } = req.body as { id: number; x?: number; y?: number; z?: number; yaw?: number; desc?: string };
    if (id == null) return res.status(400).json({ error: 'id required' });
    const ok = setTagMapEntry(id, {
      x: x ?? 0, y: y ?? 0, z: z ?? 2.8, yaw: yaw ?? 0, desc: desc ?? `tag-${id}`,
    });
    res.json({ ok, tag: getTagMap()[id] ?? null });
  });
  app.delete('/api/tags/:id', (req, res) => {
    const id = parseInt(req.params.id);
    res.json({ ok: deleteTagMapEntry(id) });
  });

  app.post('/api/nav', (req, res) => navApi.handleNav(req, res));
  app.post('/api/stop', (_req, res) => { navApi.stop(); res.json({ ok: true }); });
  app.post('/api/nav-path', (req, res) => navApi.handleNavPath(req, res));

  // Motor manual control
  app.post('/api/motor', (req, res) => {
    const { frame } = req.body as { frame?: string };
    if (!frame?.startsWith('$') || !frame.endsWith('#')) {
      return res.status(400).json({ error: 'invalid frame' });
    }
    console.log(`[motor] sending: ${frame}`);
    navApi.sendMotorFrame(frame);
    res.json({ ok: true, frame });
  });
  // Debug: send raw CMD to ESP32
  app.post('/api/debug/send', (req, res) => {
    const { cmd } = req.body as { cmd?: string };
    if (!cmd) return res.status(400).json({ error: 'cmd required' });
    if (sendToEsp) sendToEsp(cmd + '\r\n');
    console.log(`[debug] sent to ESP: ${cmd}`);
    res.json({ ok: true, cmd });
  });
  // Camera intrinsics config
  const cameraCfgPath = join(__dirname, '..', '..', 'config', 'camera.json');
  const defaults = { fx: 900, fy: 900, cx: 640, cy: 360, tag_size_m: 0.168 };
  app.get('/api/camera', (_req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(cameraCfgPath, 'utf8'))); }
    catch { res.json(defaults); }
  });
  app.post('/api/camera', (req, res) => {
    const cfg = {
      fx: Number(req.body?.fx) || defaults.fx,
      fy: Number(req.body?.fy) || defaults.fy,
      cx: Number(req.body?.cx) || defaults.cx,
      cy: Number(req.body?.cy) || defaults.cy,
      tag_size_m: Number(req.body?.tag_size_m) || defaults.tag_size_m,
    };
    try { fs.writeFileSync(cameraCfgPath, JSON.stringify(cfg, null, 2)); res.json({ ok: true, cfg }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Motion calibration (tag-based)
  app.post('/api/calib/turn', (_req, res) => res.json({ ok: startTurnCalib() }));
  app.post('/api/calib/drive', (_req, res) => res.json({ ok: startDriveCalib() }));
  app.post('/api/calib/cancel', (_req, res) => res.json({ ok: cancelCalib() }));
  app.get('/api/calib/status', (_req, res) => res.json(getCalibStatus()));

  // POI
  app.get('/api/poi', (req, res) => {
    const mapId = (req.query.map_id as string) || 'default';
    res.json(state.pois.filter(p => !mapId || true));
  });
  app.post('/api/poi', (req, res) => poiApi.create(req, res));
  app.delete('/api/poi/:name', (req, res) => poiApi.remove(req, res));

  // Patrol
  app.post('/api/patrol/start', (req, res) => navApi.startPatrol(req, res));
  app.post('/api/patrol/arrive', (_req, res) => navApi.patrolArrive(res));

  // AprilTag-guided navigation
  app.post('/api/tag-nav/start', (req, res) => {
    const { waypoints } = req.body as { waypoints?: any[] };
    if (!waypoints || waypoints.length === 0) {
      return res.status(400).json({ error: 'waypoints array required' });
    }
    res.json(startTagNav(waypoints));
  });
  app.post('/api/tag-nav/cancel', (_req, res) => res.json(cancelTagNav()));
  app.get('/api/tag-nav/status', (_req, res) => res.json(getTagNavStatus()));

  // ── 智能取货 (物流导引) ──────────────────────────────────
  app.get('/api/goods', (req, res) => goodsApi.list(req, res));
  app.get('/api/goods/status', (req, res) => goodsApi.status(req, res));
  app.get('/api/goods/:id', (req, res) => goodsApi.get(req, res));
  app.post('/api/goods', (req, res) => goodsApi.upsert(req, res));
  app.delete('/api/goods/:id', (req, res) => goodsApi.remove(req, res));
  app.post('/api/goods/pick', (req, res) => goodsApi.pick(req, res));
  app.post('/api/goods/cancel', (req, res) => goodsApi.cancel(req, res));

  // 扫码取货确认页 (二维码指向 /pick?goods=<id>)
  app.get('/pick', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'pick.html')));
  app.use(express.static(PUBLIC_DIR));

  // TTS test — text → edge-tts → ESP32 speaker
  app.post('/api/tts', async (req, res) => {
    try {
      const { text, volume } = req.body || {};
      if (!text) return res.status(400).json({ error: 'text required' });
      const vol = (typeof volume === 'number') ? Math.max(0, Math.min(1, volume)) : 1.0;
      const ok = await speak(text, vol);
      const note = !ok ? 'edge-tts 未安装或 TCP 未连接' : (vol < 1.0 ? `音量 ${Math.round(vol * 100)}%` : '');
      res.json({ ok, text, volume: vol, note });
    } catch (e) {
      console.error('[tts] Error:', (e as Error).message);
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // LLM
  app.post('/api/llm/chat', async (req, res) => {
    const { message, session_id } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    try {
      const resp = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:7b',
          messages: [{ role: 'user', content: message }],
          stream: false,
        }),
      });
      const data = await resp.json() as any;
      res.json({ reply: data.message?.content || '(empty)', session_id: session_id || 'default' });
    } catch (e) {
      res.json({ reply: `LLM error: ${(e as Error).message}`, session_id: session_id || 'default' });
    }
  });

  // Event engine
  const events: any[] = [];
  app.get('/api/events', (_req, res) => res.json(events));
  app.post('/api/events', (req, res) => {
    const evt = { id: Date.now().toString(36), ts: new Date().toISOString(), ...req.body };
    events.unshift(evt);
    res.json(evt);
  });

  return { app, httpServer };
}
