import { createServer, Socket } from 'net';
import { state } from '../state.js';
import { navApi, reNavFromTagPose } from '../api/navigation.js';
import { broadcast, broadcastVideoFrame } from './websocket.js';
import { onTagDetected } from '../api/tagNav.js';
import { processVoicePcm } from './voiceService.js';
import { calibTagNotify } from './motionCalib.js';

// ─── Diagnostics: video frame receive counter ──────────────
export const tcpStats = {
  jpegReceived: 0,
  jpegBytes: 0,
  voiceReceived: 0,
};

const LINE_BUF_SZ = 1024;
const MAP_ACK_TIMEOUT = 8000;

// ─── AprilTag positioning (tag based — no odometry, no IMU) ──
// 相机中心相对机器人中心的安装偏移（m）。运行时从 config/camera.json 读取
// (cam_offset_x / cam_offset_y — 由 scripts/calibrate_tags.py 标定写入)。
// 约定（与 calibrate_tags.py 一致）：
//   robot_world = camera_world + Rz(robotYaw) · (CAM_OFFSET_X, CAM_OFFSET_Y)
let CAM_OFFSET_X = 0.0;   // robot frame +x（前）方向的相机偏移
let CAM_OFFSET_Y = 0.0;   // robot frame +y（左）方向的相机偏移

// Tag map: known AprilTag positions in the world (metres)
// Tag IDs → { x, y, yaw (radians), description }
interface TagMapEntry {
  x: number; y: number; yaw: number; desc: string; z: number;
}
const TAG_MAP: Record<number, TagMapEntry> = {
  /* ceiling-mounted at ~2.8m, all facing the same direction (yaw=0) */
  0: { x: -0.30, y:  0.80, yaw: 0, z: 2.8, desc: 'shelf-A' },
  1: { x:  0.30, y:  0.80, yaw: 0, z: 2.8, desc: 'shelf-B' },
  2: { x: -0.30, y: -0.80, yaw: 0, z: 2.8, desc: 'shelf-C' },
  3: { x:  0.30, y: -0.80, yaw: 0, z: 2.8, desc: 'shelf-D' },
  9: { x: 0, y: 0, yaw: 0, z: 2.8, desc: 'origin' },
};

// ── Last tag-derived pose (the ONLY trusted position source) ──
export let lastTagPose = { x: 0, y: 0, angle: 0, ts: 0 };

// ── Raw solvePnP observations (for calibration) ──
export const rawTagObs: Record<number, {tx:number, ty:number, tz:number, yaw:number, ts:number, robotX:number, robotY:number, robotA:number}> = {};

// Fusion state
const TAG_FUSION = {
  lastTagTime: 0,
  smoothFactor: 0.8,    // 响应快速，配合步长钳位抑制振荡
  missingTimeout: 2000, // ms — if no $ATAG for this long, go pure encoder
  hasTag: false,
};

/** 单次 ATAG 观察最大位置变化（m），防止 solvePnP 跳变但允许正常追踪 */
const MAX_POSE_STEP_M = 0.3;

// Multi-frame average buffer for solvePnP noise reduction
const TAG_BUF: Record<number, {tx:number[], ty:number[], tz:number[], yaw:number[]}> = {};
const TAG_BUF_MAX = 5;     // 5帧平均，足够压噪声又响应快

// Debug: stub — odometry disabled, position comes from AprilTags only
export let debugOdom = { delta: [0,0,0,0] as number[], leftDist: 0, rightDist: 0, dHeading: 0, angleDeg: 0 };

// ── Tag map persistence ─────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __tcpdir = path.dirname(fileURLToPath(import.meta.url));
const TAG_FILE = path.join(__tcpdir, '..', '..', 'tags', 'tags.json');
const TRACE_FILE = path.join(__tcpdir, '..', '..', 'data', 'motion_records.jsonl');
try {
  const saved = JSON.parse(fs.readFileSync(TAG_FILE, 'utf8'));
  Object.assign(TAG_MAP, saved);
  console.log(`[atag] Loaded ${Object.keys(saved).length} tags from tags.json`);
} catch { /* first run, use defaults */ }

