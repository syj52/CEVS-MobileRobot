#!/usr/bin/env python3
"""
calib_from_files.py — 从棋盘格照片标定相机内参+畸变系数

用法:
  python scripts/calib_from_files.py
  python scripts/calib_from_files.py --captures captures/ --output config/camera.json

前置:
  先用 calib_capture.py 采集 15~25 张棋盘格照片

依赖:
  pip install opencv-python numpy

输出:
  写入 camera.json  (相机内参 + 畸变系数,被 cevs-server 读取)
  同时打印校正前后对比图 (按任意键关闭)
"""

import sys
import os
import json
import glob
import argparse

try:
    import cv2
    import numpy as np
except ImportError:
    print("[X] Need: pip install opencv-python numpy")
    sys.exit(1)


def find_images(capture_dir):
    """返回目录下所有 jpg/jpeg/png 图片路径 (排序, 去重)"""
    exts = ["*.jpg", "*.jpeg", "*.png"]
    files = set()
    for ext in exts:
        for f in glob.glob(os.path.join(capture_dir, ext)):
            files.add(f.lower() if os.name == 'nt' else f)
    # 统一用小写路径去重后,还原回真实文件名
    seen = set()
    unique = []
    for f in sorted(glob.glob(os.path.join(capture_dir, "*"))):
        key = f.lower() if os.name == 'nt' else f
        if key not in seen and f.lower().endswith(('.jpg', '.jpeg', '.png')):
            seen.add(key)
            unique.append(f)
    return unique


