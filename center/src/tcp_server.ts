import { createServer, Socket } from 'net';
import type { RobotState, GridMap } from './types.js';

export type DispatchFn = (state: RobotState, line: string) => string | null;

const LINE_BUF_SIZE = 512;
const MAP_ACK_TIMEOUT_MS = 8000;

interface ClientState {
  lineBuf: Buffer;
  lineLen: number;
  binaryLeft: number;   // 剩余待接收的二进制字节数（ESP→Center 时用，暂无）
}

export class TcpServer {
  private server = createServer();
  private clients = new Set<Socket>();
  private clientStates = new Map<Socket, ClientState>();
  private lineBufs = new Map<Socket, { buf: Buffer; len: number }>();
  private dispatch: DispatchFn;
  private robot: RobotState;
  private port: number;
  private gridMap: GridMap | null = null;
  private onConnected: ((sock: Socket) => void) | null = null;
  private pendingAcks = new Map<Socket, { resolve: () => void; reject: (e: Error) => void }>();

  constructor(port: number, robot: RobotState, dispatch: DispatchFn) {
    this.port = port;
    this.robot = robot;
    this.dispatch = dispatch;
    this.server.on('connection', (sock) => this.onConnection(sock));
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, '0.0.0.0', () => resolve());
    });
  }

  /** 外部注入地图引用（main.ts 初始化时传入 robot.gridMap） */
  setGridMap(map: GridMap) {
    this.gridMap = map;
  }

  /** 外部注入连接回调（触发地图推送） */
  setOnConnected(cb: (sock: Socket) => void) {
    this.onConnected = cb;
  }

  /** 是否有 ESP32 通过 TCP 连接 */
  isEspConnected(): boolean {
    return this.clients.size > 0;
  }

  /** 主动向指定 ESP 推送地图，推送后等待 ACK:MAP，resolve 在收到后触发 */
  sendMapTo(sock: Socket): Promise<void> {
    if (!this.gridMap) {
      console.warn('[tcp] no grid map available, skip');
      return Promise.resolve();
    }
    const m = this.gridMap;

    const meta = `MAP:W=${m.width},H=${m.height},R=${m.res},OX=${m.ox},OY=${m.oy}\r\n`;
    const headerBuf = Buffer.from(meta, 'utf8');
    const dataBuf = Buffer.from(m.data.buffer, m.data.byteOffset, m.width * m.height);
    const endBuf = Buffer.from('MAP:END\r\n', 'utf8');

    // Set up ACK tracking BEFORE writing — ESP may respond before the
    // last write() callback fires, and we cannot miss that ACK.
    const t = setTimeout(() => {
      this.pendingAcks.delete(sock);
      sock.destroy();
    }, MAP_ACK_TIMEOUT_MS);

    this.pendingAcks.set(sock, { resolve: () => { clearTimeout(t); }, reject: () => { clearTimeout(t); } });

    sock.write(headerBuf, () => console.log(`[tcp] MAP header sent (${m.width}x${m.height})`));
    sock.write(dataBuf, () => console.log(`[tcp] MAP data sent (${dataBuf.byteLength} bytes)`));
    sock.write(endBuf, () => console.log('[tcp] MAP:END sent'));

    return new Promise((resolve, reject) => {
      const existing = this.pendingAcks.get(sock);
      if (existing) {
        const prevResolve = existing.resolve;
        const prevReject = existing.reject;
        this.pendingAcks.set(sock, {
          resolve: () => { prevResolve(); resolve(); },
          reject: (e) => { prevReject(e); reject(e); },
        });
      }
    });
  }

  private onConnection(sock: Socket) {
    const remote = `${sock.remoteAddress}:${sock.remotePort}`;
    console.log(`[tcp] ESP32 connected: ${remote}`);
    this.clients.add(sock);
    this.lineBufs.set(sock, { buf: Buffer.alloc(LINE_BUF_SIZE), len: 0 });
    this.clientStates.set(sock, { lineBuf: Buffer.alloc(LINE_BUF_SIZE), lineLen: 0, binaryLeft: 0 });

    sock.on('data', (chunk) => this.onData(sock, chunk));
    sock.on('close', () => {
      console.log(`[tcp] ESP32 disconnected: ${remote}`);
      this.clients.delete(sock);
      this.lineBufs.delete(sock);
      this.clientStates.delete(sock);
      this.pendingAcks.delete(sock);
    });
    sock.on('error', (e) => {
      console.warn(`[tcp] socket error ${remote}: ${e.message}`);
      this.clients.delete(sock);
      this.lineBufs.delete(sock);
      this.clientStates.delete(sock);
      this.pendingAcks.delete(sock);
    });

    if (this.onConnected) this.onConnected(sock);
  }

  private onData(sock: Socket, chunk: Buffer) {
    const entry = this.lineBufs.get(sock)!;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0A) {
        const lineLen = entry.len;
        if (lineLen > 0 && entry.buf[lineLen - 1] === 0x0D) {
          entry.buf[lineLen - 1] = 0;
        } else {
          entry.buf[lineLen] = 0;
        }
        const line = entry.buf.subarray(0, lineLen).toString('utf8');
        entry.len = 0;

        if (line.trim()) {
          // 检查 MAP ACK（ESP 主动发来的确认，不是命令，不走 dispatch）
          const ack = this.pendingAcks.get(sock);
          const trimmedLine = line.trim();
          if (ack && trimmedLine.startsWith('ACK:MAP')) {
            console.log('[tcp] MAP ACK received');
            ack.resolve();
            this.pendingAcks.delete(sock);
            return;  // ← 直接 return，不 dispatch，不发任何回复
          }
          const reply = this.dispatch(this.robot, line);
          if (reply) {
            sock.write(reply, () => {
              console.log(`[tcp] send: ${reply.trimEnd()}`);
            });
          }
        }
      } else {
        if (entry.len < LINE_BUF_SIZE - 1) {
          entry.buf[entry.len++] = chunk[i];
        } else {
          console.warn('[tcp] line overflow, dropping');
          entry.len = 0;
        }
      }
    }
  }

  sendToAll(msg: string) {
    const data = msg.endsWith('\r\n') ? msg : msg + '\r\n';
    for (const sock of this.clients) {
      sock.write(data);
    }
  }
}

