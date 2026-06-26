import express, { Request, Response } from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { RobotState, PoiRecord, GridMap } from './types.js';
import { astar } from './astar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class HttpServer {
  private app = express();
  private robot: RobotState;
  private port: number;

  constructor(port: number, robot: RobotState) {
    this.port = port;
    this.robot = robot;
    this.app.use(express.json());
    this.app.use(express.static(join(__dirname, '..', 'src')));

    this.app.get('/', (_req, res) => {
      res.sendFile(join(__dirname, '..', 'src', 'test.html'));
    });

    this.app.get('/api/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));
    this.app.get('/api/robot', (_req, res) => {
      const data = { ...this.robot, tcp_connected: this._tcpConnected() };
      res.json(data);
    });

    // Map metadata
    this.app.get('/api/map', (_req, res) => {
      const m = this.robot.gridMap;
      if (!m) return res.status(404).json({ error: 'no map' });
      res.json({ width: m.width, height: m.height, res: m.res, ox: m.ox, oy: m.oy });
    });

    // Map pixel data — binary; 254=free 0=occupied
    this.app.get('/api/map/data', (_req, res) => {
      const m = this.robot.gridMap;
      if (!m || !m.data) return res.status(404).json({ error: 'no map data' });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Map-Width', String(m.width));
      res.setHeader('X-Map-Height', String(m.height));
      res.send(Buffer.from(m.data.buffer, m.data.byteOffset, m.width * m.height));
    });

    this.app.post('/api/nav', (req, res) => {
      const { x, y, speed } = req.body as { x: number; y: number; speed?: number };
      if (x == null || y == null) return res.status(400).json({ error: 'x and y required' });
      const cmd = speed != null ? `CMD:NAV:x=${x},y=${y},speed=${speed}\r\n` : `CMD:NAV:x=${x},y=${y}\r\n`;
      this.robot.status = 'moving';
      this.robot.lastUpdate = Date.now();
      if (this.onCommand) this.onCommand(cmd);
      res.json({ ok: true, cmd: cmd.trim() });
    });

    this.app.post('/api/stop', (_req, res) => {
      this.robot.status = 'idle';
      this.robot.lastUpdate = Date.now();
      if (this.onCommand) this.onCommand('CMD:STOP\r\n');
      res.json({ ok: true });
    });

    this.app.get('/api/poi', (req, res) => {
      const mapId = (req.query['map_id'] as string) || 'default';
      res.json(this.pois.filter((p) => p.map_id === mapId));
    });

    this.app.post('/api/poi', (req, res) => {
      const poi = req.body as Omit<PoiRecord, never>;
      if (!poi.name) return res.status(400).json({ error: 'name required' });
      const idx = this.pois.findIndex((p) => p.name === poi.name);
      if (idx >= 0) this.pois[idx] = { ...this.pois[idx], ...poi };
      else this.pois.push(poi as PoiRecord);
      res.json(poi);
    });

    this.app.delete('/api/poi/:name', (req, res) => {
      const idx = this.pois.findIndex((p) => p.name === req.params['name']);
      if (idx < 0) return res.status(404).json({ error: 'not found' });
      this.pois.splice(idx, 1);
      res.json({ ok: true });
    });

    // A* path navigation: click point on map -> compute path -> send waypoints
    this.app.post('/api/nav-path', (req, res) => {
      const { x, y, speed } = req.body as { x: number; y: number; speed?: number };
      if (x == null || y == null) return res.status(400).json({ error: 'x and y required' });
      if (!this.onNavPath) return res.status(503).json({ error: 'navigator not ready' });
      const result = this.onNavPath(x, y, speed);
      if (!result.ok) return res.status(400).json({ error: 'no path found' });
      this.currentPath = result.waypoints;
      res.json({ ok: true, waypoints: result.waypoints });
    });

    // Get the current path (for map rendering)
    this.app.get('/api/path', (_req, res) => {
      if (!this.currentPath || this.currentPath.length === 0) return res.json({ waypoints: [] });
      res.json({ waypoints: this.currentPath });
    });

    this.app.post('/api/path-cancel', (_req, res) => {
      this.currentPath = null;
      if (this.onCommand) this.onCommand('CMD:STOP\r\n');
      res.json({ ok: true });
    });
  }

  setTcpConnected(fn: () => boolean) { this._tcpConnected = fn; }
  private _tcpConnected: () => boolean = () => false;

  onNavPath: ((x: number, y: number, s?: number) => { waypoints: number[][]; ok: boolean }) | null = null;
  onCommand: ((cmd: string) => void) | null = null;
  currentPath: number[][] | null = null;
  pois: PoiRecord[] = [
    { name: 'start', coord_x: 0, coord_y: 0, coord_z: 0, map_id: 'default', description: '起始点' },
    { name: 'point_a', coord_x: 5, coord_y: 0, coord_z: 0, map_id: 'default', description: 'A点' },
    { name: 'point_b', coord_x: 5, coord_y: 5, coord_z: 0, map_id: 'default', description: 'B点' },
  ];

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(this.port, () => resolve());
    });
  }
}
