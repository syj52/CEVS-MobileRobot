#!/usr/bin/env python3
"""
detect_apriltags.py — AprilTag detection + pose estimation (OpenCV solvePnP)

Reads JPEG frames from stdin (4-byte LE length prefix per frame),
detects tag36h11 tags, computes camera-relative pose with calibrated
camera intrinsics + distortion, outputs JSON per frame to stdout.

Input:  [4-byte LE length][JPEG data]
Output: {"tags":[...], "frame_size":N}

Uses OpenCV Aruco detector + solvePnP with distortion coefficients from
camera.json, unlike pupil_apriltags which cannot handle lens distortion.
"""

import sys
import json
import os
import struct
import math
import numpy as np

# ─── Camera intrinsics + distortion from calibration ──────────────────
CONFIG_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "config", "camera.json"
)
CAM_K = None       # 3×3 camera matrix
CAM_DIST = None    # distortion coefficients
TAG_SIZE_M = 0.168
CEILING_H_M = 2.8    # 天花板高度（m），用于稳定垂直摄像头 Z 轴估计
CAM_H_M = 0.2        # 摄像头安装高度（m）

defaults = {"fx": 1800, "fy": 1700, "cx": 640, "cy": 360, "tag_size_m": 0.168}
if os.path.exists(CONFIG_FILE):
    try:
        cfg = json.load(open(CONFIG_FILE))
        fx = cfg.get("fx", defaults["fx"])
        fy = cfg.get("fy", defaults["fy"])
        cx = cfg.get("cx", defaults["cx"])
        cy = cfg.get("cy", defaults["cy"])
        TAG_SIZE_M = cfg.get("tag_size_m", defaults["tag_size_m"])

        if "camera_matrix" in cfg:
            CAM_K = np.array(cfg["camera_matrix"], dtype=np.float64)
        else:
            CAM_K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)

        if "dist_coeffs" in cfg and len(cfg["dist_coeffs"]) > 0:
            CAM_DIST = np.array(cfg["dist_coeffs"], dtype=np.float64).reshape(-1, 1)
        else:
            CAM_DIST = np.zeros((5, 1), dtype=np.float64)

        CEILING_H_M = cfg.get("ceiling_height_m", CEILING_H_M)
        CAM_H_M = cfg.get("camera_height_m", CAM_H_M)
        sys.stderr.write(
            f"[camera] Calibrated: fx={CAM_K[0,0]:.0f} fy={CAM_K[1,1]:.0f} "
            f"dist={len(CAM_DIST)} coeffs, tag={TAG_SIZE_M*1000:.0f}mm\n"
        )
    except Exception as e:
        sys.stderr.write(f"[camera] Config error: {e}\n")
        CAM_K = np.array(
            [[defaults["fx"], 0, defaults["cx"]],
             [0, defaults["fy"], defaults["cy"]],
             [0, 0, 1]], dtype=np.float64
        )
        CAM_DIST = np.zeros((5, 1), dtype=np.float64)
else:
    CAM_K = np.array(
        [[defaults["fx"], 0, defaults["cx"]],
         [0, defaults["fy"], defaults["cy"]],
         [0, 0, 1]], dtype=np.float64
    )
    CAM_DIST = np.zeros((5, 1), dtype=np.float64)
    sys.stderr.write("[camera] No config file — using defaults\n")

# ─── Attempt to load OpenCV Aruco detector ────────────────────────────
try:
    import cv2
except ImportError:
    sys.stderr.write("[X] Need: pip install opencv-python numpy\n")
    sys.exit(1)

DETECTOR = None
try:
    dic = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_APRILTAG
    # ── 光照鲁棒性调优 ──
    params.adaptiveThreshWinSizeMin = 3      # 最小窗口（默认 3）
    params.adaptiveThreshWinSizeMax = 23     # 最大窗口（默认 23）
    params.adaptiveThreshWinSizeStep = 5     # 步长（默认 10）
    params.adaptiveThreshConstant = 7        # 阈值常数，找暗处 tag（默认 7）
    params.minMarkerPerimeterRate = 0.04     # 允许更小的标记（默认 0.05）
    params.maxMarkerPerimeterRate = 0.50     # （默认 0.50）
    DETECTOR = cv2.aruco.ArucoDetector(dic, params)
except AttributeError:
    try:
        # Older OpenCV API fallback
        dic = cv2.aruco.Dictionary_get(cv2.aruco.DICT_APRILTAG_36h11)
        params = cv2.aruco.DetectorParameters_create()
        DETECTOR = (dic, params)
    except Exception as e:
        sys.stderr.write(f"[X] OpenCV Aruco not available: {e}\n")
        sys.stderr.write("    pip uninstall opencv-python-headless && pip install opencv-python\n")
        sys.exit(1)


