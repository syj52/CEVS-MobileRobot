import mqtt from 'mqtt';

const BROKER_URL = 'ws://localhost:9001';
const TOPICS = {
  position: 'state/position',
  navGoal: 'cmd/nav_goal',
  stop: 'cmd/stop',
  voiceText: 'cmd/voice_text',
  mapUpdate: 'slam/map_update',
};

export type NavGoalHandler = (x: number, y: number) => void;

export class MqttClient {
  private client: mqtt.MqttClient | null = null;
  private _onNavGoal: NavGoalHandler | null = null;

  set onNavGoal(fn: NavGoalHandler) { this._onNavGoal = fn; }

  start() {
    this.client = mqtt.connect(BROKER_URL, {
      clientId: 'cevs-server-' + Math.random().toString(16).slice(2, 8),
      clean: true,
      reconnectPeriod: 3000,
    });

    this.client.on('connect', () => {
      console.log('[mqtt] connected to broker');
      this.client?.subscribe(TOPICS.navGoal, { qos: 1 });
      this.client?.subscribe(TOPICS.position, { qos: 1 });
      this.client?.subscribe(TOPICS.mapUpdate, { qos: 1 });
    });

    this.client.on('message', (topic, payload) => {
      try {
        const msg = JSON.parse(payload.toString());
        switch (topic) {
          case TOPICS.navGoal:
            if (msg.target_coords && this._onNavGoal) {
              this._onNavGoal(msg.target_coords[0], msg.target_coords[1]);
            }
            break;
          case TOPICS.position:
            // Forward to state
            break;
        }
      } catch { /* ignore parse errors */ }
    });

    this.client.on('error', () => { /* MQTT optional — ignore */ });
  }

  publishNavGoal(x: number, y: number) {
    this.client?.publish(TOPICS.navGoal, JSON.stringify({ target_coords: [x, y] }), { qos: 1 });
  }

  publishPosition(x: number, y: number) {
    this.client?.publish(TOPICS.position, JSON.stringify({ x, y, ts: Date.now() }), { qos: 1 });
  }
}

export const mqttClient = new MqttClient();