// ── Camera→robot mount offset from calibration (config/camera.json) ──
// 由 scripts/calibrate_tags.py 求解并写入；缺省则退回 (0,0)（相机=机器人中心）。
const CAMERA_FILE = path.join(__tcpdir, '..', '..', 'config', 'camera.json');
try {
  const cam = JSON.parse(fs.readFileSync(CAMERA_FILE, 'utf8'));
  if (typeof cam.cam_offset_x === 'number') CAM_OFFSET_X = cam.cam_offset_x;
  if (typeof cam.cam_offset_y === 'number') CAM_OFFSET_Y = cam.cam_offset_y;
  console.log(`[atag] Camera mount offset: (${CAM_OFFSET_X.toFixed(3)}, ${CAM_OFFSET_Y.toFixed(3)}) m from camera.json`);
} catch { /* no camera.json — offset stays (0,0) */ }

function saveTags() {
  try { fs.writeFileSync(TAG_FILE, JSON.stringify(TAG_MAP, null, 2)); } catch {}
}

// ── Tag map API exports ────────────────────────────────────
export function getTagMap() { return { ...TAG_MAP }; }
export function setTagMapEntry(id: number, entry: Omit<TagMapEntry, 'z'> & { z?: number }): boolean {
  if (id < 0) return false;
  TAG_MAP[id] = { z: 2.8, ...entry };
  saveTags();
  console.log(`[atag] map entry: id=${id} → (${entry.x},${entry.y}) "${entry.desc}"`);
  return true;
}
export function deleteTagMapEntry(id: number): boolean {
  if (!TAG_MAP[id]) return false;
  delete TAG_MAP[id];
  saveTags();
  console.log(`[atag] map entry deleted: id=${id}`);
  return true;
}
export function getTagFusionStatus() {
  return {
    hasTag: TAG_FUSION.hasTag,
    lastTagTime: TAG_FUSION.lastTagTime,
    age: TAG_FUSION.lastTagTime ? Date.now() - TAG_FUSION.lastTagTime : -1,
  };
}

/** Callback for pushing position to ESP32 (set by main.ts). */
let s_posPush: ((x: number, y: number, aDeg: number) => void) | null = null;
export function setPosPush(fn: (x: number, y: number, aDeg: number) => void) { s_posPush = fn; }
export function pushPosToEsp(x: number, y: number, aDeg: number) { s_posPush?.(x, y, aDeg); }

/**
 * Apply AprilTag observation to the robot position.
 * Called either from the TCP $ATAG handler (ESP32) or from
 * the PC-side ApriltagDetector (Python camera frames).
 *
 * @param id    tag ID from the tag map
 * @param tx    tag x in camera frame (right, metres)
 * @param ty    tag y in camera frame (down, metres)
 * @param tz    tag z in camera frame (forward, metres)
 * @param yawObsDeg  observed yaw of tag relative to camera (degrees)
 */
