#!/usr/bin/env python3
"""
NetVLAD 图像检索测试：
1. 提取 corridor 所有图片的 NetVLAD 全局特征
2. 输入一张查询图，检索最相似的 Top-K 帧
3. 输出匹配结果和相似度分数
"""
import sys, os, json
sys.path.insert(0, '/home/ljq/hloc/Hierarchical-Localization/')
from pathlib import Path

import numpy as np
import h5py
from hloc import extract_features

CORRIDOR = Path('/home/ljq/video_input/corridor')
OUT      = Path('/home/ljq/video_input/corridor_retrieval')
OUT.mkdir(parents=True, exist_ok=True)

# ─── 1. 提取 NetVLAD 全局特征（如果已存在则跳过） ───
feat_dir = OUT / 'netvlad'
if not (feat_dir / 'global-feats-netvlad.h5').exists():
    print('[1/2] 提取 NetVLAD 全局特征...')
    extract_features.main(extract_features.confs['netvlad'], CORRIDOR, feat_dir)
    print(f'  → {feat_dir}')
else:
    print('[1/2] NetVLAD 特征已存在，跳过')

feat_path = feat_dir / 'global-feats-netvlad.h5'

# ─── 2. 读取特征，构建检索库 ───
print('[2/2] 加载特征 + 测试检索...')
with h5py.File(feat_path, 'r') as f:
    names = list(f.keys())
    print(f'  数据库: {len(names)} 张图片')

    # 读取所有全局描述子
    descs = []
    for name in names:
        grp = f[name]
        # NetVLAD 输出在 'global_descriptor' 下
        if 'global_descriptor' in grp:
            desc = grp['global_descriptor'][:]
        else:
            desc = grp[list(grp.keys())[0]][:]
        descs.append(desc.flatten())
    descs = np.array(descs)
    print(f'  描述子维度: {descs.shape[1]}')
    print(f'  描述子矩阵: {descs.shape}')

    # L2 归一化
    descs = descs / (np.linalg.norm(descs, axis=1, keepdims=True) + 1e-10)

    # ─── 3. 测试：用第 1 张、第 35 张、第 69 张作为查询 ───
    query_indices = [0, 34, 69]
    for qi in query_indices:
        q_name = names[qi]
        q_desc = descs[qi:qi+1]

        # 余弦相似度（等价于 L2 归一化后的点积）
        sim = descs @ q_desc.T  # shape (N, 1)
        sim = sim.flatten()

        # 排除自己，按相似度降序
        order = np.argsort(-sim)
        order = [i for i in order if i != qi]

        print(f'\n  ── 查询: {q_name} ──')
        for rank, idx in enumerate(order[:5]):
            print(f'    [{rank+1}] {names[idx]:20s}  sim={sim[idx]:.4f}')
    print('\n  检索测试完成!')
