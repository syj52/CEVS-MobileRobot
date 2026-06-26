#!/usr/bin/env python3
"""
view_nav_map.py
渲染 nav2 PGM + YAML 地图并保存预览 PNG（灰度 + 占用覆盖）。
用法:
  python3 view_nav_map.py --pgm path/to/nav2_map.pgm --yaml path/to/nav2_map.yaml --out out.png

依赖: numpy, matplotlib
如果缺失请运行 `pip install numpy matplotlib`（或使用 conda）。
"""
import sys
import argparse

try:
    import numpy as np
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
except Exception as e:
    print('需要安装依赖：numpy, matplotlib')
    print('错误：', e)
    sys.exit(2)


def parse_yaml(path):
    data = {}
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if ':' not in line:
                continue
            k, v = line.split(':', 1)
            k = k.strip(); v = v.strip()
            if not v:
                data[k] = ''
                continue
            if v.startswith('[') and v.endswith(']'):
                try:
                    data[k] = eval(v)
                    continue
                except Exception:
                    pass
            try:
                if '.' in v:
                    data[k] = float(v)
                else:
                    data[k] = int(v)
            except Exception:
                data[k] = v
    return data


def parse_pgm(path):
    b = open(path, 'rb').read()
    i = 0
    n = len(b)
    def read_token():
        nonlocal i
        # skip whitespace and comments
        while i < n:
            if b[i] == 35: # '#'
                while i < n and b[i] != 10: i += 1
                continue
            if b[i] <= 32:
                i += 1; continue
            break
        s = b''
        while i < n and b[i] > 32:
            s += bytes([b[i]]); i += 1
        return s.decode()
    magic = read_token()
    if not magic.startswith('P5'):
        raise RuntimeError('非 P5 PGM 文件')
    width = int(read_token()); height = int(read_token()); maxval = int(read_token())
    if i < n and b[i] == 10: i += 1
    expected = width * height
    data = np.frombuffer(b[i:i+expected], dtype=np.uint8).copy()
    data = data.reshape((height, width))
    return width, height, maxval, data


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--pgm', required=True)
    p.add_argument('--yaml', required=True)
    p.add_argument('--out', default='nav2_map_preview.png')
    args = p.parse_args()

    meta = parse_yaml(args.yaml)
    w,h,maxval,grid = parse_pgm(args.pgm)
    negate = int(meta.get('negate', 0))
    occupied_thresh = float(meta.get('occupied_thresh', 0.65))
    free_thresh = float(meta.get('free_thresh', 0.196))

    if negate:
        gridv = maxval - grid
    else:
        gridv = grid.copy()

    occ = (gridv.astype(float) / maxval) >= occupied_thresh
    free = (gridv.astype(float) / maxval) <= free_thresh
    occ_ratio = occ.sum() / (w*h)

    print(f'PGM: {args.pgm}  size={w}x{h} maxval={maxval} negate={negate} occupied_ratio={occ_ratio:.4f}')

    # 绘图：左原始（处理过 negate），右叠加占用
    fig, ax = plt.subplots(1,2, figsize=(12,6))
    ax[0].imshow(gridv, cmap='gray', origin='lower')
    ax[0].set_title('PGM (negate applied)')
    ax[0].axis('off')

    ax[1].imshow(gridv, cmap='gray', origin='lower')
    ax[1].imshow(occ, cmap='Reds', alpha=0.6, origin='lower')
    ax[1].set_title('Occupancy overlay (red=occupied)')
    ax[1].axis('off')

    plt.suptitle(f'negate={negate} occupied_ratio={occ_ratio:.3f}')
    plt.tight_layout(rect=[0,0,1,0.96])
    out = args.out
    plt.savefig(out, dpi=150)
    print('saved:', out)


if __name__ == '__main__':
    main()
