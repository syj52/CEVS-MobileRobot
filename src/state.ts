import type { RobotState, GridMap, PoiRecord } from './types.js';
import { loadNavMap } from './loadMap.js';
const INITIAL_POS = { x: 0, y: 0, angle: Math.PI };

class State {
  robot: RobotState = {
    position: { ...INITIAL_POS },
    status: 'idle',
    battery: 100,
    tcpConnected: false,
    lastUpdate: Date.now(),
  };

  gridMap: GridMap = loadNavMap();
  pois: PoiRecord[] = [
    { name: 'start', coord_x: 0, coord_y: 0, coord_z: 0, description: '起始点' },
    { name: 'point_a', coord_x: 5, coord_y: 0, coord_z: 0, description: 'A点' },
  ];

  // Callbacks for state changes (pushed to WebSocket clients)
  listeners: Set<(state: State) => void> = new Set();

  onChange(fn: (state: State) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private notify() {
    for (const fn of this.listeners) fn(this);
  }

  updateRobot(partial: Partial<RobotState>) {
    Object.assign(this.robot, partial, { lastUpdate: Date.now() });
    this.notify();
  }

  setTcpConnected(v: boolean) {
    this.robot.tcpConnected = v;
    this.notify();
  }

  setMap(map: GridMap) { this.gridMap = map; this.notify(); }
}

export const state = new State();
