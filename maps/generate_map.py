#!/usr/bin/env python3
"""
一键生成路线导航地图 (Unified Map Generator)
将提取 GLB 点云与 PGM 栅格绘图合并。并自动将 3DGS 产生的位移/旋转保存应用。
"""

import argparse
import os
import json
import struct
import math
import numpy as np

try:
    import cv2
except ImportError:
    raise RuntimeError('需要安装 opencv-python: pip install opencv-python')

def load_glb_points_transformed(path):
    """底层解析 GLB，自动应用用户在数字孪生系统里修正后的 Transform Matrix。"""
    with open(path, 'rb') as f:
        magic = f.read(4)
        if magic != b'glTF': 
            raise RuntimeError("并非标准的 GLB 文件")
        version, length = struct.unpack('<II', f.read(8))
        
        chunk0_length, chunk0_type = struct.unpack('<II', f.read(8))
        json_data = f.read(chunk0_length).decode('utf-8')
        gltf = json.loads(json_data)
        
        chunk1_length, chunk1_type = struct.unpack('<II', f.read(8))
        if chunk1_type != 0x004E4942: 
            raise RuntimeError("缺少 Bin 数据块")
        bin_data = f.read(chunk1_length)
        
    def resolve_global_transform(node_idx):
        # 寻找根节点到当前节点的层级路径
        curr = node_idx
        path_nodes = [curr]
        while True:
            parent = None
            for i, n in enumerate(gltf.get('nodes', [])):
                if 'children' in n and curr in n['children']:
                    parent = i
                    break
            if parent is None:
                break
            curr = parent
            path_nodes.append(curr)
        path_nodes.reverse()
        
        M = np.eye(4)
        for i in path_nodes:
            node = gltf['nodes'][i]
            if 'matrix' in node:
                m = np.array(node['matrix']).reshape(4, 4).T
                M = M @ m
        return M

    all_points = []
    for i, node in enumerate(gltf.get('nodes', [])):
        if 'mesh' in node:
            mesh_idx = node['mesh']
            mesh = gltf['meshes'][mesh_idx]
            global_transform = resolve_global_transform(i)
            
            for prim in mesh['primitives']:
                pos_acc_idx = prim['attributes'].get('POSITION')
                if pos_acc_idx is not None:
                    acc = gltf['accessors'][pos_acc_idx]
                    bv = gltf['bufferViews'][acc['bufferView']]
                    offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
                    count = acc['count']
                    stride = bv.get('byteStride', 12)
                    
                    pts = np.ndarray(
                        shape=(count,), 
                        dtype=np.dtype((np.float32, 3)), 
                        buffer=bin_data, 
                        offset=offset, 
                        strides=(stride,)
                    )
                    
                    # 应用矩阵偏转
                    pts_homo = np.column_stack((pts, np.ones(count)))
                    pts_trans = (global_transform @ pts_homo.T).T[:, :3]
                    all_points.append(pts_trans)
                    
    if not all_points:
        raise RuntimeError("在模型中未找到有效顶点数据")
    return np.concatenate(all_points)

