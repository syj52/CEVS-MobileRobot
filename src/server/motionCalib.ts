/**
 * motionCalib.ts — Tag-based motion calibration
 *
 * Uses consecutive AprilTag detections to measure actual robot
 * movement, then computes the open-loop timing parameters
 * (ms/degree and ms/mm at speed=5) needed by ESP32's motion.c.
 *
 * Two independent modes (only one active at a time):
 *   POST /api/calib/turn/start   — spin in place, measure angular velocity
 *   POST /api/calib/drive/start  — drive forward, measure linear velocity
 *
 * Flow for each mode:
 *   1. Wait for next tag detection → anchor start pose + timestamp
 *   2. Send motor command (spin or forward) for CALIB_DURATION_MS
 *   3. Wait for tag re-detection → anchor end pose
 *   4. Compute speed, return result
 */
import { state } from '../state.js';
import { broadcast } from './websocket.js';

// ─── Exported calibration results ───────────────────────────────
export const calibResult = {
  turnMsPerDeg: 0,        // calibrated ms per degree at speed=5
  driveMsPerMm: 0,        // calibrated ms per mm at speed=5
  turnDegPerSec: 0,       // calculated angular speed
  driveMmPerSec: 0,       // calculated linear speed
  turnCount: 0,           // how many times turn has been calibrated
  driveCount: 0,          // how many times drive has been calibrated
};

// ─── Config ─────────────────────────────────────────────────────
const CALIB_DURATION_MS = 2000;   // spin / drive for 2 seconds
const MOTOR_SPEED = 5;            // fixed speed for calibration

// ─── Callback for sending motor frames (injected by main.ts) ────
let sendMotor: ((frame: string) => void) | null = null;
export function setCalibMotorSender(fn: (frame: string) => void) {
  sendMotor = fn;
}

// ─── Tag detection hook (called from applyApriltagPose in tcp.ts) ──
type TagHook = (tagId: number, robX: number, robY: number, robYawDeg: number) => void;
const tagHooks = new Set<TagHook>();
export function onCalibTag(fn: TagHook) {
  tagHooks.add(fn);
}

// ─── State machine ───────────────────────────────────────────────
type CalibState =
  | { phase: 'idle' }
  | { phase: 'waiting_first_tag'; mode: 'turn' | 'drive' }
  | { phase: 'spinning'; startYawDeg: number; startMs: number; timer: ReturnType<typeof setTimeout> }
  | { phase: 'driving';  startX: number; startY: number; startMs: number; timer: ReturnType<typeof setTimeout> }
  | { phase: 'waiting_end_tag'; mode: 'turn'; startYawDeg: number; startMs: number }
  | { phase: 'waiting_end_tag'; mode: 'drive'; startX: number; startY: number; startMs: number };

let s: CalibState = { phase: 'idle' };

function stopMotor() {
  if (sendMotor) sendMotor('$0,0,0,0,0,0,0,0,0,0#');
}

function status(msg: string) {
  console.log(`[calib] ${msg}`);
  broadcast({ type: 'calib_status', message: msg, state: s.phase });
}

