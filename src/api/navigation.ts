import type { Request, Response } from 'express';
import { state } from '../state.js';
import { mqttClient } from '../server/mqtt.js';
import { lastTagPose } from '../server/tcp.js';
import { tagNavExecDone } from './tagNav.js';

/** Callback set by main.ts after TcpServer is created */
let sendToAll: ((msg: string) => void) | null = null;
export function setTcpSend(fn: (msg: string) => void) { sendToAll = fn; }

let patrolPoints: [number, number][] = [];
let patrolIndex = 0;

/* ── Last nav target — used by position correction loop ───────── */
let s_lastNavTarget: { x: number; y: number } | null = null;
let s_lastReaim = 0;

/* ── Angle helpers ──────────────────────────────────────────── */
function normDeg(d: number): number {
  while (d > 180) d -= 360; while (d < -180) d += 360; return d;
}
function deltaDeg(cur: number, tgt: number): number {
  return normDeg(tgt - cur);
}

/** Convert world (cx,cy)@cAngleDeg → target (tx,ty) into !NAV:d,a frame.
 *  Returns '' if distance < 2cm (too close, skip). */
function worldToNavFrame(cx: number, cy: number, cAngleDeg: number, tx: number, ty: number): string {
  const dx = tx - cx, dy = ty - cy;
  const distMm = Math.round(Math.sqrt(dx * dx + dy * dy) * 1000);
  if (distMm < 20) return '';
  const targetDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  const aDeg = Math.round(deltaDeg(cAngleDeg, targetDeg));
  return `!NAV:d=${distMm},a=${aDeg}#`;
}

/** Re-aim toward last target after AprilTag position update.
 *  Uses new STM32 !NAV protocol. Throttled to 1/500ms. */
export function reNavFromTagPose(x: number, y: number, angleDeg: number) {
  if (!s_lastNavTarget) return;
  const now = Date.now();
  if (now - s_lastReaim < 500) return;
  const frame = worldToNavFrame(x, y, angleDeg, s_lastNavTarget.x, s_lastNavTarget.y);
  if (!frame) { s_lastNavTarget = null; state.updateRobot({ status: 'idle' }); return; }
  s_lastReaim = now;
  sendToAll?.(frame + '\r\n');
  state.updateRobot({ status: 'moving' });
  console.log(`[nav] 🔄 Re-aim: (${x.toFixed(2)},${y.toFixed(2)}) → (${s_lastNavTarget.x.toFixed(2)},${s_lastNavTarget.y.toFixed(2)})`);
}

export const navApi = {
  /** Send !NAV to STM32 (IMU turn + encoder drive), computed from world coords */
  sendNav(x: number, y: number) {
    const ca = lastTagPose.angle * 180 / Math.PI;
    const frame = worldToNavFrame(lastTagPose.x, lastTagPose.y, ca, x, y);
    if (!frame) { console.log(`[nav] Already at target`); return; }
    sendToAll?.(frame + '\r\n');
    s_lastNavTarget = { x, y };
    state.updateRobot({ status: 'moving' });
    console.log(`[nav] → (${x.toFixed(2)},${y.toFixed(2)}) ${frame}`);
  },

  navigateTo(x: number, y: number) { this.sendNav(x, y); },

  sendSpin(dir: number) { sendToAll?.(`CMD:SPIN:${dir}\r\n`); },
  sendMotorFrame(frame: string) { sendToAll?.(frame); },
  sendRawCmd(cmd: string) { sendToAll?.(cmd); },

  /** Handle EXEC: responses from STM32/ESP32 */
  handleEspResponse(line: string) {
    if (line.startsWith('EXEC:NAV_DONE')) {
      const consumed = tagNavExecDone();
      if (!consumed) state.updateRobot({ status: 'idle' });
    } else if (line.startsWith('EXEC:NAV_TIMEOUT') || line.startsWith('EXEC:NAV_CANCEL')) {
      state.updateRobot({ status: 'idle' });
    }
    // EXEC:NAV_S → acknowledged, no action needed (status already 'moving')
    // Old EXEC:DONE / EXEC:A → ignored (STM32 no longer sends these)
  },

  handleNav(req: Request, res: Response) {
    const { x, y } = req.body as { x: number; y: number; speed?: number };
    if (x == null || y == null) return res.status(400).json({ error: 'x,y required' });
    this.sendNav(x, y);
    mqttClient.publishNavGoal(x, y);
    res.json({ ok: true });
  },

  stop() {
    sendToAll?.('!NAV:d=0,a=0#\r\n');
    s_lastNavTarget = null;
    patrolPoints = [];
    state.updateRobot({ status: 'idle' });
  },

  handleNavPath(req: Request, res: Response) {
    const { x, y } = req.body as { x: number; y: number };
    if (x == null || y == null) return res.status(400).json({ error: 'x,y required' });
    this.sendNav(Number(x), Number(y));
    res.json({ ok: true });
  },

  startPatrol(req: Request, res: Response) {
    const points = req.body?.points as [number, number][] | undefined;
    if (!points || points.length === 0) return res.status(400).json({ error: 'points required' });
    patrolPoints = points;
    patrolIndex = 0;
    this.sendNav(points[0][0], points[0][1]);
    res.json({ ok: true, session_id: Date.now().toString(36) });
  },

  patrolArrive(res: Response) {
    patrolIndex++;
    if (patrolIndex < patrolPoints.length) {
      this.sendNav(patrolPoints[patrolIndex][0], patrolPoints[patrolIndex][1]);
    } else {
      state.updateRobot({ status: 'idle' });
    }
    res.json({ ok: true, checkpoint: patrolIndex });
  },
};
