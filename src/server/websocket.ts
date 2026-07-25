import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import { state } from '../state.js';

let wss: WebSocketServer;

/** Registered callbacks for binary JPEG frames */
type FrameHandler = (jpeg: Buffer) => void;
const frameSubscribers = new Set<FrameHandler>();

export function onFrameRequested(fn: FrameHandler) {
  frameSubscribers.add(fn);
  return () => frameSubscribers.delete(fn);
}

let s_sendMotor: ((frame: string) => void) | null = null;

/** Register a low-latency motor command sender (called from tcp.ts) */
export function setMotorHandler(fn: (frame: string) => void) {
  s_sendMotor = fn;
}

export function startWebSocket(httpServer: HttpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => {
    // Send current state on connect
    ws.send(JSON.stringify({
      type: 'state',
      robot: state.robot,
      mapMeta: { w: state.gridMap.width, h: state.gridMap.height },
    }));

    // Handle client messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe_video') {
          const sendFrame = (jpeg: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(jpeg);
            }
          };
          frameSubscribers.add(sendFrame);
          ws.on('close', () => frameSubscribers.delete(sendFrame));
          ws.send(JSON.stringify({ type: 'video_subscribed', ok: true }));
        }
        if (msg.type === 'apriltag_result') {
          broadcast({ type: 'apriltag', tags: msg.tags });
        }
        if (msg.type === 'motor' && msg.frame) {
          // Low-latency motor command via WebSocket → TCP
          if (s_sendMotor) s_sendMotor(msg.frame as string);
        }
      } catch { /* ignore malformed JSON */ }
    });

    const unsub = state.onChange(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'state', robot: state.robot }));
      }
    });
    ws.on('close', unsub);
  });
}

export function broadcast(msg: object) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

/** Broadcast a binary JPEG frame to all video subscribers.
 * Backpressure-aware: skip frames for lagging clients. */
const WS_BACKPRESSURE_LIMIT = 256 * 1024;

// ─── Diagnostics ────────────────────────────────────────────
export const wsStats = {
  framesBroadcast: 0,
  framesDropped: 0,
  maxBufferedAmount: 0,
  clientCount: 0,
};

export function broadcastVideoFrame(jpeg: Buffer) {
  if (!wss) return;
  wsStats.clientCount = wss.clients.size;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const buffered = client.bufferedAmount;
    if (buffered > wsStats.maxBufferedAmount) wsStats.maxBufferedAmount = buffered;
    if (buffered > WS_BACKPRESSURE_LIMIT) {
      wsStats.framesDropped++;
      continue;
    }
    try { client.send(jpeg); wsStats.framesBroadcast++; } catch { /* mid-send disconnect */ }
  }
}
