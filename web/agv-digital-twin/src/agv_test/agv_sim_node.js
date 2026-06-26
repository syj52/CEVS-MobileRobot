/**
 * agv_sim_node.js — 独立的小车仿真节点
 * 模拟真实硬件行为：监听指令 -> 平滑移动 -> 持续上报位置
 * 
 * 运行方式: node agv_sim_node.js
 */

import mqtt from 'mqtt';

// 配置
const BROKER_URL = 'mqtt://localhost:1883'; // 与后端控制器共用 1883
const TOPIC_NAV = 'cmd/nav_goal';
const TOPIC_POS = 'state/position';
const TICK_RATE = 50; // 20Hz 更新频率

class AgvPhysicalSim {
    constructor() {
        this.currentPos = { x: 0, y: 0.2, z: 0 };
        this.targetPos = { x: 0, y: 0.2, z: 0 };
        this.speed = 1.5; // 米/秒
        
        this.client = mqtt.connect(BROKER_URL, {
            clientId: 'agv-physical-sim-node',
            clean: true
        });

        this.client.on('connect', () => {
            console.log('✅ AGV 仿真节点已连接至 Broker (1883)');
            this.client.subscribe(TOPIC_NAV);
            this.startLoop();
        });

        this.client.on('message', (topic, payload) => {
            if (topic === TOPIC_NAV) {
                try {
                    const msg = JSON.parse(payload.toString());
                    console.log(`📥 收到新目标: ${msg.poi_name} -> (${msg.target_coords.x.toFixed(2)}, ${msg.target_coords.z.toFixed(2)})`);
                    this.targetPos = {
                        x: msg.target_coords.x,
                        y: 0.2,
                        z: msg.target_coords.z
                    };
                } catch (e) {
                    console.error('解析指令失败:', e);
                }
            }
        });
    }

    startLoop() {
        setInterval(() => {
            this.updatePhysics();
            this.publishPosition();
        }, TICK_RATE);
    }

    updatePhysics() {
        // 模拟物理特性：带有最大速度和加速度的运动模型
        const dx = this.targetPos.x - this.currentPos.x;
        const dz = this.targetPos.z - this.currentPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > 0.02) {
            // 计算期望方向
            const angle = Math.atan2(dz, dx);
            
            // 简单的平滑转向模拟 (如果需要可以增加角度分量)
            // 速度控制：接近目标时减速
            const decelerationDist = 0.5;
            let currentTargetSpeed = this.speed;
            if (dist < decelerationDist) {
                currentTargetSpeed = this.speed * (dist / decelerationDist);
            }

            const step = (currentTargetSpeed * TICK_RATE) / 1000;
            const moveStep = Math.min(step, dist);
            
            this.currentPos.x += Math.cos(angle) * moveStep;
            this.currentPos.z += Math.sin(angle) * moveStep;
            
            // 记录当前朝向 (rad)
            this.currentPos.yaw = angle;
        } else {
            this.currentPos.x = this.targetPos.x;
            this.currentPos.z = this.targetPos.z;
        }
    }

    publishPosition() {
        if (!this.client.connected) return;
        
        const payload = JSON.stringify({
            x: this.currentPos.x,
            y: this.currentPos.z,
            z: this.currentPos.y,
            yaw: this.currentPos.yaw || 0,
            status: this.isMoving() ? 'moving' : 'idle',
            timestamp: Date.now()
        });
        
        // 使用 retain: true 确保新加入的订阅者（如模式切换后的前端）能立即收到最后位置
        this.client.publish(TOPIC_POS, payload, { qos: 1, retain: true });
    }

    isMoving() {
        const dx = this.targetPos.x - this.currentPos.x;
        const dz = this.targetPos.z - this.currentPos.z;
        return Math.sqrt(dx * dx + dz * dz) > 0.05;
    }
}

new AgvPhysicalSim();
