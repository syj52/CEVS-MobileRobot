import type { RobotState, GridMap } from './types.js';

function makeGrid(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height).fill(254);
}

function setBlock(map: GridMap, col: number, row: number) {
  if (col >= 0 && col < map.width && row >= 0 && row < map.height) {
    map.data[row * map.width + col] = 0;
  }
}

function gridIsFree(map: GridMap, col: number, row: number): boolean {
  if (col < 0 || col >= map.width || row < 0 || row >= map.height) return false;
  return map.data[row * map.width + col] === 254;
}

/** 创建一个 20×15 的测试地图，分辨率 0.1 m/格 = 2m × 1.5m 实际尺寸 */
function createTestMap(): GridMap {
  const W = 20, H = 15;
  const map: GridMap = {
    width: W, height: H,
    res: 0.1,
    ox: 0.0, oy: 0.0,
    data: makeGrid(W, H),
  };

  // 中央十字障碍物（col=9/10, row=6/7/8）
  for (let c = 9; c <= 10; c++) {
    for (let r = 5; r <= 9; r++) setBlock(map, c, r);
  }
  for (let r = 6; r <= 8; r++) {
    for (let c = 7; c <= 12; c++) setBlock(map, c, r);
  }
  // 左上角一堵墙（col 1-4, row 1-3）
  for (let c = 1; c <= 4; c++) for (let r = 1; r <= 3; r++) setBlock(map, c, r);
  // 右侧中间墙（col 16-18, row 9-11）
  for (let c = 16; c <= 18; c++) for (let r = 9; r <= 11; r++) setBlock(map, c, r);
  // 下方一排障碍（col 5-14, row 12）
  for (let c = 5; c <= 14; c++) setBlock(map, c, 12);

  return map;
}

export const TEST_GRID_MAP = createTestMap();

export function createRobotState(): RobotState {
  return {
    position: { x: 0, y: 0 },
    status: 'idle',
    lastUpdate: Date.now(),
    gridMap: TEST_GRID_MAP,
  };
}
