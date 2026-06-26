import { createRobotState } from './state.js';
import { TcpServer } from './tcp_server.js';
import { HttpServer } from './http_server.js';
import { createDispatcher } from './dispatcher.js';
import { astar } from './astar.js';
import type { GridMap } from './types.js';

const TCP_PORT = 5000;
const HTTP_PORT = 8000;

const robot = createRobotState();

/* ─── Path queue ─── */
const pathQueue: { pending: [number, number][]; sendNext: () => void } = {
  pending: [],
  sendNext: () => {
    const wp = pathQueue.pending.shift();
    if (wp) {
      const [x, y] = wp;
      console.log(`[path] → (${x.toFixed(2)}, ${y.toFixed(2)})  (${pathQueue.pending.length} remaining)`);
      robot.status = 'moving';
      robot.position = { x, y };
      robot.lastUpdate = Date.now();
      tcp.sendToAll(`CMD:NAV:x=${x},y=${y}\r\n`);
    } else {
      robot.status = 'idle';
      robot.lastUpdate = Date.now();
      console.log('[path] complete');
    }
  },
};

/* ─── Dispatcher ─── */
const dispatcher = createDispatcher(
  (x, y, speed) => {
    console.log(`[ctrl] single NAV → (${x}, ${y}) speed=${speed}`);
  },
  () => {
    console.log('[ctrl] STOP');
    pathQueue.pending = [];
  },
  pathQueue,   // pass queue — dispatcher will call sendNext on EXEC:A
  (x, y) => {}, // navSender (not needed, we use tcp.sendToAll directly)
);

let tcp: TcpServer;

/* ─── A* path starting function ─── */
function startNavPath(goalX: number, goalY: number): { waypoints: [number, number][]; ok: boolean } {
  const gm = robot.gridMap;
  if (!gm) { console.warn('[path] no map'); return { waypoints: [], ok: false }; }

  const rx = robot.position?.x ?? 0;
  const ry = robot.position?.y ?? 0;

  const path = astar(gm, rx, ry, goalX, goalY);
  if (!path || path.length < 2) {
    console.warn('[path] A* found no path');
    return { waypoints: [], ok: false };
  }

  // Skip first waypoint (current position)
  const wps = path.slice(1);
  pathQueue.pending = wps;
  console.log(`[path] A* route: ${wps.length} waypoints -> ${goalX},${goalY}`);

  // Send first waypoint immediately
  pathQueue.sendNext();

  return { waypoints: path, ok: true };
}

/* ─── Main ─── */
async function main() {
  tcp = new TcpServer(TCP_PORT, robot, dispatcher);
  const http = new HttpServer(HTTP_PORT, robot);

  if (robot.gridMap) {
    tcp.setGridMap(robot.gridMap);
    console.log(`[ctrl] GridMap loaded: ${robot.gridMap.width}x${robot.gridMap.height} @ ${robot.gridMap.res}m/cell`);
  }

  tcp.setOnConnected(async (sock) => {
    const remote = `${sock.remoteAddress}:${sock.remotePort}`;
    console.log(`[ctrl] ESP connected: ${remote} — pushing map...`);
    try {
      await tcp.sendMapTo(sock);
      console.log(`[ctrl] Map pushed to ${remote} (ACK received)`);
    } catch (e) {
      console.warn(`[ctrl] Map push to ${remote} failed: ${(e as Error).message}`);
    }
  });

  http.onCommand = (cmd) => tcp.sendToAll(cmd);
  http.setTcpConnected(() => tcp.isEspConnected());
  http.onNavPath = (x, y) => startNavPath(x, y);

  await Promise.all([tcp.start(), http.start()]);

  console.log(`[ctrl] Robot Center started`);
  console.log(`       TCP  ← ESP32:  :${TCP_PORT}`);
  console.log(`       HTTP ← Frontend: http://localhost:${HTTP_PORT}`);
}

main().catch((e) => {
  console.error('[ctrl] fatal:', e);
  process.exit(1);
});
