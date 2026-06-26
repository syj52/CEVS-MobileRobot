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
      this.log?.info('MQTT 数字孪生同步已就绪');
      this.client.subscribe('cmd/nav_goal', { qos: 1 });
      this.client.subscribe('state/position', { qos: 0 }); // 增加位置订阅
    });

    this.client.on('error', (err) => {
      this.log?.warn(`MQTT 连接错误: ${err.message}`);
    });

    this.client.on('message', (topic, payload) => {
      try {
        const msg = JSON.parse(payload.toString());
        if (topic === 'cmd/nav_goal') {
           // 不再在此处直接修改位置，仅打印日志
           this.log?.info(`[指令下载] 目标: ${msg.poi_name || '未知'}`);
        } else if (topic === 'state/position') {
           // 关键：现在前端监听来自“实车/仿真节点”的位置上报
           this._handleRemotePosition(msg);
        }
      } catch (e) {
        this.log?.warn(`MQTT 消息解析失败: ${e.message}`);
      }
    });

    if (initialPos) {
      this.robotMesh?.position.copy(initialPos);
    }
  }

  // ------------------------------------------------------------------ position handle

  _handleRemotePosition(msg) {
    if (!this.robotMesh) return;
    
    // 映射回 Three.js 坐标系
    this.robotMesh.position.set(
      msg.x,
      msg.z || 0.2, // 高度
      msg.y
    );

    // 同步朝向 (如果消息包含 yaw)
    if (msg.yaw !== undefined) {
      // 假设 yaw 是绕 Y 轴旋转，调整 Three.js mesh 旋转
      // 注意：仿真发送的是正前方 angle，需根据模型原始方向调整偏移
      this.robotMesh.rotation.y = -msg.yaw; 
    }
  }

  _handleNavGoal(msg) {
    // 该方法改为可选调用，或者由于上层在模式切换时可能调用，
    // 我们将其逻辑清空，仅保留日志反馈
    this.log?.info(`导航目标已发送至实车端`);
  }

  /** 发布导航目标到仿真端 */
  publishNavGoal(x, z, poiName) {
    if (!this.client.connected) return;
    this.client.publish('cmd/nav_goal', JSON.stringify({
      poi_name: poiName || 'unknown',
      target_coords: { x, y: 0, z },
      timestamp: Date.now(),
    }), { qos: 1 });
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