export function applyApriltagPose(id: number, tx: number, ty: number, tz: number, yawObsDeg: number) {
  if (id < 0 || !TAG_MAP[id]) {
    console.log(`[atag] id=${id} — unknown tag (not in map)`);
    return;
  }

  // Record raw observation for calibration use
  const rp = state.robot.position;
  rawTagObs[id] = { tx, ty, tz, yaw: yawObsDeg, ts: Date.now(), robotX: rp.x, robotY: rp.y, robotA: rp.angle };

  // ── 诊断：记录原始 solvePnP（未平均前） ──
  if (id === 7) {  // 只记录 tag 7 避免刷屏
    console.log(`[ATAG-raw] id=${id} tx=${tx.toFixed(4)} ty=${ty.toFixed(4)} tz=${tz.toFixed(4)} yaw=${yawObsDeg.toFixed(1)}°`);
  }

  // Multi-frame averaging to reduce solvePnP jitter (~4cm → ~1cm)
  if (!TAG_BUF[id]) TAG_BUF[id] = { tx: [], ty: [], tz: [], yaw: [] };
  const buf = TAG_BUF[id];
  buf.tx.push(tx); if (buf.tx.length > TAG_BUF_MAX) buf.tx.shift();
  buf.ty.push(ty); if (buf.ty.length > TAG_BUF_MAX) buf.ty.shift();
  buf.tz.push(tz); if (buf.tz.length > TAG_BUF_MAX) buf.tz.shift();
  buf.yaw.push(yawObsDeg); if (buf.yaw.length > TAG_BUF_MAX) buf.yaw.shift();
  if (buf.tx.length >= 3) {  // 最小3帧开始取平均
    tx = buf.tx.reduce((a, b) => a + b) / buf.tx.length;
    ty = buf.ty.reduce((a, b) => a + b) / buf.ty.length;
    tz = buf.tz.reduce((a, b) => a + b) / buf.tz.length;
    yawObsDeg = buf.yaw.reduce((a, b) => a + b) / buf.yaw.length;
  }

  const entry = TAG_MAP[id];

  // ── 天花板 Z 轴固定：用已知高度重新缩放 tx/ty ──
  // 相机朝上时 solvePnP 的 tz 噪声大，但 tx/ty 与 tz 成比例。
  // 固定为 tag 高度 − 相机高度，消除 tz 噪声传导到位置。
  {
    const camH = 0.2; // 相机离地高度（同 camera.json）
    const expectedTz = entry.z - camH;
    if (tz > 0 && expectedTz > 0) {
      const scale = expectedTz / tz;
      if (0.3 < scale && scale < 3.0) {
        tx *= scale;
        ty *= scale;
        tz = expectedTz;
      }
    }
  }
  const tagWYaw = entry.yaw;
  const obsYawRad = yawObsDeg * Math.PI / 180;

  // ── 机器人/相机世界航向 ψ = tagYaw − obsYaw ────────────────────────
  // 推导：相机朝上、tag 朝下 → tag 帧相对世界含镜像 (det=−1)。展开
  //   R_tag→cam 的水平块可得 obsYaw = tagYaw − ψ ⟹ ψ = tagYaw − obsYaw。
  // 已隐含天花板 180° 翻转，无需再 +π。（航向符号若与实测相反属独立的 #4。）
  let camYaw = tagWYaw - obsYawRad;
  camYaw = camYaw - 2 * Math.PI * Math.floor((camYaw + Math.PI) / (2 * Math.PI));

  // ── #1 相机世界坐标：用 *tag 的固定世界航向* 旋转 tag 帧内的相机位置 ──
  // (tx,ty) = 相机在 tag 坐标系中的位置（Python: −R^T·t）。要转到世界系必须
  // 用 tag 的世界航向 θ 旋转，**不是**相机航向 camYaw —— 否则小车在 tag 正下方
  // 原地自转时 (tx,ty) 不变而 camYaw 变，算得位置会绕 tag 打转，正是“误差大/飘移”主因。
  // 天花板 tag 朝下 → tag 帧含镜像：θ=0 时 tagX→世界+X，tagY→世界−Y，故
  //   e_X(θ)=(cosθ, sinθ),  e_Y(θ)=(sinθ, −cosθ)。
  // 与参考实现 apriltag_test/realtime_track.py 的 tag→world 变换同源。
  const cosT = Math.cos(tagWYaw);
  const sinT = Math.sin(tagWYaw);
  const camX = entry.x + tx * cosT + ty * sinT;
  const camY = entry.y + tx * sinT - ty * cosT;

  // ── #2 相机中心→机器人中心偏移（标定值，见 camera.json / calibrate_tags.py）──
  //   robot = camera + Rz(ψ)·(CAM_OFFSET_X, CAM_OFFSET_Y)
  const cosY = Math.cos(camYaw);
  const sinY = Math.sin(camYaw);
  let robX = camX + CAM_OFFSET_X * cosY - CAM_OFFSET_Y * sinY;
  let robY = camY + CAM_OFFSET_X * sinY + CAM_OFFSET_Y * cosY;

  TAG_FUSION.lastTagTime = Date.now();
  TAG_FUSION.hasTag = true;

  // Current robot position — used both for step clamp + smoothing
  const pos = state.robot.position;

  // ── 步长钳位：防止单帧 solvePnP 跳变 → 大幅振荡 ──
  // 物理约束：小车在两次 ATAG 帧之间不可能移动超过 0.3m。
  // solvePnP 的正面平行歧义会让 tx 在 ±0.4m 间跳变，
  // 钳位后每次只移 0.3m，下一次反方向跳变又从当前位置起步，
  // 振荡被阻断而不会积累到 87cm。
  {
    const dx = robX - pos.x;
    const dy = robY - pos.y;
    const stepDist = Math.hypot(dx, dy);
    if (stepDist > MAX_POSE_STEP_M) {
      const ratio = MAX_POSE_STEP_M / stepDist;
      robX = pos.x + dx * ratio;
      robY = pos.y + dy * ratio;
      console.log(`[ATAG-clamp] step=${stepDist.toFixed(3)}m → ${MAX_POSE_STEP_M}m (ratio=${ratio.toFixed(2)})`);
    }
  }

  // Smooth correction on current encoder position
  // Angle correction uses same alpha as position (no half-reduction)
  // because the camera yaw estimate from a tag is reliable.
  const alpha = TAG_FUSION.smoothFactor;
  const correctedX = pos.x + (robX - pos.x) * alpha;
  const correctedY = pos.y + (robY - pos.y) * alpha;
  const correctedAngle = pos.angle + (camYaw - pos.angle) * alpha;
  state.updateRobot({ position: { x: correctedX, y: correctedY, angle: correctedAngle } });

  // ── Update tag-trusted pose (only authoritative position source) ──
  lastTagPose = { x: correctedX, y: correctedY, angle: correctedAngle, ts: Date.now() };

  // ── Push position to ESP32 for display ──
  s_posPush?.(correctedX, correctedY, correctedAngle * 180 / Math.PI);

  // ── Position correction loop: if navigating, re-aim toward target ──
  reNavFromTagPose(correctedX, correctedY, correctedAngle * 180 / Math.PI);

  // ── Motion calibration hook ──
  calibTagNotify(id, correctedX, correctedY, correctedAngle * 180 / Math.PI);

  console.log(
    `[ATAG] id=${id} pose=(tx=${tx.toFixed(3)},ty=${ty.toFixed(3)},tz=${tz.toFixed(3)})m → ` +
    `cam=(${camX.toFixed(3)},${camY.toFixed(3)}) yaw=${(camYaw*180/Math.PI).toFixed(1)}° ` +
    `robot=(${correctedX.toFixed(3)},${correctedY.toFixed(3)})`
  );

  // Notify tag-guided navigation (if active)
  onTagDetected(id);
}

