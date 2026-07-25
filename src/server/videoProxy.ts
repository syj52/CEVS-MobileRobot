/**
 * videoProxy.ts — RTSP-to-JPEG frame grabber
 *
 * Spawns ffmpeg to capture the RTSP stream and pipe individual JPEG
 * frames to a handler callback.  The frontend receives these frames
 * over WebSocket for display and AprilTag detection.
 *
 * Prerequisite: ffmpeg must be installed on the server machine
 *   winget install ffmpeg / apt install ffmpeg / brew install ffmpeg
 */
import { spawn, execSync, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { broadcast } from './websocket.js';

// ─── JPEG frame detection ──────────────────────────────────
const SOI = Buffer.from([0xFF, 0xD8]);
const EOI = Buffer.from([0xFF, 0xD9]);

// ─── Common RTSP paths the ESP32 media server might use ──
const RTSP_PATHS = ['/', '/live', '/stream', '/video', '/h264'];

export interface VideoStats {
  fps: number;
  bitrateKbps: number;
  frameCount: number;
  upTimeMs: number;
  connected: boolean;
  status: string;
}

export class VideoProxy {
  private ffmpeg: ChildProcess | null = null;
  private frameBuffer = Buffer.alloc(0);
  private frameCount = 0;
  private byteCount = 0;
  private startTime = 0;
  private espIp: string;
  private rtspPort: number;
  private ffmpegPath: string;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  private onFrameCb: ((jpeg: Buffer) => void) | null = null;
  private onStatsCb: ((stats: VideoStats) => void) | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private currentUrl = '';
  private pathIndex = 0;
  private _status = '初始中...';
  // Sliding window stats: sample counters every 2s then reset
  private windowFrameCount = 0;
  private windowByteCount = 0;

  constructor(espIp: string, rtspPort = 8554, ffmpegPath = 'ffmpeg') {
    this.espIp = espIp;
    this.rtspPort = rtspPort;
    this.ffmpegPath = ffmpegPath;
  }

  get status() { return this._status; }

  private setStatus(s: string) {
    this._status = s;
    console.log(`[video] ${s}`);
    this.broadcastStatus();
  }

  private broadcastStatus() {
    broadcast({
      type: 'video_stats',
      stats: {
        fps: 0, bitrateKbps: 0, frameCount: this.frameCount,
        upTimeMs: Date.now() - this.startTime,
        connected: this.ffmpeg !== null,
        status: this._status,
      },
    });
  }

  setHandler(onFrame: (jpeg: Buffer) => void, onStats: (stats: VideoStats) => void) {
    this.onFrameCb = onFrame;
    this.onStatsCb = onStats;
  }

  /** Verify ffmpeg is installed and usable */
  checkFfmpeg(): boolean {
    try {
      execSync(`"${this.ffmpegPath}" -version`, { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Start capturing from RTSP */
  start() {
    this.stop();

    // 1. Check ffmpeg
    if (!this.checkFfmpeg()) {
      this.setStatus(`❌ 未找到 ffmpeg (${this.ffmpegPath}) — 请安装`);
      // Keep broadcasting so frontend knows
      this.broadcastStatus();
      setTimeout(() => this.broadcastStatus(), 5000);
      return;
    }

    this.setStatus(`检测到 ffmpeg, 连接 ${this.espIp}:${this.rtspPort} ...`);
    this.startTime = Date.now();
    this.frameCount = 0;
    this.byteCount = 0;
    this.pathIndex = 0;

    // Try first path
    this.tryNextPath();
  }

  /** Try the next RTSP path in the list */
  private tryNextPath() {
    if (this.ffmpeg) return;  // already running

    if (this.pathIndex >= RTSP_PATHS.length) {
      this.setStatus(`❌ 所有 RTSP 路径都失败，每 10s 重试`);
      this.restTimer = setTimeout(() => { this.pathIndex = 0; this.tryNextPath(); }, 10000);
      return;
    }

    const path = RTSP_PATHS[this.pathIndex];
    this.currentUrl = `rtsp://${this.espIp}:${this.rtspPort}${path}`;
    this.setStatus(`尝试连接: ${this.currentUrl}`);

    this.ffmpeg = spawn(this.ffmpegPath, [
      '-rtsp_transport', 'tcp',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-avioflags', 'direct',
      '-max_delay', '0',
      '-analyzeduration', '10000',
      '-probesize', '50000',
      '-i', this.currentUrl,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '3',
      '-vsync', 'drop',
      '-s', '640x360',
      '-an',
      'pipe:1',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.ffmpeg.stdout!.on('data', (chunk: Buffer) => {
      try { this.onStdout(chunk); } catch (e) {
        console.error('[video] stdout handler error:', e);
      }
    });

    let stderrBuf = '';
    let connected = false;
    this.ffmpeg.stderr!.on('data', (chunk: Buffer) => {
      try {
        stderrBuf += chunk.toString();
        if (!connected && (stderrBuf.includes('Stream mapping:') || stderrBuf.includes('Output #0'))) {
          connected = true;
          this.setStatus(`✅ 已连接: ${this.currentUrl}`);
        }
      } catch { /* ignore stderr parse errors */ }
    });

    this.ffmpeg.on('exit', (code, signal) => {
      this.ffmpeg = null;
      if (this.restTimer) clearTimeout(this.restTimer);
      // Log stderr tail to see WHY ffmpeg exited
      const stderrLines = stderrBuf.split('\n').filter(l => l.trim()).slice(-5).join(' | ');
      const reason = code !== null ? `退出(code=${code})` : `信号(${signal})`;
      console.log(`[video] ffmpeg ${reason} (存活 ${(Date.now()-this.startTime)/1000}s)`);
      if (stderrLines) console.log(`[video] ffmpeg stderr尾: ${stderrLines}`);
      this.setStatus(`ffmpeg ${reason}，3s后重试`);
      this.restTimer = setTimeout(() => this.tryNextPath(), 3000);
    });

    this.ffmpeg.on('error', (err) => {
      this.ffmpeg = null;
      if (this.restTimer) clearTimeout(this.restTimer);
      this.setStatus(`❌ ffmpeg 错误: ${err.message}，5s后重试`);
      this.restTimer = setTimeout(() => this.tryNextPath(), 5000);
    });

    // Stats every 2 seconds
    this.statsInterval = setInterval(() => this._broadcastStats(), 2000);
  }

  /** Stop ffmpeg */
  stop() {
    if (this.restTimer) { clearTimeout(this.restTimer); this.restTimer = null; }
    if (this.statsInterval) { clearInterval(this.statsInterval); this.statsInterval = null; }
    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }
    this.frameBuffer = Buffer.alloc(0);
  }

  /** Parse concatenated JPEGs from ffmpeg stdout */
  private onStdout(chunk: Buffer) {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    this.byteCount += chunk.length;

    while (true) {
      const soiIdx = this.frameBuffer.indexOf(SOI);
      if (soiIdx < 0) break;

      const tail = this.frameBuffer.subarray(soiIdx + 2);
      const eoiIdx = tail.indexOf(EOI);
      if (eoiIdx < 0) break;

      const jpegEnd = soiIdx + 2 + eoiIdx + 2;
      const jpeg = this.frameBuffer.subarray(soiIdx, jpegEnd);
      this.frameBuffer = this.frameBuffer.subarray(jpegEnd);

      this.frameCount++;
      this.windowFrameCount++;
      this.windowByteCount += jpeg.length;
      try { this.onFrameCb?.(Buffer.from(jpeg)); } catch (e) {
        console.error('[video] frame callback error:', e);
      }
    }

    if (this.frameBuffer.length > 10 * 1024 * 1024) {
      this.frameBuffer = Buffer.alloc(0);
    }
  }

  private _broadcastStats() {
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    if (elapsed < 1) return;

    // Use sliding window (last 2s) for FPS and bitrate
    const stats: VideoStats = {
      fps: this.windowFrameCount / 2,  // /2 because interval is 2s
      bitrateKbps: Math.round(this.windowByteCount * 8 / 2 / 1024),
      frameCount: this.frameCount,
      upTimeMs: now - this.startTime,
      connected: this.ffmpeg !== null && this.frameCount > 0,
      status: this._status,
    };
    // Reset window counters for next 2s interval
    this.windowFrameCount = 0;
    this.windowByteCount = 0;

    this.onStatsCb?.(stats);
    broadcast({ type: 'video_stats', stats });
  }
}