// ─── Core: called from applyApriltagPose (tcp.ts) ─────────────────
export function calibTagNotify(tagId: number, robX: number, robY: number, robYawDeg: number) {
  // Also notify external hooks
  for (const fn of tagHooks) fn(tagId, robX, robY, robYawDeg);

  if (s.phase === 'idle') return;

  if (s.phase === 'waiting_first_tag') {
    status(`🎯 首次标签检测 #${tagId} @ (${robX.toFixed(2)},${robY.toFixed(2)}) yaw=${robYawDeg.toFixed(1)}°`);

    if (s.mode === 'turn') {
      status('🔄 开始旋转...');
      if (sendMotor) sendMotor('$3,0,0,0,0,0,5,0,0,0#');  // spin CW (dir=3)
      const timer = setTimeout(() => {
        stopMotor();
        status('⏹ 旋转停止 — 等待标签重新检测...');
        s = { phase: 'waiting_end_tag', mode: 'turn', startYawDeg: robYawDeg, startMs: Date.now() };
      }, CALIB_DURATION_MS);
      s = { phase: 'spinning', startYawDeg: robYawDeg, startMs: Date.now(), timer };
    } else {
      status('🚀 开始前进...');
      if (sendMotor) sendMotor('$1,0,0,0,0,0,5,0,0,0#');  // forward (dir=1)
      const timer = setTimeout(() => {
        stopMotor();
        status('⏹ 前进停止 — 等待标签重新检测...');
        s = { phase: 'waiting_end_tag', mode: 'drive', startX: robX, startY: robY, startMs: Date.now() };
      }, CALIB_DURATION_MS);
      s = { phase: 'driving', startX: robX, startY: robY, startMs: Date.now(), timer };
    }
    return;
  }

  if (s.phase === 'waiting_end_tag') {
    const elapsedSec = (Date.now() - s.startMs) / 1000;

    if (s.mode === 'turn') {
      const deltaDeg = Math.abs(robYawDeg - s.startYawDeg);
      if (deltaDeg < 3) {
        status(`⚠ 旋转角度太小 (${deltaDeg.toFixed(1)}°) — 忽略，等待更大变化`);
        return;
      }
      const degPerSec = deltaDeg / elapsedSec;
      const msPerDeg = 1000 / degPerSec;

      calibResult.turnDegPerSec = degPerSec;
      calibResult.turnMsPerDeg = msPerDeg;
      calibResult.turnCount++;

      status(`✅ 旋转校准完成: ${deltaDeg.toFixed(1)}° / ${elapsedSec.toFixed(1)}s = ${degPerSec.toFixed(1)}°/s → ${msPerDeg.toFixed(1)}ms/°`);

    } else {
      const dx = robX - s.startX;
      const dy = robY - s.startY;
      const distMm = Math.sqrt(dx * dx + dy * dy) * 1000;
      if (distMm < 30) {
        status(`⚠ 移动距离太小 (${distMm.toFixed(0)}mm) — 忽略，等待更大变化`);
        return;
      }
      const mmPerSec = distMm / elapsedSec;
      const msPerMm = 1000 / mmPerSec;

      calibResult.driveMmPerSec = mmPerSec;
      calibResult.driveMsPerMm = msPerMm;
      calibResult.driveCount++;

      status(`✅ 前进校准完成: ${distMm.toFixed(0)}mm / ${elapsedSec.toFixed(1)}s = ${mmPerSec.toFixed(0)}mm/s → ${msPerMm.toFixed(2)}ms/mm`);
    }

    broadcast({ type: 'calib_result', result: calibResult });
    s = { phase: 'idle' };
    return;
  }
}

// ─── Public API ──────────────────────────────────────────────────

export function startTurnCalib(): string {
  if (s.phase !== 'idle') return `busy: ${s.phase}`;
  s = { phase: 'waiting_first_tag', mode: 'turn' };
  status('📐 旋转校准启动 — 等待第一个标签...（机器人请放在标签可见位置）');
  return 'ok';
}

export function startDriveCalib(): string {
  if (s.phase !== 'idle') return `busy: ${s.phase}`;
  s = { phase: 'waiting_first_tag', mode: 'drive' };
  status('📏 前进校准启动 — 等待第一个标签...（机器人前方请留出约1米空间）');
  return 'ok';
}

export function cancelCalib(): string {
  if (s.phase === 'spinning' || s.phase === 'driving') {
    const timer = (s as any).timer;
    if (timer) clearTimeout(timer);
    stopMotor();
  }
  s = { phase: 'idle' };
  status('❌ 校准已取消');
  return 'ok';
}

export function getCalibStatus() {
  return { phase: s.phase, result: calibResult };
}
