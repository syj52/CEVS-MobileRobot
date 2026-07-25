/**
 * apriltagDetector.ts — Manages Python AprilTag detection subprocess
 *
 * Feeds JPEG frames from the VideoProxy to a Python subprocess and
 * broadcasts detection results to the frontend via WebSocket.
 *
 * The Python script (scripts/detect_apriltags.py) must be installed:
 *   pip install opencv-python apriltag numpy
 */
import { spawn, execSync, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { broadcast } from './websocket.js';
import { applyApriltagPose } from './tcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'detect_apriltags.py');

export class ApriltagDetector {
  private proc: ChildProcess | null = null;
  private procReady = false;
  private _camFx = 1800; private _camFy = 1800; private _camCx = 640; private _camCy = 360;
  private _camTagSize = 0.168;

  constructor() {
    try {
      const cfg = JSON.parse(fs.readFileSync(join(__dirname, '..', '..', 'config', 'camera.json'), 'utf8'));
      this._camFx = cfg.fx || 1800; this._camFy = cfg.fy || 1800;
      this._camCx = cfg.cx || 640; this._camCy = cfg.cy || 360;
      this._camTagSize = cfg.tag_size_m || 0.168;
      console.log(`[apriltag] Calibrated: fx=${this._camFx} fy=${this._camFy} tag=${this._camTagSize*1000}mm`);
      if (cfg.dist_coeffs?.length) console.log(`[apriltag] Distortion: ${cfg.dist_coeffs.length} coeffs loaded`);
    } catch { console.log('[apriltag] No camera.json — using defaults'); }
  }
  private pendingFrames: Buffer[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private frameCount = 0;
  private resultCount = 0;
  private _status = '未启动';
  private pythonCmd = '';

  get status() { return this._status; }

  private setStatus(s: string) {
    this._status = s;
    console.log(`[apriltag] ${s}`);
    broadcast({ type: 'apriltag_status', status: s });
  }

  /** Find a working Python command */
  private findPython(): string {
    for (const cmd of ['python', 'python3', 'py']) {
      try {
        const out = execSync(`"${cmd}" --version 2>&1`, { stdio: 'pipe', timeout: 3000 }).toString();
        if (out.toLowerCase().includes('python 3')) {
          console.log(`[apriltag] Found: ${cmd} → ${out.trim()}`);
          return cmd;
        }
      } catch { /* not this one */ }
    }
    return '';
  }

  /** Start Python subprocess */
  start() {
    if (this.proc) { this.setStatus('already running'); return; }

    // 1. Find Python
    this.pythonCmd = this.findPython();
    if (!this.pythonCmd) {
      this.setStatus('❌ 未找到 Python3 — 安装后重启 (python.org)');
      console.log('[apriltag] Then install packages: pip install opencv-python apriltag numpy');
      return;
    }

    // 2. Start Python subprocess
    this.setStatus(`启动中: ${this.pythonCmd} detect_apriltags.py ...`);
    this.proc = spawn(this.pythonCmd, [SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (data: Buffer) => {
      this.busy = false;
      this.frameCount++;
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const result = JSON.parse(line);
          if (result.tags) {
            this.resultCount++;
            const valid = result.tags.filter((t: any) => !t.error);
            // Always broadcast — empty array clears the overlay
            broadcast({ type: 'apriltag', tags: result.tags });

            if (valid.length > 0) {
              this.setStatus(`✅ 检测到 ${valid.length} 个标签: ${valid.map((t: any) => `#${t.id}`).join(', ')}`);
              for (const tag of valid) {
                if (tag.tx !== undefined && tag.tz !== undefined) {
                  try {
                    // Use solvePnP pose directly (calibrated distortion + OpenCV IPPE_SQUARE)
                    applyApriltagPose(tag.id, tag.tx, tag.ty, tag.tz, tag.yaw || 0);
                  } catch (e) {
                    console.log(`[apriltag] fusion error: ${e}`);
                  }
                }
              }
            }
            // Log errors from individual frames
            const errors = result.tags.filter((t: any) => t.error);
            for (const e of errors) {
              console.log(`[apriltag] Frame error: ${e.error}`);
            }
          }
        } catch (e) {
          console.log(`[apriltag] JSON parse error: ${line.substring(0, 100)}`);
        }
      }
    });

    this.proc.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg) return;
      // Python's stderr messages
      console.log(`[apriltag:py] ${msg}`);
      if (msg.includes('ready')) {
        this.procReady = true;
        this.setStatus('✅ Python 检测器就绪，等待帧数据...');
        const pending = [...this.pendingFrames];
        this.pendingFrames = [];
        for (const frame of pending) this.feedFrame(frame);
      }
    });

    this.proc.on('exit', (code) => {
      this.proc = null;
      this.procReady = false;
      this.setStatus(`⚠️ Python 退出(code=${code}) — 检测已禁用`);
    });

    this.proc.on('error', (err) => {
      this.proc = null;
      this.setStatus(`❌ Python 启动失败: ${err.message}`);
      console.log(`[apriltag] Install with: pip install opencv-python apriltag numpy`);
    });

    this.flushTimer = setInterval(() => this.flush(), 5000);
  }

  /** Feed a JPEG frame to the detector (throttled to ~1 fps) */
  feedFrame(jpeg: Buffer) {
    if (!this.proc || !this.procReady || this.busy) {
      if (this.pendingFrames.length < 10) this.pendingFrames.push(jpeg);
      return;
    }

    this.busy = true;
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32LE(jpeg.length);
    this.proc.stdin!.write(Buffer.concat([lengthBuf, jpeg]));
  }

  private flush() {
    if (this.pendingFrames.length > 0 && !this.busy && this.procReady) {
      const frame = this.pendingFrames.shift()!;
      this.feedFrame(frame);
    }
  }

  stop() {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.proc) {
      this.proc.kill('SIGTERM');
      setTimeout(() => this.proc?.kill('SIGKILL'), 2000);
      this.proc = null;
    }
    this.pendingFrames = [];
    this.busy = false;
    this.procReady = false;
    this.setStatus('已停止');
  }
}
