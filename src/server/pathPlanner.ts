/**
 * pathPlanner.ts — 固定路径数据（与 STM32 paths.h 同步）
 *
 * 每条路径由 {d_mm, a_deg} 段组成，服务器用此数据推算位置，
 * STM32 的 EXEC:NAV_DONE 仅作为"段完成"的触发信号。
 */
export interface PathSegment {
  d_mm: number;  // 距离 mm（正=前进，负=后退）
  a_deg: number; // 角度 °（正=左转CCW，负=右转CW）
}

// 与 STM32 paths.h 完全一致的路径定义
const PATHS: PathSegment[][] = [
  [],  // 索引 0 不使用
  // 路径 1: 短距往返
  [
    { d_mm: 700, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 700, a_deg: 0 },
    { d_mm: 0, a_deg: 180 },
    { d_mm: 0, a_deg: 0 },     // PATH_WAIT (等待点，d=0,a=0)
    { d_mm: 700, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 700, a_deg: 0 },
  ],
  // 路径 2: 长距往返
  [
    { d_mm: 2300, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 800, a_deg: 0 },
    { d_mm: 0, a_deg: 180 },
    { d_mm: 0, a_deg: 0 },     // PATH_WAIT
    { d_mm: 800, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 2300, a_deg: 0 },
  ],
  // 路径 3: 弯绕路线
  [
    { d_mm: 600, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 700, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 800, a_deg: 0 },
    { d_mm: 0, a_deg: 0 },     // PATH_WAIT
    { d_mm: 0, a_deg: 180 },
    { d_mm: 800, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 700, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 600, a_deg: 0 },
  ],
  // 路径 4
  [
    { d_mm: 600, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 700, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 1300, a_deg: 0 },
    { d_mm: 0, a_deg: 0 },     // PATH_WAIT
    { d_mm: 0, a_deg: 180 },
    { d_mm: 1300, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 700, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 600, a_deg: 0 },
  ],
  // 路径 5
  [
    { d_mm: 600, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 700, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 1700, a_deg: 0 },
    { d_mm: 0, a_deg: 0 },     // PATH_WAIT
    { d_mm: 0, a_deg: 180 },
    { d_mm: 1700, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 700, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 600, a_deg: 0 },
  ],
  // 路径 6: 左转L型
  [
    { d_mm: 600, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 1600, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 1550, a_deg: 0 },
    { d_mm: 0, a_deg: 180 },
    { d_mm: 0, a_deg: 0 },     // PATH_WAIT
    { d_mm: 1550, a_deg: 0 },
    { d_mm: 0, a_deg: 90 },
    { d_mm: 1600, a_deg: 0 },
    { d_mm: 0, a_deg: -90 },
    { d_mm: 600, a_deg: 0 },
  ],
];

/** 获取指定路径的段列表 */
export function getPathSegments(pathId: number): PathSegment[] | null {
  if (pathId < 1 || pathId >= PATHS.length) return null;
  return PATHS[pathId];
}

/** 从路径段推算位置变化。返回 {dx, dy, da} 世界坐标变化 */
export function applySegment(pos: { x: number; y: number; angle: number }, seg: PathSegment):
    { x: number; y: number; angle: number } {
  const dM = seg.d_mm / 1000;
  const aRad = seg.a_deg * Math.PI / 180;
  const hRad = pos.angle;
  return {
    x: pos.x + dM * Math.cos(hRad),
    y: pos.y + dM * Math.sin(hRad),
    angle: pos.angle + aRad,
  };
}

/** 当前活动的路径状态 */
let s_activePath: PathSegment[] | null = null;
let s_segIndex = 0;

export function startPath(pathId: number): boolean {
  const segs = getPathSegments(pathId);
  if (!segs) { console.log('[PATH] startPath(' + pathId + ') FAILED - no segments'); return false; }
  s_activePath = segs;
  s_segIndex = 0;
  return true;
}

function skipWaits(): boolean {
  while (s_activePath && s_segIndex < s_activePath.length && s_activePath[s_segIndex].d_mm === 0 && s_activePath[s_segIndex].a_deg === 0) {
    s_segIndex++;
  }
  if (s_activePath && s_segIndex >= s_activePath.length) {
    s_activePath = null;
    return false;
  }
  return s_activePath !== null;
}

export function advancePath(): PathSegment | null {
  if (!s_activePath) { console.log('[PATH] advancePath: no active path'); return null; }
  if (!skipWaits()) { console.log('[PATH] advancePath: path complete at seg ' + s_segIndex); return null; }
  const seg = s_activePath![s_segIndex];
  s_segIndex++;
  return seg;
}

export function pathReachedWait(): boolean {
  if (!s_activePath) return false;
  while (s_segIndex < s_activePath.length && s_activePath[s_segIndex].d_mm === 0 && s_activePath[s_segIndex].a_deg === 0) {
    s_segIndex++;
  }
  return s_activePath !== null && s_segIndex < s_activePath.length;
}

export function pathComplete(): void {
  s_activePath = null; s_segIndex = 0;
}
