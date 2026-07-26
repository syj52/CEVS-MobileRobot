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
import { debugOdom, getTagMap, setTagMapEntry, deleteTagMapEntry, getTagFusionStatus, lastTagPose, pushPosToEsp, rawTagObs } from './tcp.js';
import { broadcast } from './websocket.js';
import { startTagNav, cancelTagNav, getTagNavStatus } from '../api/tagNav.js';
import { goodsApi, pickDirect } from '../api/goods.js';
import { startTurnCalib, startDriveCalib, cancelCalib, getCalibStatus } from './motionCalib.js';
import { chatCompletion } from './dashscope.js';
import { executeCommand } from './commandExecutor.js';
import { buildKnowledgeContext } from './knowledgeBase.js';
import { startPath } from './pathPlanner.js';

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

  // 固定路径模式: !PATH:<n>#  → STM32 按预设轨迹移动
  app.post('/api/path/:id', (req, res) => {
    startPath(parseInt(req.params.id));
    const n = parseInt(req.params.id);
    console.log(`[path] POST /api/path/${n} called, sendToEsp=${!!sendToEsp}`);
    if (isNaN(n) || n < 0 || n > 6) return res.status(400).json({ error: 'invalid path id (0-6)' });
    if (n >= 1 && n <= 6) startPath(n);
    const cmd = `!PATH:${n}#`;
    if (sendToEsp) {
      sendToEsp(cmd + '\r\n');
      console.log(`[path] → sent: ${cmd}`);
    } else {
      console.error('[path] sendToEsp is null!');
    }
    state.updateRobot({ status: n === 0 ? 'idle' : 'moving' });
    res.json({ ok: true, path: n });
  });

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
  // 🎯 Tag + camera calibration endpoints
  app.get('/api/calib/observations', (_req, res) => res.json(rawTagObs));
  app.delete('/api/calib/observations', (_req, res) => {
    for (const k of Object.keys(rawTagObs)) delete rawTagObs[Number(k)];
    res.json({ ok: true, cleared: true });
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

  // 固定轨迹: 手动触发 STM32 走预定路径
  //   POST /api/trajectory/shelf_a  →  $TRAJ:shelf_a\r\n
  app.post('/api/trajectory/:id', (req, res) => {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'trajectory id required' });
    const cmd = `$TRAJ:${id}\r\n`;
    if (sendToEsp) sendToEsp(cmd);
    console.log(`[traj] → ${cmd.trim()}`);
    res.json({ ok: true, trajectory: id });
  });

  // 扫码取货确认页 (二维码指向 /pick?goods=<id>)
  app.get('/pick', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'pick.html')));
  app.get('/nav', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'nav.html')));
  app.use(express.static(PUBLIC_DIR));

  // QR code generator
  app.get('/api/qr', (req, res) => {
    const text = (req.query.text as string) || 'http://' + req.hostname + ':8000/nav';
  // QR code generator
  app.get('/api/qr', (req, res) => {
    const text = (req.query.text as string) || 'http://' + req.hostname + ':8000/nav';
    const { spawnSync } = require('child_process');
    const script = join(__dirname, '..', 'scripts', 'gen_qr.py');
    const py = spawnSync('python', [script, text]);
    if (py.error || py.status !== 0) return res.status(500).json({ error: 'QR failed' });
    res.setHeader('Content-Type', 'image/png');
    res.send(py.stdout);
  });
  });

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

  // ─── 积极人格系统提示词 ──────────────────────────────────────
  const CHAT_SYSTEM_PROMPT = `你是一个热情友好的仓库物流机器人助手，名字叫"小E"，搭载在 CEVS 移动平台上。

你的性格特点：
- 温暖、积极、有礼貌，喜欢用语气词
- 对用户的每个问题和指令都充满热情地回应
- 即使不理解也会友善地引导用户，不会冷漠地说"不知道"
- 你是仓库里的好帮手，乐于助人
- ⚡ 回复必须简练明快，控制在 20 字以内，说重点

当用户下达操作指令时，请输出以下 JSON 格式（回复和指令都要有）：
{
  "reply": "你对用户的热情回复，说明即将执行的操作",
  "cmd": "pick 或 goto 或 nav 或 stop 或 return 或 path 或 continue",
  "goods": "货物名称（仅当 cmd=pick 时）",
  "target": "地点名称（仅当 cmd=goto 时，提取用户说的点位名，如接待区、充电站）",
  "x": 目标坐标X（仅当 cmd=nav 时）,
  "y": 目标坐标Y（仅当 cmd=nav 时）
  "path_id": 路径编号1-6（仅当 cmd=path 时）
}

当用户只是普通聊天时，输出：
{
  "reply": "你的热情回复",
  "cmd": "none"
}

可识别的指令：
- 取货/去取: cmd=pick，提取货物名称放入 goods
- 去某个地点: cmd=goto，提取地点名称放入 target（如"接待区""充电站""A点"）
- 导航/去某个坐标: cmd=nav，提取坐标放入 x/y
- 停止/停车/刹车: cmd=stop
- 返回/回原点/回来/回程: cmd=return
- 走路径/执行路径: cmd=path
- 继续/返程/继续路径: cmd=continue，提取路径编号放入 path_id（1-6）

注意：只输出一个 JSON 对象，不要多余文字和解释。回复控制在 20 字以内，简练明快。`;

  // LLM — 积极人格 + 指令解析 + TTS 播报
  app.post('/api/llm/chat', async (req, res) => {
    const { message, session_id } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    try {
      // 注入 POI + 知识库信息
      const poiList = state.pois.map(p =>
        `  - ${p.name}${p.description ? ` (${p.description})` : ''}: 坐标(${p.coord_x}, ${p.coord_y})`
      ).join('\n');
      const poiContext = poiList ? `\n当前已知地点列表：\n${poiList}\n` : '';
      const kbContext = buildKnowledgeContext(message);

      const rawContent = await chatCompletion([
        { role: 'system', content: CHAT_SYSTEM_PROMPT + poiContext + kbContext },
        { role: 'user', content: message },
      ]);

      // 解析 JSON 回复
      let displayReply = rawContent;
      let cmd: any = { cmd: 'none' };
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          displayReply = parsed.reply || rawContent.replace(jsonMatch[0], '').trim() || '(收到～) 😊';
          cmd = { cmd: parsed.cmd || 'none', reply: parsed.reply, ...parsed };
        } catch {
          displayReply = rawContent;
        }
      }

      // 执行指令
      const executed = cmd.cmd && cmd.cmd !== 'none' ? executeCommand(cmd, message) : false;

      res.json({ reply: displayReply, cmd, executed, session_id: session_id || 'default' });
    } catch (e) {
      const errMsg = (e as Error).message;
      console.error(`[chat] LLM 请求失败: ${errMsg}`);
      res.json({ reply: `哎呀，遇到点小问题：${errMsg}，再试一次吧～ 🤗`, cmd: { cmd: 'none' }, executed: false, session_id: session_id || 'default' });
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
