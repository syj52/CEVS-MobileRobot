#!/usr/bin/env python3
"""
导航调试工具：完全复刻 navigation_display.js 的 PGM/YAML 解析和二值化逻辑，
用 matplotlib 交互式展示地图、障碍判定和 A* 寻路结果。

用法：
    python3 nav_debug.py [--pgm nav2_map.pgm] [--yaml nav2_map.yaml]

操作：
    左键点击  → 设置起点（绿色十字）
    右键点击  → 设置终点（红色十字），自动规划路径
    按 r 键   → 重置
"""

import argparse
import heapq
import os
import sys
import numpy as np
import matplotlib
matplotlib.use('TkAgg')
import matplotlib.pyplot as plt
from matplotlib.patches import Circle
from collections import deque


def parse_yaml(path):
    data = {}
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            m = line.split(':', 1)
            if len(m) != 2:
                continue
            key = m[0].strip()
            val = m[1].strip()
            try:
                val = float(val) if '.' in val or 'e' in val.lower() else int(val)
            except ValueError:
                if val.startswith('['):
                    try:
                        val = [float(x) for x in val.strip('[]').split(',')]
                    except ValueError:
                        pass
            data[key] = val
    return data


def parse_pgm(path):
    with open(path, 'rb') as f:
        header = b''
        while True:
            line = f.readline()
            header += line
            if line.strip() == b'end_header' or b' ' not in line and len(header) > 50:
                break

        # parse header text
        text = header.decode('utf-8', errors='ignore')
        tokens = []
        for token in text.replace('\n', ' ').split():
            if token.startswith('#'):
                continue
            tokens.append(token)

        magic = tokens[0]
        width = int(tokens[1])
        height = int(tokens[2])
        maxval = int(tokens[3])

        # read pixel data
        expected = width * height
        # find where pixel data starts
        f.seek(0)
        all_bytes = f.read()
        # find end of header
        idx = all_bytes.find(b'end_header')
        if idx == -1:
            # for P5, data after maxval and a whitespace
            text_bytes = all_bytes
            data_start = 0
            whitespace_count = 0
            for i, b in enumerate(text_bytes):
                if b <= 32:  # whitespace
                    whitespace_count += 1
                if whitespace_count >= 4:  # after magic, width, height, maxval
                    data_start = i + 1
                    break
            data = np.frombuffer(all_bytes[data_start:data_start + expected], dtype=np.uint8)
        else:
            data_start = idx + len(b'end_header') + 1  # +1 for newline
            data = np.frombuffer(all_bytes[data_start:data_start + expected], dtype=np.uint8)

        if len(data) < expected:
            raise RuntimeError(f'PGM data too short: {len(data)} < {expected}')

        return {
            'width': width,
            'height': height,
            'maxval': maxval,
            'grid': data[:expected].copy()
        }


def is_obstacle(grid_val, maxval, negate, occupied_thresh):
    """完全复刻 JS _astar 的障碍判定"""
    v = maxval - grid_val if negate else grid_val
    occ = v / maxval
    return occ >= occupied_thresh


def astar(start, goal, occupancy):
    """4方向 A*，复刻 JS 逻辑"""
    h, w = occupancy.shape

    def idx(p):
        return p[1] * w + p[0]

    def in_bounds(p):
        return 0 <= p[0] < w and 0 <= p[1] < h

    def heuristic(a, b):
        return abs(a[0] - b[0]) + abs(a[1] - b[1])

    g_score = np.full(h * w, np.inf, dtype=np.float64)
    f_score = np.full(h * w, np.inf, dtype=np.float64)
    came_from = {}

    open_set = []
    g_score[idx(start)] = 0
    f_score[idx(start)] = heuristic(start, goal)
    heapq.heappush(open_set, (f_score[idx(start)], start))

    while open_set:
        _, current = heapq.heappop(open_set)
        if current == goal:
            path = [current]
            key = current
            while key in came_from:
                path.insert(0, came_from[key])
                key = came_from[key]
            return path

        for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
            neighbor = (current[0] + dx, current[1] + dy)
            if not in_bounds(neighbor):
                continue
            if occupancy[neighbor[1], neighbor[0]]:
                continue
            tent = g_score[idx(current)] + 1
            if tent < g_score[idx(neighbor)]:
                came_from[neighbor] = current
                g_score[idx(neighbor)] = tent
                f_score[idx(neighbor)] = tent + heuristic(neighbor, goal)
                heapq.heappush(open_set, (f_score[idx(neighbor)], neighbor))

    return None


