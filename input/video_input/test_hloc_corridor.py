#!/usr/bin/env python3
"""hloc SfM 测试：对 corridor 图片重建稀疏三维点云 + 相机位姿"""
import sys, os, json
sys.path.insert(0, '/home/ljq/hloc/Hierarchical-Localization/')

from pathlib import Path
from hloc import extract_features, match_features, pairs_from_retrieval, reconstruction
from hloc.utils import io as hloc_io

IMG_DIR = '/home/ljq/video_input/corridor'
OUT     = '/home/ljq/video_input/corridor_hloc'
os.makedirs(OUT, exist_ok=True)

# 1. 特征提取
print('[1/4] SuperPoint 特征...')
feat_path = os.path.join(OUT, 'feats.h5')
extract_features.main(extract_features.confs['superpoint_aachen'], IMG_DIR, feat_path)

# 2. 图片检索 & 匹配
print('[2/4] 图片检索 + SuperGlue...')
pair_path = os.path.join(OUT, 'pairs.txt')
pairs_from_retrieval.main(feat_path, pair_path, 10)
match_path = os.path.join(OUT, 'matches.h5')
match_features.main(match_features.confs['superglue'], pair_path, feat_path, match_path)

# 3. SfM
print('[3/4] SfM 重建...')
sfm_dir = os.path.join(OUT, 'sfm')
model = reconstruction.main(
    sfm_dir, IMG_DIR, pair_path, feat_path, match_path,
    image_options={'single_camera_mode': True},
)
assert model and model.num_reg_images() > 0, 'SfM 失败'
print(f'  注册 {model.num_reg_images()}/70 张, {model.num_points3D()} 三维点')

# 4. 导出位姿
print('[4/4] 导出位姿...')
poses = {}
for id_, img in model.images.items():
    cam = model.cameras[img.camera_id]
    q = cam.cam_from_world.rotation.quat
    t = cam.cam_from_world.translation
    poses[img.name] = {'id': id_, 'quaternion': list(q), 'translation': list(t)}

json.dump(poses, open(f'{OUT}/poses.json', 'w'), indent=2)
print(f'  {len(poses)} 张 → {OUT}/poses.json')

# 可视化
from hloc import visualization
visualization.visualize_sfm(model, f'{OUT}/reconstruction.html', image_dir=IMG_DIR)
print(f'  可视化 → {OUT}/reconstruction.html')
print('完成!')
