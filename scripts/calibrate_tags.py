#!/usr/bin/env python3
"""
calibrate_tags.py — AprilTag 天花板定位标定工具

修正三个未知量:
  1. 每个 tag 的实际世界坐标 (x, y)
  2. 相机中心到机器人中心的安装偏移 (cam_dx, cam_dy)
  3. 相机偏角 (cam_tilt_x, cam_tilt_y) — 简化为水平面的固定偏移

用法:
  python scripts/calibrate_tags.py
  按照提示将机器人依次挪到每个 tag 正下方,按回车记录观测值。
"""
import sys, os, json, time, math, urllib.request

API = "http://localhost:8000"
CONFIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config")
TAGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tags", "tags.json")


def api_get(path):
    try:
        return json.loads(urllib.request.urlopen(f"{API}{path}", timeout=5).read())
    except Exception as e:
        print(f"  ⚠️  API 错误: {e}")
        return None


def api_delete(path):
    try:
        req = urllib.request.Request(f"{API}{path}", method="DELETE")
        return json.loads(urllib.request.urlopen(req, timeout=5).read())
    except:
        return None


def load_tags():
    with open(TAGS_FILE) as f:
        return json.load(f)


def save_tags(tags):
    with open(TAGS_FILE, "w") as f:
        json.dump(tags, f, indent=2)
    print(f"  ✅ tags.json 已更新")


def collect_observations(tags):
    """引导用户在每个 tag 下方收集观测值"""
    obs = {}
    tag_ids = sorted(int(k) for k in tags.keys())

    print(f"\n{'='*60}")
    print(f" 标定步骤: 共 {len(tag_ids)} 个 tag")
    print(f" 将机器人依次挪到每个 tag 正下方,")
    print(f" 使摄像头大致对准 tag 中心,")
    print(f" 按回车记录该位置的观测值")
    print(f"{'='*60}\n")

    # 先清空历史观测
    api_delete("/api/calib/observations")

    for tid in tag_ids:
        input(f"  🔵 将机器人挪到 tag-{tid} 正下方,然后按回车...")

        # 等待几帧让 solvePnP 稳定
        print(f"  采集观测值...", end="", flush=True)
        time.sleep(1.5)

        raw = api_get("/api/calib/observations")
        if raw and str(tid) in raw:
            d = raw[str(tid)]
            print(f" tx={d['tx']:.3f} ty={d['ty']:.3f} tz={d['tz']:.3f} yaw={d['yaw']:.1f}° robot=({d['robotX']:.3f},{d['robotY']:.3f})")
            obs[tid] = d
        else:
            obs_data = api_get("/api/debug")
            if obs_data:
                print(f"  (无原始观测,使用当前融合位姿)")
                obs[tid] = {"tx": 0, "ty": 0, "tz": 2.6, "yaw": 0,
                            "robotX": obs_data.get("position", {}).get("x", 0),
                            "robotY": obs_data.get("position", {}).get("y", 0),
                            "robotA": obs_data.get("angleRad", 0)}

    print(f"\n✅ 采集完成,共 {len(obs)} 个观测值")
    return obs


