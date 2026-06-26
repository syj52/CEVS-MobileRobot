#!/usr/bin/env python3
"""
hloc + COLMAP CLI：对 corridor 视频帧做 SfM 三维重建并导出相机位姿。
"""
import sys, os, json, subprocess
sys.path.insert(0, '/home/ljq/hloc/Hierarchical-Localization/')
from pathlib import Path
from hloc import extract_features, match_features, reconstruction, visualization
import pycolmap

IMG  = Path('/home/ljq/video_input/corridor')
OUT  = Path('/home/ljq/video_input/corridor_hloc')
OUT.mkdir(parents=True, exist_ok=True)

# 1. SuperPoint 特征
print('[1/5] SuperPoint...')
feat_dir = OUT / 'feats'
extract_features.main(extract_features.confs['superpoint_aachen'], IMG, feat_dir)
feat_path = next(feat_dir.glob('*.h5'))
print(f'  ➜ {feat_path}')

# 2. 滑动窗口匹配对
print('[2/5] 匹配对 (window=5)...')
imgs = sorted(p.name for p in IMG.iterdir() if p.suffix.lower() in ('.jpg','.png'))
n, w = len(imgs), 5
pair_path = OUT / 'pairs.txt'
pairs = set()
for i in range(n):
    for j in range(max(0,i-w), min(n,i+w+1)):
        if i!=j: pairs.add((imgs[i],imgs[j]) if imgs[i]<imgs[j] else (imgs[j],imgs[i]))
with open(pair_path, 'w') as f:
    for a,b in sorted(pairs): f.write(f'{a} {b}\n')
print(f'  {len(pairs)} 对')

# 3. SuperGlue 匹配
print('[3/5] SuperGlue...')
match_path = OUT / 'matches.h5'
match_features.main(match_features.confs['superglue'], pair_path, feat_path, matches=match_path)

# 4. 创建 COLMAP 数据库、导入特征
print('[4/5] COLMAP 数据库 + 导入...')
sfm_dir = OUT / 'sfm'
sfm_dir.mkdir(parents=True, exist_ok=True)
db_path = sfm_dir / 'database.db'

# 用 COLMAP CLI 创建空数据库 & 导入图片信息
subprocess.run(['colmap', 'database_creator', '--database_path', str(db_path)], check=True, capture_output=True)
subprocess.run([
    'colmap', 'feature_extractor',
    '--database_path', str(db_path),
    '--image_path', str(IMG),
    '--ImageReader.single_camera', '1',
    '--SiftExtraction.use_gpu', '0',
    '--ImageReader.camera_model', 'OPENCV',
], check=True, capture_output=True)

# 覆盖导入 SuperPoint 特征 + SuperGlue 匹配（替换 feature_extractor 产生的 SIFT）
reconstruction.import_features(imgs, db_path, feat_path)
reconstruction.import_matches(imgs, pair_path, db_path, feat_path, match_path, 0.0, False)
reconstruction.estimation_and_geometric_verification(db_path, pair_path, feat_path, match_path, True)

# 5. SfM
print('[5/5] SfM...')
model = pycolmap.incremental_mapping(db_path, sfm_dir)
if isinstance(model, tuple): model = model[0]
assert model and model.num_reg_images() > 0

print(f'  ✓ {model.num_reg_images()}/{n} 注册, {model.num_points3D()} 点')

poses = {}
for id_, img in model.images.items():
    cam = model.cameras[img.camera_id]
    poses[img.name] = {
        'id': id_, 'camera_id': img.camera_id,
        'quaternion': list(cam.cam_from_world.rotation.quat),
        'translation': list(cam.cam_from_world.translation),
    }
json.dump(poses, open(OUT/'poses.json', 'w'), indent=2)
print(f'  ➜ {OUT}/poses.json ({len(poses)} 张)')

visualization.visualize_sfm(model, str(OUT/'reconstruction.html'), image_dir=str(IMG))
print(f'  ➜ {OUT}/reconstruction.html')
print('完成!')