def check_files(files):
    """打印文件列表,确认存在且可读"""
    print(f"找到 {len(files)} 张图片:")
    for f in files:
        print(f"  {os.path.basename(f)}")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="从棋盘格照片标定相机内参+畸变系数",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--captures",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "captures"),
        help="棋盘格照片目录 (默认 ../captures)",
    )
    parser.add_argument(
        "--output",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "camera.json"),
        help="输出路径 (默认 ../config/camera.json)",
    )
    parser.add_argument(
        "--rows", type=int, default=6, help="内角点行数 (默认 6)"
    )
    parser.add_argument(
        "--cols", type=int, default=9, help="内角点列数 (默认 9)"
    )
    parser.add_argument(
        "--square", type=float, default=25.0, help="棋盘格方格尺寸 mm (默认 25)"
    )
    parser.add_argument(
        "--tag-size", type=float, default=168.0,
        help="AprilTag 边长 mm, 写入 camera.json 备用 (默认 168)"
    )
    parser.add_argument(
        "--fix-k3", action="store_true",
        help="固定 k3=0,防止高次畸变过拟合 (屏幕显示棋盘推荐)"
    )
    args = parser.parse_args()

    pattern = (args.cols, args.rows)

    # ── 1. 加载图片 ────────────────────────────────────────────────
    files = find_images(args.captures)
    if not files:
        print(f"[X] 目录 '{args.captures}' 中没有找到图片")
        print("    先用 calib_capture.py 采集棋盘格照片")
        sys.exit(1)

    # 按图片数量过滤: 至少要足够覆盖棋盘
    check_files(files)
    if len(files) < 6:
        print(f"[X] 至少需要 6 张,现有 {len(files)} 张,继续采集")
        sys.exit(1)

    # ── 2. 准备世界坐标点 ─────────────────────────────────────────
    objp = np.zeros((args.rows * args.cols, 3), np.float32)
    objp[:, :2] = np.mgrid[0:args.cols, 0:args.rows].T.reshape(-1, 2)
    square_m = args.square / 1000.0
    objp *= square_m  # 世界坐标: 米

    objpoints = []  # 世界 3D 点 (每张棋盘一张)
    imgpoints = []  # 图片 2D 角点 (每张棋盘一张)
    img_size = None
    valid_files = []
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)

    # ── 3. 逐图查找棋盘角点 ────────────────────────────────────────
    print("检测棋盘格角点...")
    for path in files:
        img = cv2.imread(path)
        if img is None:
            print(f"  ⚠️ 无法读取: {os.path.basename(path)}")
            continue
        if img_size is None:
            img_size = (img.shape[1], img.shape[0])
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        found, corners = cv2.findChessboardCorners(
            gray, pattern,
            cv2.CALIB_CB_ADAPTIVE_THRESH + cv2.CALIB_CB_NORMALIZE_IMAGE
        )

        if found:
            corners_refined = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)
            objpoints.append(objp.copy())
            imgpoints.append(corners_refined)
            valid_files.append(path)
            print(f"  ✅ {os.path.basename(path)} — 检测到棋盘")
        else:
            print(f"  ❌ {os.path.basename(path)} — 未检测到棋盘(跳过)")

    print(f"\n有效图片: {len(valid_files)}/{len(files)}")
    if len(valid_files) < 6:
        print("[X] 有效图片不足 6 张,重新采集")
        sys.exit(1)
    if len(valid_files) < 12:
        print(f"[!] 只有 {len(valid_files)} 张,建议至少 12 张以提高精度")

    # ── 4. 运行标定 ────────────────────────────────────────────────
    print("\n标定中...")
    # 屏幕棋盘推荐 --fix-k3,防止高阶畸变过拟合
    calib_flags = 0
    if args.fix_k3:
        calib_flags |= cv2.CALIB_FIX_K3
        print("  [使用 CALIB_FIX_K3 — k3 固定为 0]")
    rms, K, dist, rvecs, tvecs = cv2.calibrateCamera(
        objpoints, imgpoints, img_size, None, None, flags=calib_flags
    )

    # ── 5. 逐图重投影误差 ──────────────────────────────────────────
    total_err = 0
    for i in range(len(objpoints)):
        proj, _ = cv2.projectPoints(objpoints[i], rvecs[i], tvecs[i], K, dist)
        err = cv2.norm(imgpoints[i], proj, cv2.NORM_L2) / len(proj)
        total_err += err
    mean_err = total_err / len(objpoints)

    dist_flat = dist.flatten()
    print(f"\n╔════════════════════════════════════════════════╗")
    print(f"║  标定结果                                      ║")
    print(f"╠════════════════════════════════════════════════╣")
    print(f"║  RMS 重投影误差: {rms:.4f} px   {'✅ 优秀' if rms < 1.0 else '⚠️ 一般' if rms < 2.0 else '❌ 差'}         ║")
    print(f"║  平均重投影误差: {mean_err:.4f} px                         ║")
    print(f"║  有效图片数:    {len(valid_files)}                               ║")
    print(f"║  图片分辨率:    {img_size[0]}×{img_size[1]}                            ║")
    print(f"╠════════════════════════════════════════════════╣")
    print(f"║  相机内参矩阵 K:                                 ║")
    print(f"║    fx = {K[0,0]:.2f}                                        ║")
    print(f"║    fy = {K[1,1]:.2f}                                        ║")
    print(f"║    cx = {K[0,2]:.2f}                                        ║")
    print(f"║    cy = {K[1,2]:.2f}                                        ║")
    print(f"╠════════════════════════════════════════════════╣")
    print(f"║  畸变系数 (共 {len(dist_flat)} 个):                          ║")
    dist_labels = ["k1", "k2", "p1", "p2", "k3"]
    for i in range(len(dist_flat)):
        label = dist_labels[i] if i < len(dist_labels) else f"d{i}"
        print(f"║    {label} = {dist_flat[i]:.6f}                                    ║")
    print(f"╚════════════════════════════════════════════════╝")

    if rms >= 2.0:
        print("\n⚠️ RMS 误差较大,建议重新采集:")
        print("   1. 让棋盘占画面 1/4 ~ 1/2")
        print("   2. 多变换角度: 倾斜 ~20°、远近不同、填满画面不同区域")
        print("   3. 去除模糊的照片")

    # ── 6. 保存 camera.json ────────────────────────────────────────
    output_dir = os.path.dirname(args.output)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    calib_data = {
        "fx": round(K[0, 0], 2),
        "fy": round(K[1, 1], 2),
        "cx": round(K[0, 2], 2),
        "cy": round(K[1, 2], 2),
        "tag_size_m": args.tag_size / 1000.0,
        # 完整数据也留着,供 Python 脚本直接使用
        "camera_matrix": K.tolist(),
        "dist_coeffs": dist_flat.tolist(),
        "image_size": list(img_size),
        "rms_error": round(rms, 4),
        "num_views": len(valid_files),
        "board": {
            "cols": args.cols,
            "rows": args.rows,
            "square_mm": args.square,
        },
    }

    with open(args.output, "w") as f:
        json.dump(calib_data, f, indent=2)
    print(f"\n✅ 已保存: {args.output}")

    # ── 7. 显示校正前后对比 ─────────────────────────────────────
    print("\n按任意键查看去畸变前后对比 (对比图窗口,ESC 跳过)...")
    # 选一张有棋盘的照片做对比
    sample = cv2.imread(valid_files[len(valid_files) // 2])
    if sample is not None:
        h, w = sample.shape[:2]
        # cv2.undistort 用标定结果校正
        mapx, mapy = cv2.initUndistortRectifyMap(
            K, dist, None, K, (w, h), cv2.CV_32FC1
        )
        undistorted = cv2.remap(sample, mapx, mapy, cv2.INTER_LINEAR)

        # 并排显示: 原始 | 校正后
        h_show = 360
        scale = h_show / h
        w_show = int(w * scale)
        small_orig = cv2.resize(sample, (w_show, h_show))
        small_undist = cv2.resize(undistorted, (w_show, h_show))

        # 在畸变图上画棋盘角点
        gray = cv2.cvtColor(sample, cv2.COLOR_BGR2GRAY)
        found, corners = cv2.findChessboardCorners(gray, pattern)
        if found:
            cv2.drawChessboardCorners(small_orig, pattern,
                                      corners.reshape(-1, 2) * scale, found)

        canvas = np.hstack([small_orig, small_undist])
        cv2.putText(canvas, "Original (with distortion)", (10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
        cv2.putText(canvas, "Undistorted (corrected)", (w_show + 10, 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

        cv2.imshow("Calibration Result: Left=Original  Right=Undistorted", canvas)
        print("  对比图已打开,按任意键关闭")
        cv2.waitKey(0)
        cv2.destroyAllWindows()

    print("\n下一步: 确保 detect_apriltags.py 用 OpenCV Aruco + solvePnP 读取 camera.json")
    print("  参考: E:\\else\\03_3D_Graphics\\apriltag_test\\detect_pose.py 的做法")


if __name__ == "__main__":
    main()
