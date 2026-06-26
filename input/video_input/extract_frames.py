import cv2
import os
import argparse
from pathlib import Path

def extract_frames(video_path, target_fps=1, target_size=518):
    # 1. 路径准备
    video_path = Path(video_path)
    output_dir = video_path.parent / video_path.stem
    os.makedirs(output_dir, exist_ok=True)
    
    # 2. 打开视频
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"无法打开视频: {video_path}")
        return

    # 3. 计算采样步长 (Stride)
    native_fps = cap.get(cv2.CAP_PROP_FPS)
    stride = max(1, int(round(native_fps / target_fps)))
    
    print(f"视频原始 FPS: {native_fps:.2f}")
    print(f"目标每秒提取: {target_fps} 帧")
    print(f"计算采样步长: 每 {stride} 帧取一帧")
    print(f"输出目录: {output_dir}")

    count = 0
    saved_count = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        # 每隔 stride 帧保存一次
        if count % stride == 0:
            # 缩放图片（可选，为了兼容 LingBot-Map 默认分辨率）
            if target_size:
                frame = cv2.resize(frame, (target_size, target_size))
            
            # 保存图片，命名格式 000001.jpg
            save_path = output_dir / f"{saved_count:06d}.jpg"
            cv2.imwrite(str(save_path), frame)
            saved_count += 1
            
            if saved_count % 10 == 0:
                print(f"已提取 {saved_count} 帧...", end='\r')
        
        count += 1

    cap.release()
    print(f"\n提取完成！共保存 {saved_count} 帧到 {output_dir}")

if __name__ == "__main__":
    # 你可以直接在这里修改视频路径
    path = "/home/ljq/video_input/gaigokugo_kouen.mp4"
    extract_frames(path, target_fps=4, target_size=518)