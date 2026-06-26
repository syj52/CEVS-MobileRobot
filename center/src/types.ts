// Robot state shared across all modules
export interface RobotState {
  position: { x: number; y: number };
  status: 'idle' | 'moving' | 'error';
  lastUpdate: number;
  gridMap?: GridMap;
}

export interface GridMap {
  width: number;      // 栅格列数
  height: number;     // 栅格行数
  res: number;        // 分辨率：米/格
  ox: number;         // 原点 X（地图坐标系左下角，米）
  oy: number;         // 原点 Y（地图坐标系左下角，米）
  data: Uint8Array;   // 扁平数组，0=障碍物(occupied)，254=可通行(free)
}

export interface NavGoal {
  x: number;
  y: number;
  speed?: number;
}

export interface PoiRecord {
  name: string;
  coord_x: number;
  coord_y: number;
  coord_z: number;
  map_id: string;
  description?: string;
}
