export interface RobotState {
  position: { x: number; y: number; angle: number };
  status: 'idle' | 'moving' | 'error';
  battery: number;
  tcpConnected: boolean;
  lastUpdate: number;
}

export interface GridMap {
  width: number;
  height: number;
  res: number;
  ox: number;
  oy: number;
  data: Uint8Array;
}

export interface PoiRecord {
  name: string;
  coord_x: number;
  coord_y: number;
  coord_z: number;
  description?: string;
}

export interface Waypoint {
  x: number;
  y: number;
  speed?: number;
}

export interface NavPath {
  waypoints: [number, number][];
}
