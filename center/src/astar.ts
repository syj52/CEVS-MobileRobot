/** A* pathfinding on GridMap — world coords in, world coords out */
import type { GridMap } from './types.js';

interface Node {
  col: number;
  row: number;
  g: number;
  f: number;
  parent: Node | null;
}

/** Convert world coords to grid indices */
function worldToGrid(wx: number, wy: number, m: GridMap): [number, number] {
  const col = Math.round((wx - m.ox) / m.res);
  const row = Math.round((wy - m.oy) / m.res);
  return [col, row];
}

/** Convert grid indices to world coords (center of cell) */
function gridToWorld(col: number, row: number, m: GridMap): [number, number] {
  return [col * m.res + m.ox + m.res / 2, row * m.res + m.oy + m.res / 2];
}

/** Manhattan distance */
function heuristic(a: [number, number], b: [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/**
 * A* on the grid.
 * m.data[row * m.width + col] === 254 means free.
 * Returns array of waypoints in world coords, or null if unreachable.
 */
export function astar(m: GridMap, startX: number, startY: number, goalX: number, goalY: number): [number, number][] | null {
  const [sc, sr] = worldToGrid(startX, startY, m);
  const [gc, gr] = worldToGrid(goalX, goalY, m);

  // Bounds check
  if (sc < 0 || sc >= m.width || sr < 0 || sr >= m.height) return null;
  if (gc < 0 || gc >= m.width || gr < 0 || gr >= m.height) return null;

  // Goal cell itself must be free (or it IS the start)
  if (m.data[gr * m.width + gc] !== 254 && !(sc === gc && sr === gr)) return null;

  const open: Node[] = [];
  const closed = new Set<number>();

  function key(c: number, r: number): number { return r * m.width + c; }

  open.push({ col: sc, row: sr, g: 0, f: heuristic([sc, sr], [gc, gr]), parent: null });

  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  const costStraight = 1;
  const costDiagonal = Math.SQRT2;

  while (open.length > 0) {
    // Find lowest f
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[best].f) best = i;
    }
    const cur = open.splice(best, 1)[0];

    if (cur.col === gc && cur.row === gr) {
      // Reconstruct path
      const path: [number, number][] = [];
      let n: Node | null = cur;
      while (n) { path.push(gridToWorld(n.col, n.row, m)); n = n.parent; }
      path.reverse();
      return path;
    }

    closed.add(key(cur.col, cur.row));

    for (const [dc, dr] of dirs) {
      const nc = cur.col + dc;
      const nr = cur.row + dr;
      if (nc < 0 || nc >= m.width || nr < 0 || nr >= m.height) continue;
      if (closed.has(key(nc, nr))) continue;
      if (m.data[nr * m.width + nc] !== 254) continue; // blocked

      const isDiag = dc !== 0 && dr !== 0;
      const moveCost = isDiag ? costDiagonal : costStraight;
      const g = cur.g + moveCost;

      const existing = open.find(n => n.col === nc && n.row === nr);
      if (existing) {
        if (g < existing.g) {
          existing.g = g;
          existing.f = g + heuristic([nc, nr], [gc, gr]);
          existing.parent = cur;
        }
        continue;
      }

      open.push({
        col: nc, row: nr, g,
        f: g + heuristic([nc, nr], [gc, gr]),
        parent: cur,
      });
    }
  }

  return null; // No path
}