def solve_calibration(obs, tags):
    """
    用最小二乘法求解:
      tag_i_actual = tag_i_approx + (dx, dy)  每个 tag 的修正
      robot_pos    = tag_pos + rotate(tx,ty) + rotate(cam_offset)  相机→机器人偏移

    简化: 假定 tag 之间的相对位置是正确的,整体平移修正。
    同时计算相机安装偏移 cam_dx, cam_dy。
    """
    tag_ids = sorted(obs.keys())
    n = len(tag_ids)
    if n < 2:
        print("[X] 至少需要 2 个 tag 的观测值")
        return None, None

    # 计算每个 tag 观测的: robot_pos - rotate(tx, ty) = tag_pos + rotate(cam_offset)
    # 进一步: (robot_pos - rotate(tx,ty)) - tag_approx = tag_correction + rotate(cam_offset)
    # 其中 tag_correction 对于所有 tag 相同 (假设标签间相对位置准确)

    errors_x, errors_y = [], []
    cam_offsets_x, cam_offsets_y = [], []

    for tid in tag_ids:
        d = obs[tid]
        tid_str = str(tid)
        tag = tags.get(tid_str, {})
        tag_x, tag_y = tag.get("x", 0), tag.get("y", 0)
        tag_yaw = tag.get("yaw", 0)

        tx, ty = d["tx"], d["ty"]
        rx, ry, ra = d["robotX"], d["robotY"], d.get("robotA", 0)

        # 相机在 tag 坐标系中的偏移旋转到世界
        cos_t = math.cos(tag_yaw)
        sin_t = math.sin(tag_yaw)
        cam_offset_wx = tx * cos_t - ty * sin_t
        cam_offset_wy = tx * sin_t + ty * cos_t

        # 相机世界位置 = tag 位置 + 相机相对 tag 偏移
        cam_wx = tag_x + cam_offset_wx
        cam_wy = tag_y + cam_offset_wy

        # 机器人位置 = 相机位置 + 相机→机器人偏移 (旋转到机器人航向)
        cos_r = math.cos(ra)
        sin_r = math.sin(ra)
        # rob_x = cam_wx + cam_dx*cos_r - cam_dy*sin_r
        # rob_y = cam_wy + cam_dx*sin_r + cam_dy*cos_r
        #
        # rob_x - cam_wx = cam_dx*cos_r - cam_dy*sin_r
        # rob_y - cam_wy = cam_dx*sin_r + cam_dy*cos_r

        dx_meas = rx - cam_wx
        dy_meas = ry - cam_wy

        cam_offsets_x.append(dx_meas)
        cam_offsets_y.append(dy_meas)

        # 同时记录 tag 位置误差
        errors_x.append(rx - cam_wx)
        errors_y.append(ry - cam_wy)

    # 求解 cam_offset: 用最小二乘拟合
    # [cos_r, -sin_r] [cam_dx] = [dx_meas]
    # [sin_r,  cos_r] [cam_dy]   [dy_meas]
    #
    # 最小二乘: A^T A * x = A^T * b

    A_rows = []
    b_rows = []
    for i, tid in enumerate(tag_ids):
        d = obs[tid]
        ra = d.get("robotA", 0)
        cos_r, sin_r = math.cos(ra), math.sin(ra)
        A_rows.append([cos_r, -sin_r])
        A_rows.append([sin_r, cos_r])
        b_rows.append(cam_offsets_x[i])
        b_rows.append(cam_offsets_y[i])

    # 伪逆求解
    import numpy as np
    A = np.array(A_rows)
    b = np.array(b_rows)

    try:
        cam_offset, residuals, rank, s = np.linalg.lstsq(A, b, rcond=None)
        cam_dx, cam_dy = float(cam_offset[0]), float(cam_offset[1])
        print(f"\n📐 相机安装偏移: dx={cam_dx:.3f}m, dy={cam_dy:.3f}m")
    except:
        print("  ⚠️ 最小二乘求解失败,使用中位数")
        cam_dx = np.median(cam_offsets_x)
        cam_dy = np.median(cam_offsets_y)
        print(f"📐 相机安装偏移 (中位数): dx={cam_dx:.3f}m, dy={cam_dy:.3f}m")

    # 用求得的 cam_offset 重新计算每个 tag 的修正
    print(f"\n{'='*60}")
    print(f" 每个 tag 的修正量:")
    print(f"{'='*60}")

    corrections = {}
    total_cx, total_cy = 0, 0

    for tid in tag_ids:
        d = obs[tid]
        tid_str = str(tid)
        tag = tags.get(tid_str, {})
        tag_x, tag_y = tag.get("x", 0), tag.get("y", 0)
        tag_yaw = tag.get("yaw", 0)
        ra = d.get("robotA", 0)
        cos_r, sin_r = math.cos(ra), math.sin(ra)
        cos_t, sin_t = math.cos(tag_yaw), math.sin(tag_yaw)

        tx, ty = d["tx"], d["ty"]
        rx, ry = d["robotX"], d["robotY"]

        # 机器人位置 - 相机偏移 = 相机世界位置
        cam_wx = rx - (cam_dx * cos_r - cam_dy * sin_r)
        cam_wy = ry - (cam_dx * sin_r + cam_dy * cos_r)

        # 相机世界位置 - tag 相对偏移 = tag 实际位置
        tag_actual_x = cam_wx - (tx * cos_t - ty * sin_t)
        tag_actual_y = cam_wy - (tx * sin_t + ty * cos_t)

        dcx = tag_actual_x - tag_x
        dcy = tag_actual_y - tag_y
        corrections[tid] = (dcx, dcy, tag_actual_x, tag_actual_y)
        total_cx += dcx
        total_cy += dcy

        print(f"  tag-{tid}: 原({tag_x:.2f},{tag_y:.2f}) → 校({tag_actual_x:.3f},{tag_actual_y:.3f})  Δ({dcx:+.3f},{dcy:+.3f})")

    avg_cx = total_cx / n
    avg_cy = total_cy / n
    print(f"\n  平均修正: Δx={avg_cx:+.3f}, Δy={avg_cy:+.3f}")

    return corrections, (cam_dx, cam_dy)


def main():
    tags = load_tags()
    print(f"当前有 {len(tags)} 个 tag")

    # 步骤 1: 采集观测值
    obs = collect_observations(tags)
    if len(obs) < 2:
        print("[X] 观测值不足,退出")
        sys.exit(1)

    # 步骤 2: 求解
    corrections, cam_offset = solve_calibration(obs, tags)
    if corrections is None:
        sys.exit(1)

    # 步骤 3: 应用修正
    print(f"\n{'='*60}")
    apply = input("  应用以上修正到 tags.json? (y/n): ").strip().lower()
    if apply != 'y':
        print("  已取消,未保存")
        sys.exit(0)

    for tid_str in tags:
        tid = int(tid_str)
        if tid in corrections:
            cx, cy, nx, ny = corrections[tid]
            tags[tid_str]["x"] = round(nx, 3)
            tags[tid_str]["y"] = round(ny, 3)

    save_tags(tags)

    # 步骤 4: 保存相机安装偏移到 camera.json
    if cam_offset:
        cam_json = os.path.join(CONFIG_DIR, "camera.json")
        if os.path.exists(cam_json):
            with open(cam_json) as f:
                cam_cfg = json.load(f)
        else:
            cam_cfg = {}
        cam_cfg["cam_offset_x"] = round(cam_offset[0], 3)
        cam_cfg["cam_offset_y"] = round(cam_offset[1], 3)
        with open(cam_json, "w") as f:
            json.dump(cam_cfg, f, indent=2)
        print(f"  ✅ 相机偏移已保存到 camera.json")

    print(f"\n{'='*60}")
    print(f" 标定完成! 重新启动服务端生效")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
