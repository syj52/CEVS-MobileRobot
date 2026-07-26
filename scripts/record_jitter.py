#!/usr/bin/env python3
"""
record_jitter.py — 录制小车位置抖动数据并分析
用法:
  python scripts/record_jitter.py [--seconds 30] [--api http://localhost:8000]
"""
import sys, json, time, math, urllib.request, argparse, os

def api_get(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
        resp = urllib.request.urlopen(req, timeout=5)
        raw = resp.read()
        if not raw:
            return {"_error": "empty response"}
        return json.loads(raw.decode('utf-8'))
    except Exception as e:
        return {"_error": str(e)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--api", default="http://localhost:8000")
    args = parser.parse_args()

    api, duration, interval = args.api, args.seconds, 0.5
    n_samples = int(duration / interval)

    print(f"录制 {duration}s, 采样间隔 {interval}s, {n_samples} 个采样点")
    print(f"{'='*70}")
    print(f"{'  t(s)':>6} {'x':>8} {'y':>8} {'角度(°)':>8} {'Δx':>8} {'Δy':>8} {'Δ距离':>8}")
    print(f"{'-'*70}")

    samples, t0, px, py = [], time.time(), None, None

    for _ in range(n_samples):
        now = time.time() - t0
        d = api_get(f"{api}/api/debug")

        if "_error" in d:
            print(f"{now:>6.1f}  ❌ 请求失败: {d['_error']}")
            time.sleep(interval)
            continue

        if "position" not in d:
            print(f"{now:>6.1f}  ⚠️ 无 position 字段: {str(d)[:80]}")
            time.sleep(interval)
            continue

        x = d["position"]["x"]
        y = d["position"]["y"]
        a = d.get("angleRad", 0)
        a_deg = d.get("angleDeg", a * 180 / math.pi + 360) % 360

        dx = x - px if px is not None else 0
        dy = y - py if py is not None else 0
        dist = math.hypot(dx, dy) if px is not None else 0

        samples.append({"t": round(now, 2), "x": round(x, 3), "y": round(y, 3), "angle": round(a_deg, 1)})

        flag = " ★ >1m!" if dist > 1.0 else " ▲ >0.5m" if dist > 0.5 else ""
        print(f"{now:>6.1f}  {x:>8.3f} {y:>8.3f} {a_deg:>8.1f} {dx:>+8.3f} {dy:>+8.3f} {dist:>8.3f}{flag}")

        px, py = x, y
        time.sleep(max(0, interval - (time.time() - t0 - now)))

    # ── 统计分析 ──
    print(f"\n{'='*70}")
    print(f"统计结果")
    print(f"{'='*70}")
    n = len(samples)
    if n < 2:
        print("采样点不足")
        return

    xs = [s["x"] for s in samples]
    ys = [s["y"] for s in samples]

    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)

    x_mean = sum(xs) / n
    y_mean = sum(ys) / n
    x_std = math.sqrt(sum((x - x_mean)**2 for x in xs) / n)
    y_std = math.sqrt(sum((y - y_mean)**2 for y in ys) / n)

    deltas = [math.hypot(xs[i]-xs[i-1], ys[i]-ys[i-1]) for i in range(1, n)]
    avg_delta = sum(deltas) / len(deltas)
    max_delta = max(deltas)

    big = [d for d in deltas if d > 0.5]
    huge = [d for d in deltas if d > 1.0]

    print(f"  样本数: {n}")
    print(f"  X: {x_min:.3f} ~ {x_max:.3f}  (跨度 {x_max-x_min:.3f}m, σ={x_std:.3f})")
    print(f"  Y: {y_min:.3f} ~ {y_max:.3f}  (跨度 {y_max-y_min:.3f}m, σ={y_std:.3f})")
    print(f"  相邻采样平均变化: {avg_delta:.3f}m, 最大: {max_delta:.3f}m")
    print(f"  >0.5m 跳变: {len(big)}/{len(deltas)} ({len(big)/len(deltas)*100:.1f}%)")
    print(f"  >1.0m 跳变: {len(huge)}/{len(deltas)} ({len(huge)/len(deltas)*100:.1f}%)")

    if huge:
        print(f"\n  ★ 大幅跳变(>1m)幅值: {', '.join(f'{d:.2f}' for d in sorted(huge, reverse=True)[:10])}")

    total_range = math.hypot(x_max - x_min, y_max - y_min)
    if total_range < 0.1:
        print(f"\n  ✅ 稳定 (跨度 {total_range:.3f}m)")
    elif total_range < 0.5:
        print(f"\n  ⚠️ 小幅抖动 (跨度 {total_range:.3f}m) — solvePnP 噪声")
    elif total_range < 2.0:
        print(f"\n  ❌ 中等抖动 (跨度 {total_range:.3f}m) — 可能坐标轴错乱")
    else:
        print(f"\n  ❌❌ 大幅抖动 (跨度 {total_range:.3f}m) — 大概率坐标轴错乱或算法问题")

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "jitter_records.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        for s in samples:
            f.write(json.dumps(s) + "\n")
    print(f"\n原始数据: {out}")


if __name__ == "__main__":
    main()