export class TcpServer {
  private server = createServer();
  private clients = new Set<Socket>();
  private lineBufs = new Map<Socket, { buf: Buffer; len: number }>();
  private pendingAcks = new Map<Socket, { resolve: () => void; reject: (e: Error) => void }>();
  /** JPEG binary frame state: bytes remaining + accumulated chunks */
  private jpegPending = new Map<Socket, { need: number; chunks: Buffer[] }>();
  /** Timeout guards for stuck JPEG reception — prevents permanent "deafness"
   *  when ESP dies mid-frame (Bug 3).  5 s is generous for a 512 KB frame. */
  private jpegTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
  private readonly JPEG_TIMEOUT_MS = 5000;
  /** Per-connection JPEG frame count for disconnect diagnostics */
  private jpegDiag = new Map<Socket, { frames: number }>();
  private voicePending = new Map<Socket, { need: number; chunks: Buffer[] }>();
  public onConnected: ((sock: Socket) => void) | null = null;
  public onDisconnected: (() => void) | null = null;
  /** Called when a JPEG frame arrives from the ESP32 video stream */
  public onJpegFrame: ((jpeg: Buffer) => void) | null = null;

  /** IP address of the last connected ESP32 (used for RTSP URL construction) */
  private _espIp: string | null = null;
  get espIp(): string | null { return this._espIp; }

  constructor(private port: number) {
    this.server.on('connection', (sock) => this.onConnection(sock));
  }