class NavDebugger:
    def __init__(self, pgm_path, yaml_path):
        self.yaml = parse_yaml(yaml_path)
        self.pgm = parse_pgm(pgm_path)

        self.width = self.pgm['width']
        self.height = self.pgm['height']
        self.maxval = self.pgm['maxval']
        self.grid = self.pgm['grid'].reshape(self.height, self.width)
        self.negate = int(self.yaml.get('negate', 0))
        self.occupied_thresh = float(self.yaml.get('occupied_thresh', 0.65))
        self.free_thresh = float(self.yaml.get('free_thresh', 0.196))
        self.resolution = float(self.yaml.get('resolution', 0.05))
        self.origin = self.yaml.get('origin', [0.0, 0.0, 0.0])

        print(f'PGM: {self.width}x{self.height}, maxval={self.maxval}')
        print(f'Unique grid values: {np.unique(self.grid)}')
        print(f'negate={self.negate}, occupied_thresh={self.occupied_thresh}, free_thresh={self.free_thresh}')
        print(f'resolution={self.resolution}, origin={self.origin}')

        # 构建二值占用图（True=障碍）
        if self.negate:
            v = self.maxval - self.grid.astype(np.float64)
        else:
            v = self.grid.astype(np.float64)
        occ = v / self.maxval
        self.occupancy = occ >= self.occupied_thresh

        obs_count = np.sum(self.occupancy)
        free_count = self.width * self.height - obs_count
        print(f'障碍格数: {obs_count} ({obs_count/(self.width*self.height)*100:.1f}%)')
        print(f'空闲格数: {free_count} ({free_count/(self.width*self.height)*100:.1f}%)')

        # 交互状态
        self.start = None
        self.goal = None
        self.path = None

        self.fig, self.ax = plt.subplots(figsize=(12, 10))
        self.fig.canvas.manager.set_window_title('Nav Debug - 左键起点 右键终点 r重置')
        self._draw()
        self.fig.canvas.mpl_connect('button_press_event', self._on_click)
        self.fig.canvas.mpl_connect('key_press_event', self._on_key)
        plt.show()

    def _draw(self):
        self.ax.clear()

        # 绘制二值化地图：障碍=黑，空闲=白
        display = np.where(self.occupancy, 0, 255).astype(np.uint8)
        self.ax.imshow(display, cmap='gray', origin='upper',
                       extent=[0, self.width, self.height, 0])

        # 绘制路径
        if self.path:
            py = [p[1] for p in self.path]
            px = [p[0] for p in self.path]
            self.ax.plot(px, py, 'c-', linewidth=2, label=f'Path ({len(self.path)} steps)')

        # 绘制起点
        if self.start:
            self.ax.plot(self.start[0], self.start[1], 'X', color='lime',
                         markersize=14, markeredgewidth=2, label='Start')

        # 绘制终点
        if self.goal:
            self.ax.plot(self.goal[0], self.goal[1], 'X', color='red',
                         markersize=14, markeredgewidth=2, label='Goal')

        title = f'障碍判定: negate={self.negate}, occ_thresh={self.occupied_thresh}'
        if self.path:
            title += f' | 路径: {len(self.path)} 步 ≈ {len(self.path)*self.resolution:.2f}m'
        elif self.path is not None:
            title += ' | 无路可走!'
        self.ax.set_title(title)
        self.ax.legend(loc='upper right')
        self.fig.canvas.draw()

    def _on_click(self, event):
        if event.xdata is None or event.ydata is None:
            return
        gx = int(round(event.xdata))
        gy = int(round(event.ydata))
        if gx < 0 or gx >= self.width or gy < 0 or gy >= self.height:
            return

        if event.button == 1:  # 左键 → 起点
            self.start = (gx, gy)
            print(f'起点: ({gx}, {gy}), 原始值={self.grid[gy, gx]}, 障碍={self.occupancy[gy, gx]}')
        elif event.button == 3:  # 右键 → 终点
            self.goal = (gx, gy)
            print(f'终点: ({gx}, {gy}), 原始值={self.grid[gy, gx]}, 障碍={self.occupancy[gy, gx]}')

        if self.start and self.goal:
            if self.occupancy[self.goal[1], self.goal[0]]:
                print(f'⚠ 终点 ({gx},{gy}) 本身是障碍! 无法到达')
                self.path = None
            else:
                self.path = astar(self.start, self.goal, self.occupancy)
                if self.path:
                    print(f'✓ 找到路径: {len(self.path)} 步')
                else:
                    print(f'✗ 无路可走!')
        self._draw()

    def _on_key(self, event):
        if event.key == 'r':
            self.start = None
            self.goal = None
            self.path = None
            print('--- 重置 ---')
            self._draw()


def main():
    parser = argparse.ArgumentParser(description='导航二值化调试工具')
    parser.add_argument('--pgm', default='nav2_map.pgm')
    parser.add_argument('--yaml', default='nav2_map.yaml')
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    pgm_path = os.path.join(script_dir, args.pgm)
    yaml_path = os.path.join(script_dir, args.yaml)

    if not os.path.exists(pgm_path):
        print(f'找不到 PGM: {pgm_path}')
        sys.exit(1)
    if not os.path.exists(yaml_path):
        print(f'找不到 YAML: {yaml_path}')
        sys.exit(1)

    NavDebugger(pgm_path, yaml_path)


if __name__ == '__main__':
    main()