def compute_yaw(R):
    """Yaw (z-axis rotation) from 3×3 rotation matrix, in degrees."""
    if R is None:
        return 0.0
    return math.degrees(math.atan2(R[1, 0], R[0, 0]))


def detect_tags(jpeg_bytes):
    """Decode JPEG, detect tags, estimate pose with solvePnP."""
    nparr = np.frombuffer(jpeg_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return []  # bad frame

    # ── 光照预处理：CLAHE 解决天花板灯太亮导致 tag 过曝的问题 ──
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    img = clahe.apply(img)

    # Detect
    if isinstance(DETECTOR, tuple):
        # Old API fallback
        corners, ids, _ = cv2.aruco.detectMarkers(img, DETECTOR[0], parameters=DETECTOR[1])
    else:
        corners, ids, _ = DETECTOR.detectMarkers(img)

    if ids is None or len(ids) == 0:
        return []

    # Object points: tag corners in tag frame (square, Z=0)
    hs = TAG_SIZE_M / 2.0
    obj_pts = np.array([
        [-hs,  hs, 0],
        [ hs,  hs, 0],
        [ hs, -hs, 0],
        [-hs, -hs, 0],
    ], dtype=np.float64)

    tags = []
    for i in range(len(ids)):
        tag_id = int(ids[i][0])
        c = corners[i]
        img_pts = c.reshape(-1, 2).astype(np.float64) if c.ndim == 3 else c.astype(np.float64)

        # solvePnP with IPPE_SQUARE (handles planar ambiguity for square tags)
        try:
            ok, rvec, tvec = cv2.solvePnP(
                obj_pts, img_pts, CAM_K, CAM_DIST,
                flags=cv2.SOLVEPNP_IPPE_SQUARE
            )
        except Exception:
            ok = False

        if not ok:
            # Fallback to standard iterative solver
            ok, rvec, tvec = cv2.solvePnP(obj_pts, img_pts, CAM_K, CAM_DIST)
        if not ok:
            continue

        rvec = rvec.reshape(3, 1)
        tvec = tvec.reshape(3, 1)

        # Camera position in tag frame: pos = -R^T * t
        R_mat, _ = cv2.Rodrigues(rvec)
        cam_pos = (-R_mat.T @ tvec.reshape(3, 1)).flatten()

        tx, ty, tz = float(cam_pos[0]), float(cam_pos[1]), float(cam_pos[2])
        yaw = compute_yaw(R_mat)

        # ── 诊断日志：记录原始 solvePnP 输出（tag 帧调试用） ──
        sys.stderr.write(
            f"[solvePnP] id={tag_id} raw: tx={tx:.4f} ty={ty:.4f} tz={tz:.4f} yaw={yaw:.1f}°\n"
        )

        # ── 天花板 tag 校正：用已知高度固定 Z，消除垂直摄像头 Z 轴漂移 ──
        # 相机垂直朝上时 solvePnP 的 Z 估计噪声大，但 tx/ty 与 tz 成比例。
        # 固定 tz 为已知天花高度后重新缩放 tx/ty。
        expected_tz = CEILING_H_M - CAM_H_M  # 相机到天花板的距离
        if tz > 0 and expected_tz > 0:
            scale = expected_tz / tz
            if 0.5 < scale < 2.0:  # 只在大幅偏离时修正（防止异常值）
                tx *= scale
                ty *= scale
                tz = expected_tz

        # pixel_size: average of two side lengths at 0° (top edge), in pixels
        corners_int = [[int(p[0]), int(p[1])] for p in img_pts]
        ps = (math.hypot(img_pts[1,0]-img_pts[0,0], img_pts[1,1]-img_pts[0,1]) +
              math.hypot(img_pts[3,0]-img_pts[0,0], img_pts[3,1]-img_pts[0,1])) / 2

        center = [int(img_pts[:, 0].mean()), int(img_pts[:, 1].mean())]

        tags.append({
            "id": tag_id,
            "tx": round(tx, 3),
            "ty": round(ty, 3),
            "tz": round(tz, 3),
            "yaw": round(yaw, 1),
            "corners": corners_int,
            "center": center,
            "pixel_size": round(ps, 1),
        })

    return tags


def main():
    sys.stderr.write("[detect_apriltags] OpenCV solvePnP detector ready\n")
    sys.stderr.flush()

    while True:
        prefix = sys.stdin.buffer.read(4)
        if not prefix or len(prefix) < 4:
            break

        length = struct.unpack("<I", prefix)[0]
        if length <= 0 or length > 10 * 1024 * 1024:
            continue

        jpeg = sys.stdin.buffer.read(length)
        if len(jpeg) < length:
            break

        tags = detect_tags(jpeg)
        result = json.dumps({"tags": tags, "frame_size": length})
        sys.stdout.write(result + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
