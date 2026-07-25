import { createServer } from 'http';
import { createExpressApp, setMapPusher } from './server/express.js';
import { TcpServer, tcpStats, setPosPush } from './server/tcp.js';
import { startWebSocket, broadcast, wsStats, setMotorHandler } from './server/websocket.js';
import { mqttClient } from './server/mqtt.js';
import { navApi, setTcpSend } from './api/navigation.js';
import { ApriltagDetector } from './server/apriltagDetector.js';
import { setDropNotifier, pickDirect } from './api/goods.js';
import { initVoiceService, onVoiceCommand } from './server/voiceService.js';
import { setCalibMotorSender } from './server/motionCalib.js';
import { startTagNav } from './api/tagNav.js';
import { state } from './state.js';

const TCP_PORT = 5000;
const API_PORT = 8000;

async function main() {
  // Express + WebSocket
  const httpServer = createServer();
  const { app } = createExpressApp(httpServer);
  httpServer.on('request', app);
  startWebSocket(httpServer);
  httpServer.listen(API_PORT, () => {
    console.log(`[cevs] API → http://localhost:${API_PORT}`);
  });

  // TCP server (ESP32) — handles commands + video frames
  const tcpServer = new TcpServer(TCP_PORT);
  setPosPush((x, y, aDeg) => {
    tcpServer.sendToAll(`CMD:POS:x=${x.toFixed(3)},y=${y.toFixed(3)},a=${aDeg.toFixed(1)}\r\n`);
  });
  setMotorHandler((frame) => tcpServer.sendToAll(frame));
  setTcpSend((msg) => tcpServer.sendToAll(msg));
  setCalibMotorSender((frame) => tcpServer.sendToAll(frame));
  setMapPusher(async () => { await tcpServer.pushMapToAll(); });

  const apriltagD = new ApriltagDetector();
  apriltagD.start();

  // 投货通知: 小车到位后, 通过 TCP 发指令让 ESP32 触发投货芯片
  //   协议: $DROP:<channel>\r\n  → ESP32 转发到投货芯片(UART/GPIO)
  setDropNotifier((channel: number) => {
    const cmd = `$DROP:${channel}\r\n`;
    tcpServer.sendToAll(cmd);
    console.log(`[cevs] 投货指令已发送: ${cmd.trim()}`);
  });

  // 语音指令: STT → LLM → 执行
  initVoiceService();
  onVoiceCommand((cmd, text) => {
    switch (cmd.cmd) {
      case 'pick':
        console.log(`[voice] → pick: ${cmd.goods}`);
        pickDirect(cmd.goods);
        break;
      case 'nav':
        console.log(`[voice] → nav: (${cmd.x}, ${cmd.y})`);
        startTagNav([{ x: cmd.x || 0, y: cmd.y || 0 }]);
        state.updateRobot({ status: 'moving' });
        break;
      case 'stop':
        console.log('[voice] → stop');
        navApi.stop();
        state.updateRobot({ status: 'idle' });
        break;
      case 'return':
        console.log('[voice] → return to origin');
        startTagNav([{ x: 0, y: 0 }]);
        state.updateRobot({ status: 'moving' });
        break;
      default:
        console.log(`[voice] Ignored: "${text}" → ${JSON.stringify(cmd)}`);
    }
    broadcast({ type: 'voice_status', text, status: 'executed', cmd });
  });

  tcpServer.onConnected = async (sock) => {
    console.log(`[cevs] ESP connected — pushing map + pose...`);
    try {
      await tcpServer.sendMapTo(sock);
      console.log('[cevs] Map pushed');
    } catch (e) {
      console.warn('[cevs] Map push failed:', (e as Error).message);
    }
    /* Send current robot pose as initial position */
    const p = state.robot.position;
    const poseCmd = `CMD:POS:x=${p.x.toFixed(3)},y=${p.y.toFixed(3)},a=${(p.angle*180/Math.PI).toFixed(1)}\r\n`;
    sock.write(poseCmd);
    console.log(`[cevs] Initial pose: (${p.x.toFixed(2)},${p.y.toFixed(2)})@${(p.angle*180/Math.PI).toFixed(1)}°`);
  };

  // JPEG frames from ESP32 go to AprilTag detector (and WebSocket via broadcastVideoFrame)
  tcpServer.onJpegFrame = (jpeg) => {
    apriltagD.feedFrame(jpeg);
  };

  tcpServer.onDisconnected = () => {
    console.log('[cevs] ESP disconnected');
  };

  await tcpServer.start();
  console.log(`[cevs] TCP ← ESP32 :${TCP_PORT}`);

  // MQTT (lingbot_map integration)
  mqttClient.onNavGoal = (x, y) => {
    console.log(`[mqtt] nav goal → (${x}, ${y})`);
    navApi.sendNav(x, y);
  };
  mqttClient.start();

  state.updateRobot({ status: 'idle' });

  console.log(`[cevs] Server ready`);
  console.log(`       Frontend :5173 (via Vite)`);
  console.log(`       API      :${API_PORT}`);
  console.log(`       TCP      :${TCP_PORT}  ← ESP32 (commands + JPEG video)`);
  console.log(`       MQTT     ws://localhost:9001`);

  // ── Video health check: log stats every 10s ──────────────
  let lastJpeg = tcpStats.jpegReceived;
  let lastBytes = tcpStats.jpegBytes;
  setInterval(() => {
    const nowJpeg = tcpStats.jpegReceived;
    const nowBytes = tcpStats.jpegBytes;
    const fps = ((nowJpeg - lastJpeg) / 10).toFixed(1);
    const kbps = ((nowBytes - lastBytes) / 10 / 1024).toFixed(0);
    const frames = tcpStats.jpegReceived;
    console.log(`[video] 📊 ${frames} frames total | ${fps} fps | ${kbps} KB/s`);
    lastJpeg = nowJpeg;
    lastBytes = nowBytes;
  }, 10000);

}

main().catch((e) => {
  console.error('[cevs] fatal:', e);
  process.exit(1);
});
