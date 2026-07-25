#!/usr/bin/env python3
"""
calib_capture.py — 从 cevs-server 视频流截取棋盘格标定照片

用法:
  python scripts/calib_capture.py

依赖:
  pip install opencv-python websocket-client numpy

操作:
  SPACE      保存当前帧到 captures/ 目录
  C          保存当前帧 (同上)
  Q / ESC    退出
  D          删除最后一张保存的照片

棋盘放在摄像头前,多角度拍 15~25 张:
  - 远近各几张
  - 倾斜(绕 X/Y 轴旋转 ~20°)
  - 棋盘填满画面不同区域(四个角+中心)

保存到 captures/ 目录,然后:
  python scripts/calib_from_files.py
"""

import sys
import os
import json
import time
import threading
from datetime import datetime

# ── 依赖检查 ──────────────────────────────────────────────────────
try:
    import cv2
    import numpy as np
except ImportError:
    print("[X] Need: pip install opencv-python numpy")
    sys.exit(1)

try:
    import websocket
except ImportError:
    print("[X] Need: pip install websocket-client")
    sys.exit(1)

# ── 配置 ──────────────────────────────────────────────────────────
WS_URL = "ws://localhost:8000/ws"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "captures")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── 全局状态 ──────────────────────────────────────────────────────
latest_frame = None
frame_lock = threading.Lock()
running = True
capture_count = 0


def on_message(ws, message):
    """WebSocket 消息回调: 二进制 = JPEG 帧; 文本 = JSON 消息"""
    global latest_frame
    if isinstance(message, bytes):
        with frame_lock:
            latest_frame = message
    else:
        try:
            msg = json.loads(message)
            if msg.get("type") == "video_subscribed":
                print("[WS] ✅ 视频订阅成功,等待帧数据...")
        except json.JSONDecodeError:
            pass


def on_error(ws, error):
    """WebSocket 错误回调"""
    print(f"[WS] ⚠️ 错误: {error}")
    global running
    running = False


def on_close(ws, close_status_code, close_msg):
    """WebSocket 关闭回调"""
    print(f"[WS] 连接关闭 (code={close_status_code})")
    global running
    running = False


def on_open(ws):
    """连接后订阅视频流"""
    print("[WS] ✅ 已连接,订阅视频流...")
    ws.send(json.dumps({"type": "subscribe_video"}))


def save_frame():
    """保存当前帧到 captures/"""
    global capture_count, latest_frame
    with frame_lock:
        if latest_frame is None:
            print("  ⚠️ 尚无帧数据到达")
            return
        frame_data = latest_frame

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    path = os.path.join(OUTPUT_DIR, f"chess_{timestamp}.jpg")
    with open(path, "wb") as f:
        f.write(frame_data)
    capture_count += 1
    print(f"  ✅ [{capture_count}] 已保存: {os.path.basename(path)} ({len(frame_data)//1024}KB)")


def delete_last():
    """删除 captures/ 目录下最后一张照片"""
    files = sorted([f for f in os.listdir(OUTPUT_DIR) if f.endswith(".jpg")])
    if not files:
        print("  ⚠️ 没有照片可删除")
        return
    last = os.path.join(OUTPUT_DIR, files[-1])
    os.remove(last)
    print(f"  🗑️ 已删除: {files[-1]}")


def keyboard_loop():
    """键盘输入线程: 非阻塞监听"""
    global running
    print("\n🎯 按 SPACE 保存 | D 删除上一张 | Q 退出\n")
    import msvcrt

    while running:
        if msvcrt.kbhit():
            key = msvcrt.getch().lower()
            if key in (b" ", b"c"):
                save_frame()
            elif key == b"d":
                delete_last()
            elif key == b"q" or key == b"\x1b":  # q 或 ESC
                running = False
                print("\n[退出] 正在关闭...")
        time.sleep(0.05)


# ── 主函数 ──────────────────────────────────────────────────────────
def main():
    # 启键盘线程
    kb_thread = threading.Thread(target=keyboard_loop, daemon=True)
    kb_thread.start()

    # 连接 WebSocket
    ws = websocket.WebSocketApp(
        WS_URL,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )

    print(f"\n📷 棋盘格标定照片采集工具")
    print(f"   {WS_URL}")
    print(f"   保存目录: {OUTPUT_DIR}")
    print(f"   已存在 {len([f for f in os.listdir(OUTPUT_DIR) if f.endswith('.jpg')])} 张照片\n")

    # 运行 WebSocket (阻塞)
    ws.run_forever()

    # 退出
    total = len([f for f in os.listdir(OUTPUT_DIR) if f.endswith(".jpg")])
    print(f"\n📊 共保存 {total} 张照片到 {OUTPUT_DIR}")
    if total >= 12:
        print("   ✅ 建议运行标定: python scripts/calib_from_files.py")
    else:
        print(f"   ⚠️ 至少 12 张效果才好,现有 {total} 张")


if __name__ == "__main__":
    main()