def main():
    parser = argparse.ArgumentParser(description="综合 2D 判定地图生成器")
    parser.add_argument('--glb', default='corridor_point.glb', help='输入的 GLB 模型文件')
    parser.add_argument('--resolution', type=float, default=0.05, help='栅格地图分辨率，默认 0.05米/格')
    parser.add_argument('--margin', type=int, default=10, help='地图外扩余量边界 (像素)')
    parser.add_argument('--robot-radius', type=float, default=0.0, help='AGV机器人膨胀半径(米)，如果不需要额外边界设为0')
    parser.add_argument('--zmin', type=float, default=0.0, help='截取的最低高度平面 Y/Z 值')
    parser.add_argument('--zmax', type=float, default=1.0, help='截取的最高高度平面 Y/Z 值')
    parser.add_argument('--out-dir', default='.', help='输出地图和预览图片的存放目录')
    
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    glb_path = os.path.join(script_dir, args.glb)
    
    print(f'>>> 开始读取解析点云: {glb_path}')
    points = load_glb_points_transformed(glb_path)
    
    # 自动推断高度轴（基于边界计算最小跨度的那根通常是天花板到地板的高度范围），但为了防止误判，
    # 3DGS或者模型摆正后通常 Y 轴是高度轴，所以我们默认映射: Height 轴转 Z。
    ranges = [points[:, i].max() - points[:, i].min() for i in range(3)]
    height_axis = int(np.argmin(ranges))
    axis_names = ['X轴', 'Y轴', 'Z轴']
    
    print(f'>>> 推算原始高度轴为 {axis_names[height_axis]}，范围: {ranges[height_axis]:.3f}米')

    # 转到标准 ROS2 地图坐标：让 Z 始终代表“提取的高度”
    # 在前端摆平模型后，通常 Y 是真实的高度轴。
    if height_axis == 1: # 原始是 Y 轴为高度
        tmp = np.empty_like(points)
        tmp[:, 0] = points[:, 0] # 地图 X
        tmp[:, 1] = points[:, 2] # 地图 Y
        tmp[:, 2] = points[:, 1] # 高度 Z
        points = tmp
    elif height_axis == 0: # 原始是 X 轴为高度
        tmp = np.empty_like(points)
        tmp[:, 0] = points[:, 1]
        tmp[:, 1] = points[:, 2]
        tmp[:, 2] = points[:, 0]
        points = tmp

    print(f'>>> 原点总顶点数: {points.shape[0]}')

    # 按照在数字孪生里框选的边界执行切片
    mask = (points[:, 2] >= args.zmin) & (points[:, 2] <= args.zmax)
    filtered = points[mask]
    
    if filtered.size == 0:
        print(f"!!! 警告: 在高度区间 [{args.zmin}, {args.zmax}] 内未能截取到任何障碍物点。地图将是一片空白。")
        return

    print(f'>>> 切片范围内保留特征点: {filtered.shape[0]} 个')

    x_min, y_min = float(filtered[:, 0].min()), float(filtered[:, 1].min())
    x_max, y_max = float(filtered[:, 0].max()), float(filtered[:, 1].max())
    res = args.resolution
    margin = int(args.margin)

    width = max(1, int(math.ceil((x_max - x_min) / res)) + 2 * margin)
    height = max(1, int(math.ceil((y_max - y_min) / res)) + 2 * margin)

    print(f'>>> 评估光栅边界 X:[{x_min:.2f}, {x_max:.2f}] Y:[{y_min:.2f}, {y_max:.2f}] -> 图像大小={width}x{height}')

    # 初始化 OpenCV 画布：254 表示无障碍区(Free)
    img = np.full((height, width), 254, dtype=np.uint8)
    
    xs = ((filtered[:, 0] - x_min) / res).astype(np.int32) + margin
    ys = ((filtered[:, 1] - y_min) / res).astype(np.int32) + margin
    
    xs = np.clip(xs, 0, width-1)
    ys = np.clip(ys, 0, height-1)
    
    # 0 表示障碍物(Occupied)
    img[ys, xs] = 0

    # 机器人体型膨胀（如果设置了膨胀半径）
    if args.robot_radius > 0:
        occ = (img == 0).astype(np.uint8) * 255
        k = max(1, int(math.ceil(args.robot_radius / res)))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k*2+1, k*2+1))
        inflated = cv2.dilate(occ, kernel, iterations=1)
        final = np.full_like(img, 254)
        final[inflated > 0] = 0
    else:
        final = img

    # 保存产出物
    os.makedirs(args.out_dir, exist_ok=True)
    pgm_path = os.path.join(args.out_dir, 'nav2_map.pgm')
    yaml_path = os.path.join(args.out_dir, 'nav2_map.yaml')
    preview_path = os.path.join(args.out_dir, 'nav2_map_preview.png')
    
    # 写入 PGM
    cv2.imwrite(pgm_path, final)
    
    # 写入 ROS2 标准 YAML 格式参数
    origin_x = x_min - margin * res
    origin_y = y_min - margin * res
    with open(yaml_path, 'w', encoding='utf-8') as f:
        f.write(f"image: nav2_map.pgm\nmode: trinary\nresolution: {res}\n"
                f"origin: [{origin_x:.6f}, {origin_y:.6f}, 0.0]\n"
                f"negate: 1\noccupied_thresh: 0.65\nfree_thresh: 0.196\n")

    # 写入预览 PNG（对普通相册颜色反转，使黑色底白色边便于观赏）
    base = cv2.cvtColor(255 - final, cv2.COLOR_GRAY2BGR)
    cv2.imwrite(preview_path, base)
    
    print(f'>>> 处理完成！已生如下核心路网文件：')
    print(f'    - 判定矩阵图: {pgm_path}')
    print(f'    - 位姿锚点:   {yaml_path}')
    print(f'    - 预览图:     {preview_path}')
    print('刷新前端数字孪生界面即可立即验证结果。')

if __name__ == '__main__':
    main()
