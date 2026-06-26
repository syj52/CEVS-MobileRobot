import type { RobotState } from './types.js';

export type DispatchFn = (state: RobotState, line: string) => string | null;
export type NavSender = (x: number, y: number, speed?: number) => void;

interface KVParsed { [key: string]: string; }

function parseKV(raw: string): KVParsed {
  const result: KVParsed = {};
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) result[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return result;
}

function kvFloat(kv: KVParsed, key: string, fb: number): number {
  const v = kv[key];
  if (v === undefined) return fb;
  const f = parseFloat(v);
  return isNaN(f) ? fb : f;
}

/**
 * Creates a dispatch function.
 *
 * If a pathQueue is provided, EXEC:A will consume the next waypoint
 * instead of setting status to idle.
 * navSender is the function to call to actually send a CMD:NAV to ESP.
 */
export function createDispatcher(
  onNavStart: (x: number, y: number, speed?: number) => void,
  onStop: () => void,
  pathQueue?: { pending: [number, number][]; sendNext: () => void },
  navSender?: NavSender,
): DispatchFn {
  return (robot, line) => {
    const trimmed = line.trim();

    if (trimmed === 'ACK:MAP') {
      console.log('[ctrl] ESP32: ACK:MAP received');
      return null;
    }

    // EXEC: / OK: / ERR:  responses from ESP
    if (trimmed.startsWith('OK:') || trimmed.startsWith('ERR:') || trimmed.startsWith('EXEC:')) {
      console.log(`[ctrl] ESP32: ${trimmed}`);

      // EXEC:A = arrived at waypoint
      if (trimmed.startsWith('EXEC:A')) {
        const pq = pathQueue?.pending;
        if (pq && pq.length > 0) {
          // More waypoints — send next
          pathQueue!.sendNext();
        } else {
          robot.status = 'idle';
          robot.lastUpdate = Date.now();
          console.log('[ctrl] Path complete');
        }
      }

      return null;
    }

    // Commands from Center -> ESP
    if (!trimmed.startsWith('CMD:')) return 'ERR:EXPECTED_CMD\r\n';

    const payload = trimmed.slice(4);

    if (payload === 'PING') return 'OK:PING\r\n';

    if (payload.startsWith('NAV:')) {
      const kv = parseKV(payload.slice(4));
      const x = kvFloat(kv, 'x', NaN);
      const y = kvFloat(kv, 'y', NaN);
      if (isNaN(x) || isNaN(y)) return 'ERR:INVALID_NAV\r\n';
      const speed = kvFloat(kv, 'speed', 1.0);
      robot.status = 'moving';
      robot.position = { x, y };
      robot.lastUpdate = Date.now();
      onNavStart(x, y, speed);
      return 'EXEC:S\r\n';
    }

    if (payload === 'STOP') {
      robot.status = 'idle';
      robot.lastUpdate = Date.now();
      onStop();
      return 'EXEC:S\r\n';
    }

    return 'ERR:UNKNOWN_CMD\r\n';
  };
}
