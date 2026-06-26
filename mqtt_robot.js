/**
 * mqtt_robot.js — 前端模拟小车，通过 MQTT WebSocket 对接云端 controller。
 *
 * 订阅 cmd/nav_goal → 驱动机器人方块移动到目标坐标
 * 发布 state/position → 上报小车当前位置
 * 发布 cmd/voice_text → 测试用（模拟小车语音输入）
 */

import mqtt from 'mqtt';

export class MqttRobot {
  /**
   * @param {Object} opts
   * @param {THREE.Mesh} opts.robotMesh — NavigationDisplay 中的蓝色方块
   * @param {THREE.Vector3} [opts.initialPos]
   * @param {Function} [opts.onNavGoal] — 收到导航目标时的回调
   * @param {Object} [opts.logger]
   * @param {string} [opts.brokerUrl] — MQTT WebSocket 地址
   */
  constructor({ robotMesh, initialPos, onNavGoal, logger, brokerUrl = 'ws://localhost:9001' }) {
    this.robotMesh = robotMesh;
    this.log = logger;
    this._onNavGoal = onNavGoal;
    this._brokerUrl = brokerUrl;

    this.client = mqtt.connect(brokerUrl, {
      clientId: 'lingbot-frontend-' + Math.random().toString(16).slice(2, 8),
      clean: true,
      reconnectPeriod: 3000,
    });

    this.client.on('connect', () => {
      this.log?.info('MQTT 小车已连接 broker');
      this.client.subscribe('cmd/nav_goal', { qos: 1 });
    });

    this.client.on('error', (err) => {
      this.log?.warn(`MQTT 连接错误: ${err.message}`);
    });

    this.client.on('message', (topic, payload) => {
      try {
        const msg = JSON.parse(payload.toString());
        if (topic === 'cmd/nav_goal') this._handleNavGoal(msg);
      } catch (e) {
        this.log?.warn(`MQTT 消息解析失败: ${e.message}`);
      }
    });

    if (initialPos) {
      this.robotMesh?.position.copy(initialPos);
    }
  }

  // ------------------------------------------------------------------ cmd/nav_goal

  _handleNavGoal(msg) {
    const coords = msg.target_coords;
    if (!coords) return;

    this.log?.info(`导航目标: ${msg.poi_name || '未知'} @ (${coords.x.toFixed(2)}, ${coords.z.toFixed(2)})`);

    // 设置机器人位置（Three.js: Y 朝上，地面在 XZ 平面）
    if (this.robotMesh) {
      this.robotMesh.position.set(
        coords.x,
        0.2, // 离地高度
        coords.z,
      );
    }

    // 上报新位置
    this.publishPosition();

    // 触发外部回调（如更新小地图、画路径等）
    if (this._onNavGoal) this._onNavGoal(msg);
  }

  // ------------------------------------------------------------------ state/position

  /** 发布小车当前位置 */
  publishPosition() {
    if (!this.robotMesh || !this.client.connected) return;

    const pos = this.robotMesh.position;
    this.client.publish('state/position', JSON.stringify({
      x: pos.x,
      y: pos.z,   // Three.js Z → MQTT y（地图坐标系 Y）
      z: pos.y,   // Three.js Y → MQTT z（高度）
    }), { qos: 1 });
  }

  // ------------------------------------------------------------------ 测试用

  /**
   * 模拟小车发出一条语音指令（测试时用）。
   * 比如 `sendVoiceCommand("带我去测试点1")`
   */
  sendVoiceCommand(text, sessionId = null) {
    if (!this.client.connected) {
      this.log?.warn('MQTT 未连接，无法发送指令');
      return;
    }
    const msg = { text };
    if (sessionId) msg.session_id = sessionId;
    this.client.publish('cmd/voice_text', JSON.stringify(msg), { qos: 1 });
    this.log?.llm(text);
  }

  // ------------------------------------------------------------------ lifecycle

  dispose() {
    this.client.end();
    this.log?.info('MQTT 小车已断开');
  }
}