  private onConnection(sock: Socket) {
    const remote = `${sock.remoteAddress}:${sock.remotePort}`;
    const connTs = Date.now();
    const diag = { bytes: 0, frames: 0, lastData: connTs };
    console.log(`[tcp] ESP32 connected: ${remote}`);
    this._espIp = sock.remoteAddress?.replace(/^::ffff:/, '') ?? null;
    sock.setNoDelay(true);  /* disable Nagle — STOP commands must not be delayed */
    this.clients.add(sock);
    state.setTcpConnected(true);
    this.lineBufs.set(sock, { buf: Buffer.alloc(LINE_BUF_SZ), len: 0 });

    sock.on('data', (chunk) => {
      diag.bytes += chunk.length;
      diag.lastData = Date.now();
      this.onData(sock, chunk);
    });
    sock.on('close', () => {
      const uptime = ((Date.now() - connTs) / 1000).toFixed(1);
      const idle = ((Date.now() - diag.lastData) / 1000).toFixed(1);
      const jd = this.jpegDiag.get(sock);
      const jf = jd ? jd.frames : 0;
      console.log(`[tcp] ⚡ ESP32 DISCONNECTED: ${remote} (uptime=${uptime}s, rx=${(diag.bytes/1024).toFixed(0)}KB, jpeg=${jf}, idle=${idle}s)`);
      this.clients.delete(sock);
      this.lineBufs.delete(sock);
      this.pendingAcks.delete(sock);
      this.jpegDiag.delete(sock);
      this.jpegPending.delete(sock);
      const jt = this.jpegTimers.get(sock); if (jt) clearTimeout(jt);
      this.jpegTimers.delete(sock);
      state.setTcpConnected(false);
      this.onDisconnected?.();
    });
    sock.on('error', (err) => {
      console.log(`[tcp] ⚡ SOCKET ERROR: ${remote} — ${err.message}`);
      this.clients.delete(sock);
      this.jpegPending.delete(sock);
      const jt2 = this.jpegTimers.get(sock); if (jt2) clearTimeout(jt2);
      this.jpegTimers.delete(sock);
    });

    this.onConnected?.(sock);
    this.jpegDiag.set(sock, { frames: 0 });
  }

  private onData(sock: Socket, chunk: Buffer) {
    // Phase 1a: Voice PCM binary reception
    const voice = this.voicePending.get(sock);
    if (voice) {
      this.handleBinaryChunk(sock, chunk, voice, this.voicePending, (full) => {
        // Fire-and-forget: do NOT await — keep the TCP read loop draining
        processVoicePcm(full).catch(e => console.error('[voice] error:', e));
      });
      return;
    }

    // Phase 1b: JPEG binary reception
    const jpeg = this.jpegPending.get(sock);
    if (jpeg) {
      this.handleBinaryChunk(sock, chunk, jpeg, this.jpegPending, (full) => {
        // Clear timeout — full frame received cleanly
        const timer = this.jpegTimers.get(sock);
        if (timer) { clearTimeout(timer); this.jpegTimers.delete(sock); }
        tcpStats.jpegReceived++;
        tcpStats.jpegBytes += full.length;
        // Track per-connection frame count for diagnostics on disconnect
        const jd = this.jpegDiag.get(sock);
        if (jd) jd.frames++;
        broadcastVideoFrame(full);
        this.onJpegFrame?.(full);
      });
      return;
    }

    // Phase 2: Normal line-based protocol
    this.processLineData(sock, chunk);
  }

  /** Generic binary chunk accumulator */
  private handleBinaryChunk(
    sock: Socket, chunk: Buffer,
    state: { need: number; chunks: Buffer[] },
    map: Map<Socket, { need: number; chunks: Buffer[] }>,
    onComplete: (data: Buffer) => void,
  ) {
    const need = state.need;
    if (chunk.length >= need) {
      state.chunks.push(chunk.subarray(0, need));
      const full = Buffer.concat(state.chunks);
      map.delete(sock);
      onComplete(full);
      const rest = chunk.subarray(need);
      if (rest.length > 0) this.processLineData(sock, rest);
    } else {
      state.chunks.push(Buffer.from(chunk));
      state.need = need - chunk.length;
    }
  }

