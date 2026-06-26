#!/usr/bin/env bash
# ===========================================================================
# LingBot-MAP 统一启动脚本
# 用法: ./run.sh --mode live --video input/CA.mp4 --quality balanced
# ===========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LINGBOT_DIR="$HOME/lingbot_map/LingBot-Map"
CONFIG_FILE="$SCRIPT_DIR/config/profiles.yaml"

# ---------- 默认值 ----------
MODE="live"
VIDEO=""
IMAGE=""
FPS="5"
QUALITY="balanced"
PORT="8080"
WS_PORT="9091"
FIRST_K=""
MASK_SKY=""

# ---------- 解析参数 ----------
usage() {
    cat <<EOF
用法: $0 [选项]

选项:
  --mode MODE       运行模式: live (viser), ws (websocket), batch (一次性)
                    默认: live
  --video PATH      输入视频路径
  --image PATH      输入图片文件夹路径 (与 --video 二选一)
  --fps N           视频抽帧率 (默认: 5)
  --quality Q       质量预设: performance, balanced, quality (默认: balanced)
  --port N          Viser 端口 (默认: 8080)
  --ws_port N       WebSocket 端口 (默认: 9091, 仅 ws 模式)
  --first_k N       只处理前 N 帧 (调试用)
  --mask_sky        启用天空过滤 (室外场景)

示例:
  $0 --mode live --video input/CA.mp4
  $0 --mode ws --video input/CA.mp4 --quality performance
  $0 --mode batch --image input/courthouse/ --quality quality
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)     MODE="$2"; shift 2 ;;
        --video)    VIDEO="$2"; shift 2 ;;
        --image)    IMAGE="$2"; shift 2 ;;
        --fps)      FPS="$2"; shift 2 ;;
        --quality)  QUALITY="$2"; shift 2 ;;
        --port)     PORT="$2"; shift 2 ;;
        --ws_port)  WS_PORT="$2"; shift 2 ;;
        --first_k)  FIRST_K="$2"; shift 2 ;;
        --mask_sky) MASK_SKY="--mask_sky"; shift ;;
        -h|--help)  usage ;;
        *) echo "未知参数: $1"; usage ;;
    esac
done

# ---------- 校验 ----------
if [[ -z "$VIDEO" && -z "$IMAGE" ]]; then
    echo "❌ 请指定 --video 或 --image"
    usage
fi
if [[ "$MODE" != "live" && "$MODE" != "ws" && "$MODE" != "batch" ]]; then
    echo "❌ 无效 mode: $MODE (可选: live, ws, batch)"
    usage
fi

# ---------- 解析质量预设 ----------
case "$QUALITY" in
    performance)
        NUM_SCALE=2; SLIDING_WIN=20; KF_INTERVAL=2; CAM_ITER=1; DOWNSAMPLE=20 ;;
    balanced)
        NUM_SCALE=2; SLIDING_WIN=20; KF_INTERVAL=2; CAM_ITER=2; DOWNSAMPLE=15 ;;
    quality)
        NUM_SCALE=4; SLIDING_WIN=20; KF_INTERVAL=1; CAM_ITER=2; DOWNSAMPLE=10 ;;
    *)
        echo "❌ 无效 quality: $QUALITY (可选: performance, balanced, quality)"
        usage ;;
esac

# ---------- 构建输入参数 ----------
INPUT_ARGS=""
if [[ -n "$VIDEO" ]]; then
    # 支持绝对路径和相对路径
    if [[ "$VIDEO" = /* ]]; then
        INPUT_ARGS="--video_path \"$VIDEO\""
    else
        INPUT_ARGS="--video_path \"$SCRIPT_DIR/$VIDEO\""
    fi
else
    if [[ "$IMAGE" = /* ]]; then
        INPUT_ARGS="--image_folder \"$IMAGE\""
    else
        INPUT_ARGS="--image_folder \"$SCRIPT_DIR/$IMAGE\""
    fi
fi

BASE_ARGS="--model_path \"$LINGBOT_DIR/weights/lingbot-map-long.pt\" \
           --fps $FPS \
           --num_scale_frames $NUM_SCALE \
           --kv_cache_sliding_window $SLIDING_WIN \
           --keyframe_interval $KF_INTERVAL \
           --camera_num_iterations $CAM_ITER \
           --use_sdpa --offload_to_cpu \
           $MASK_SKY"

if [[ -n "$FIRST_K" ]]; then
    BASE_ARGS="$BASE_ARGS --first_k $FIRST_K"
fi

# ---------- 输出目录 ----------
OUTPUT_DIR="$SCRIPT_DIR/output/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTPUT_DIR"

# ---------- 运行 ----------
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  LingBot-MAP"
echo "  模式:      $MODE"
echo "  品质预设:  $QUALITY"
echo "  输入:      ${VIDEO:-$IMAGE}"
echo "  输出:      $OUTPUT_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$LINGBOT_DIR"

case "$MODE" in
    live)
        echo "启动实时建图 (viser) — http://localhost:$PORT"
        echo "按 Ctrl+C 停止"
        echo ""
        eval python demo_live.py \
            $INPUT_ARGS \
            $BASE_ARGS \
            --port $PORT \
            --downsample_factor $DOWNSAMPLE 2>&1 | tee "$OUTPUT_DIR/log.txt"
        ;;
    ws)
        echo "启动 WebSocket 桥接 — ws://0.0.0.0:$WS_PORT"
        echo "配合前端 web/agv-digital-twin 使用"
        echo "按 Ctrl+C 停止"
        echo ""
        eval python demo_live_ws.py \
            $INPUT_ARGS \
            $BASE_ARGS \
            --downsample_factor $DOWNSAMPLE \
            --ws_port $WS_PORT 2>&1 | tee "$OUTPUT_DIR/log.txt"
        ;;
    batch)
        echo "启动批量推理 — 完成后打开 http://localhost:$PORT"
        echo ""
        eval python demo.py \
            $INPUT_ARGS \
            $BASE_ARGS \
            --port $PORT \
            --downsample_factor $DOWNSAMPLE 2>&1 | tee "$OUTPUT_DIR/log.txt"
        ;;
esac

echo "日志已保存: $OUTPUT_DIR/log.txt"
