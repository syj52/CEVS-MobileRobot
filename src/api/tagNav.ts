/**
 * tagNav.ts — Tag-only navigation with spin-search on timeout.
 *
 * Every waypoint is an AprilTag ID.  The robot:
 *   1. Computes heading + distance toward the tag's world position
 *   2. Sends CMD:NAV (open-loop turn + drive)
 *   3. Waits for tag detection (onTagDetected)
 *   4. If not seen within 3s → CMD:SPIN to search
 *   5. On tag detection → advance to next waypoint
 *
 * Waypoints are tag IDs only.  Coordinate targets are removed —
 * every destination has an AprilTag on it.
 */
import { state } from '../state.js';
import { navApi } from './navigation.js';
import { getTagMap } from '../server/tcp.js';

export interface TagWaypoint { tag?: number; x?: number; y?: number; }

interface Session {
  waypoints: TagWaypoint[];
  index: number;
  startedAt: number;
  active: boolean;
  spinTimeout: ReturnType<typeof setTimeout> | null;
  searchTimer: ReturnType<typeof setInterval> | null;
  waitingExecDone: boolean;  /* coordinate waypoint — advance on EXEC:DONE */
}

let session: Session | null = null;
const TAG_SEARCH_TIMEOUT_MS = 3000;

function stopSpin() {
  if (session?.spinTimeout) { clearTimeout(session.spinTimeout); session.spinTimeout = null; }
  if (session?.searchTimer) { clearInterval(session.searchTimer); session.searchTimer = null; }
  if (session) session.waitingExecDone = false;
  navApi.stop();
}

function startSpinSearch() {
  if (!session || !session.active) return;
  console.log('[tagNav] 🔄 No tag seen — spin searching...');
  navApi.sendSpin(3);  // CCW spin

  // Periodically make small forward pushes to expand search area
  session.searchTimer = setInterval(() => {
    if (!session || !session.active) return;
    console.log('[tagNav] 🔄 Still searching...');
  }, 3000);
}

export function startTagNav(waypoints: TagWaypoint[]) {
  if (waypoints.length === 0) return { error: 'empty path' };
  cancelTagNav();  // kill previous session first

  session = {
    waypoints,
    index: 0,
    startedAt: Date.now(),
    active: true,
    spinTimeout: null,
    searchTimer: null,
    waitingExecDone: false,
  };
  console.log(`[tagNav] Started: ${waypoints.length} tags: ${waypoints.map(w => `#${w.tag}`).join(' → ')}`);
  executeCurrentStep();
  return { ok: true, waypoints: waypoints.length };
}

export function cancelTagNav() {
  stopSpin();
  if (session) {
    navApi.stop();
    session = null;
  }
  return { ok: true };
}

/** Called on EXEC:DONE from ESP — advances coordinate waypoints that have no tag ID.
 *  Returns true if tagNav consumed this EXEC:DONE, false otherwise. */
export function tagNavExecDone(): boolean {
  if (!session || !session.active || !session.waitingExecDone) return false;
  const wp = session.waypoints[session.index];
  if (!wp) return false;

  // Only advance coordinate waypoints (no tag ID)
  if (wp.x !== undefined && wp.y !== undefined && wp.tag === undefined) {
    stopSpin();
    console.log(`[tagNav] ✅ (${wp.x.toFixed(2)},${wp.y.toFixed(2)}) — arrived, advancing`);
    advanceToNext();
    return true;
  }
  return false;
}

export function getTagNavStatus() {
  if (!session) return { active: false };
  return { active: session.active, index: session.index, total: session.waypoints.length };
}

/** Called when ANY tag is detected — fires every time. */
export function onTagDetected(tagId: number) {
  if (!session || !session.active) return;

  const wp = session.waypoints[session.index];
  if (!wp) return;

  if (wp.tag !== undefined && wp.tag === tagId) {
    stopSpin();
    console.log(`[tagNav] ✅ Tag#${tagId} — advancing`);
    advanceToNext();
  }
}

function advanceToNext() {
  if (!session) return;
  session.index++;
  if (session.index >= session.waypoints.length) {
    console.log('[tagNav] 🏁 Path complete');
    session.active = false;
    navApi.stop();
    state.updateRobot({ status: 'idle' });
    return;
  }
  executeCurrentStep();
}

function executeCurrentStep() {
  if (!session || !session.active) return;
  const wp = session.waypoints[session.index];

  // Resolve target position
  let tx: number, ty: number, tagId: number | undefined;
  if (wp.tag !== undefined) {
    const entry = getTagMap()[wp.tag];
    if (!entry) {
      console.log(`[tagNav] ❌ Tag#${wp.tag} not in map`);
      advanceToNext();
      return;
    }
    tx = entry.x; ty = entry.y; tagId = wp.tag;
  } else if (wp.x !== undefined && wp.y !== undefined) {
    tx = wp.x; ty = wp.y; tagId = undefined;
  } else {
    console.log('[tagNav] ❌ Invalid waypoint');
    advanceToNext();
    return;
  }

  const pos = state.robot.position;
  const dx = tx - pos.x, dy = ty - pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 0.03) {
    console.log(`[tagNav] Already at target`);
    advanceToNext();
    return;
  }

  const label = tagId !== undefined ? `Tag#${tagId}` : `(${tx},${ty})`;
  console.log(`[tagNav] → ${label} dist=${dist.toFixed(2)}m`);
  navApi.navigateTo(tx, ty);

  if (tagId !== undefined) {
    // Tag waypoint: spin-search if not seen within 3s
    session.waitingExecDone = false;
    session.spinTimeout = setTimeout(() => startSpinSearch(), TAG_SEARCH_TIMEOUT_MS);
  } else {
    // Coordinate waypoint: advance on EXEC:DONE
    session.waitingExecDone = true;
  }
}
