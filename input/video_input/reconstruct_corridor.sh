#!/usr/bin/env bash
set -e

IMG_DIR="/home/ljq/video_input/corridor"
OUT_DIR="/home/ljq/video_input/corridor_output"
SFM_DIR="$OUT_DIR/sfm"
DB="$SFM_DIR/database.db"

mkdir -p "$SFM_DIR"
rm -f "$DB"

echo "[1/5] 创建 COLMAP 数据库..."
colmap database_creator --database_path "$DB"

echo "[2/5] 特征提取 (SIFT)..."
colmap feature_extractor \
    --database_path "$DB" \
    --image_path "$IMG_DIR" \
    --ImageReader.camera_model OPENCV \
    --ImageReader.single_camera 1 \
    --SiftExtraction.use_gpu 0 \
    --SiftExtraction.num_threads 8

echo "[3/5] 特征匹配 (sequential)..."
colmap sequential_matcher \
    --database_path "$DB" \
    --SiftMatching.use_gpu 0 \
    --SequentialMatching.overlap 7

echo "[4/5] 增量式 SfM..."
colmap mapper \
    --database_path "$DB" \
    --image_path "$IMG_DIR" \
    --output_path "$SFM_DIR"

# 找到重建结果
MODEL_DIR=$(find "$SFM_DIR" -name "0" -type d | head -1)
if [ -z "$MODEL_DIR" ]; then
    echo "SfM 失败，未找到重建模型"
    exit 1
fi

echo "[5/5] 导出..."
# 导出为 PLY
colmap model_converter \
    --input_path "$MODEL_DIR" \
    --output_path "$OUT_DIR/sparse.ply" \
    --output_type PLY

# 导出相机位姿文本
colmap model_converter \
    --input_path "$MODEL_DIR" \
    --output_path "$OUT_DIR/pose" \
    --output_type TXT

echo ""
echo "=== 结果 ==="
echo "点云: $OUT_DIR/sparse.ply"
echo "位姿: $OUT_DIR/pose/ (images.txt, cameras.txt, points3D.txt)"
N_IMG=$(grep -c "^[0-9]" "$OUT_DIR/pose/images.txt" 2>/dev/null || echo "?")
echo "注册图片数: $N_IMG"
echo ""
echo "完成!"