  /** Handle line-oriented data (sub-buffer of a TCP chunk) */
  private processLineData(sock: Socket, data: Buffer) {
    const entry = this.lineBufs.get(sock)!;
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      if (byte === 0x0A) {
        const lineLen = entry.len;
        if (lineLen > 0 && entry.buf[lineLen - 1] === 0x0D) entry.buf[lineLen - 1] = 0;
        else entry.buf[lineLen] = 0;
        const line = entry.buf.subarray(0, lineLen).toString('utf8');
        entry.len = 0;
        this.processLine(sock, line.trim());
        // If a $JPEG: or $VOICE: header was just processed, redirect remaining bytes as binary
        if (this.jpegPending.has(sock) || this.voicePending.has(sock)) {
          const rest = data.subarray(i + 1);
          if (rest.length > 0) this.onData(sock, rest);
          return;
        }
      } else {
        if (entry.len < LINE_BUF_SZ - 1) entry.buf[entry.len++] = byte;
        else entry.len = 0;
      }
    }
  }

  private processLine(sock: Socket, line: string) {
    if (!line) return;

    // MAP ACK
    const ack = this.pendingAcks.get(sock);
    if (ack && line.startsWith('ACK:MAP')) {
      ack.resolve(); this.pendingAcks.delete(sock);
      return;
    }

    // ESP32 responses
    if (line.startsWith('EXEC:') || line.startsWith('OK:') || line.startsWith('ERR:')) {
      console.log(`[esp] ${line}`);
      navApi.handleEspResponse(line);
      return;
    }

    // ESP32 manual movement report (distance + angle delta + updated pose)
    if (line.startsWith('$MOVE:')) {
      const d  = parseFloat(line.match(/d=([-\d.]+)/)?.[1] ?? '0');
      const a  = parseFloat(line.match(/a=([-\d.]+)/)?.[1] ?? '0');
      const t  = parseInt(line.match(/t=(\d+)/)?.[1] ?? '0');
      const v  = parseInt(line.match(/v=(\d+)/)?.[1] ?? '0');
      const x  = parseFloat(line.match(/x=([-\d.]+)/)?.[1] ?? '0');
      const y  = parseFloat(line.match(/y=([-\d.]+)/)?.[1] ?? '0');
      const h  = parseFloat(line.match(/h=([-\d.]+)/)?.[1] ?? '0');
      lastTagPose.x = x; lastTagPose.y = y;
      lastTagPose.angle = h * Math.PI / 180; lastTagPose.ts = Date.now();
      state.updateRobot({ position: { x, y, angle: h * Math.PI / 180 } });
      broadcast({ type: 'manual_move', dist_mm: d, yaw_delta: a, elapsed_ms: t, speed_mms: v, position: { x, y, angle: h * Math.PI / 180 } });
      console.log(`[move] ${d.toFixed(0)}mm Δ${a.toFixed(1)}° ${t}ms ${v}mm/s`);
      return;
    }

    // ESP32 trace data ($T,count,enc0,ms0,yaw0,enc1,ms1,yaw1,...)
    if (line.startsWith('$T,')) {
      const parts = line.split(',');
      const n = parseInt(parts[1] ?? '0');
      const pts: {t:number,e:number,y:number}[] = [];
      for (let i = 0; i < n && 2 + i*3 + 2 < parts.length; i++) {
        const e = parseInt(parts[2 + i*3] ?? '0');
        const t = parseInt(parts[3 + i*3] ?? '0');
        const y = parseFloat(parts[4 + i*3] ?? '0');
        pts.push({ t, e, y });
      }
      broadcast({ type: 'motion_trace', n, points: pts });
      try {
        const rec = JSON.stringify({ ts: new Date().toISOString(), n: pts.length, points: pts }) + '\n';
        fs.appendFileSync(TRACE_FILE, rec);
      } catch {}
      return;
    }

    // ESP32 pose estimate (after each move)
    if (line.startsWith('$POSE:')) {
      const x  = parseFloat(line.match(/x=([-\d.]+)/)?.[1] ?? '0');
      const y  = parseFloat(line.match(/y=([-\d.]+)/)?.[1] ?? '0');
      const a  = parseFloat(line.match(/a=([-\d.]+)/)?.[1] ?? '0');
      lastTagPose.x = x; lastTagPose.y = y;
      lastTagPose.angle = a * Math.PI / 180; lastTagPose.ts = Date.now();
      state.updateRobot({ position: { x, y, angle: a * Math.PI / 180 } });
      broadcast({ type: 'state', robot: state.robot });
      console.log(`[pose] ESP estimate: (${x.toFixed(2)},${y.toFixed(2)})@${a.toFixed(1)}°`);
      return;
    }

    // STM32 telemetry frames with odometry + IMU fusion
    if (line.startsWith('$IMU')) {
      // IMU is NOT used (GYRO outputs 0 on this robot).
      // Keep broadcast for frontend diagnostics only.
      broadcast({ type: 'stm32', raw: line });
      return;
    }

    if (line.startsWith('$ODOM')) {
      // ODOM is NOT used for positioning (unreliable encoders).
      // Position comes exclusively from AprilTag detections.
      // Keep broadcast for frontend diagnostics only.
      broadcast({ type: 'stm32', raw: line });
      return;
    }

    if (line.startsWith('$SNSR')) {
      broadcast({ type: 'stm32', raw: line });
      return;
    }

    // ── JPEG / Voice binary frame header ───────────────────
    if (line.startsWith('$JPEG:')) {
      const len = parseInt(line.substring(6));
      if (len > 0 && len < 512 * 1024) {
        // Clear any stale timer before starting a new JPEG reception
        const prev = this.jpegTimers.get(sock);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(() => {
          console.log(`[tcp] JPEG timeout — clearing stuck binary reception (sock ${sock.remoteAddress})`);
          this.jpegPending.delete(sock);
          this.jpegTimers.delete(sock);
        }, this.JPEG_TIMEOUT_MS);
        this.jpegTimers.set(sock, timer);
        this.jpegPending.set(sock, { need: len, chunks: [] });
      }
      return;
    }
    if (line.startsWith('$VOICE:')) {
      const len = parseInt(line.substring(7));
      if (len > 0 && len < 256 * 1024) {  // max 256KB PCM (~8s @ 16kHz)
        this.voicePending.set(sock, { need: len, chunks: [] });
        console.log(`[voice] Incoming PCM ${len}B`);
      }
      return;
    }

    // ── AprilTag positioning ────────────────────────────────
    if (line.startsWith('$ATAG')) {
      const id   = parseFloat(line.match(/id=([-\d]+)/)?.[1] ?? '-1');
      const tx   = parseFloat(line.match(/tx=([-\d.]+)/)?.[1] ?? '0');
      const ty   = parseFloat(line.match(/ty=([-\d.]+)/)?.[1] ?? '0');
      const tz   = parseFloat(line.match(/tz=([-\d.]+)/)?.[1] ?? '0');
      const yawObs = parseFloat(line.match(/yaw=([-\d.]+)/)?.[1] ?? '0');
      applyApriltagPose(id, tx, ty, tz, yawObs);
      return;
    }
  }

  sendToAll(msg: string) {
    const data = msg.endsWith('\r\n') ? msg : msg + '\r\n';
    console.log(`[tcp] broadcast to ${this.clients.size} client(s): ${data.trimEnd()}`);
    for (const sock of this.clients) sock.write(data);
  }

  /** Send raw binary buffer (no \r\n appended) — used for TTS audio */
  sendToAllRaw(buf: Buffer) {
    for (const sock of this.clients) sock.write(buf);
  }

  sendMotorFrame(frame: string) {
    this.sendToAll(frame);
  }

  /** Push current map to all connected ESP32 clients */
  async pushMapToAll() {
    const arr = [...this.clients];
    console.log(`[tcp] Pushing map to ${arr.length} client(s)`);
    for (const sock of arr) {
      try { await this.sendMapTo(sock); } catch { /* skip failed */ }
    }
  }

  async sendMapTo(sock: Socket): Promise<void> {
    const m = state.gridMap;
    if (!m) return;

    const meta = `MAP:W=${m.width},H=${m.height},R=${m.res},OX=${m.ox},OY=${m.oy}\r\n`;
    sock.write(Buffer.from(meta));
    sock.write(Buffer.from(m.data.buffer, m.data.byteOffset, m.width * m.height));
    sock.write(Buffer.from('MAP:END\r\n'));

    const t = setTimeout(() => { this.pendingAcks.delete(sock); sock.destroy(); }, MAP_ACK_TIMEOUT);
    this.pendingAcks.set(sock, { resolve: () => clearTimeout(t), reject: () => clearTimeout(t) });

    return new Promise((resolve, reject) => {
      const existing = this.pendingAcks.get(sock);
      if (existing) {
        const prev = existing.resolve;
        this.pendingAcks.set(sock, {
          resolve: () => { prev(); resolve(); },
          reject: (e) => { existing.reject(e); reject(e); },
        });
      }
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, '0.0.0.0', () => resolve()));
  }
}
