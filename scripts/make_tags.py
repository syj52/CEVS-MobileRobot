#!/usr/bin/env python3
"""
make_tags.py — 快速从测量表生成 tags 地图文件 (tags/*.json)

把手工丈量的 tag 世界坐标 (id, x, y, yaw) 一次性转成 server 用的 JSON
地图（与 tags/tags.json 同格式）。天花板 / 地面 / 墙面 tag 都用同一格式，
区别只在坐标与朝向数值本身。

输入 CSV（逗号分隔，# 为注释，空行忽略）：
    id, x, y, yaw_deg [, z [, desc]]
例：
    7, 0.0, 0.0, -90, 0.0, origin
    8, 0.9, 0.0, -90
    5, 0.0, 1.3, -90, 0, shelf

- x, y   : tag 中心的世界坐标（米）。建议选一个 tag 当原点 (0,0)。
- yaw_deg: tag 朝向（度，世界系逆时针为正）。写进 JSON 时转成弧度。
- z      : tag 高度（米）。地面平贴≈0；墙面竖直=中心离地高度。缺省 0。
- desc   : 备注，缺省 "tag-<id>"。

用法：
    # 1) 先生成一张待填模板（列出你的 tag ID）：
    python scripts/make_tags.py --template 5,6,7,8 > tags/ground_input.csv
    # 2) 用尺子量好，把坐标填进 tags/ground_input.csv
    # 3) 生成地图文件：
    python scripts/make_tags.py tags/ground_input.csv --out tags/ground.json
"""
import sys, os, json, argparse, math

# Windows 控制台常为 GBK，emoji/UTF-8 直接 print 会 UnicodeEncodeError；
# 尽力切到 UTF-8（失败则退回原编码，JSON 文件始终按 utf-8 写，不受影响）。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass


def parse_row(line):
    parts = [p.strip() for p in line.split(',')]
    if len(parts) < 4:                       # 容忍纯空格分隔
        parts = [p for p in line.replace(',', ' ').split()]
    if len(parts) < 4:
        raise ValueError(f"需要至少 4 列 (id,x,y,yaw_deg): {line!r}")
    tid = int(float(parts[0]))
    x, y, yaw_deg = float(parts[1]), float(parts[2]), float(parts[3])
    z = float(parts[4]) if len(parts) >= 5 and parts[4] != '' else None
    desc = parts[5] if len(parts) >= 6 and parts[5] != '' else f"tag-{tid}"
    return tid, x, y, yaw_deg, z, desc


def main():
    ap = argparse.ArgumentParser(description="生成 tags 地图 JSON")
    ap.add_argument("input", nargs='?', help="测量表 CSV 路径")
    ap.add_argument("--out", default=None, help="输出 JSON（默认与输入同名 .json）")
    ap.add_argument("--template", default=None,
                    help="逗号分隔 ID 列表，输出一张待填 CSV 模板到 stdout")
    ap.add_argument("--z", type=float, default=0.0,
                    help="默认 z 高度（米），行内未指定时使用")
    args = ap.parse_args()

    if args.template:
        ids = [int(x) for x in args.template.split(',') if x.strip() != '']
        print("# id, x, y, yaw_deg, z, desc   （# 为注释；先挑一个 tag 当原点填 0,0）")
        for i, tid in enumerate(ids):
            tail = "   # <- 原点" if i == 0 else ""
            print(f"{tid}, 0.0, 0.0, 0, {args.z}, tag-{tid}{tail}")
        return

    if not args.input:
        ap.error("请给出测量表 CSV 路径，或用 --template 先生成模板")
    if not os.path.exists(args.input):
        ap.error(f"找不到输入文件: {args.input}")

    tags = {}
    with open(args.input, encoding='utf-8') as f:
        for ln, raw in enumerate(f, 1):
            line = raw.split('#', 1)[0].strip()   # 去掉整行/行内 # 注释
            if not line:
                continue
            try:
                tid, x, y, yaw_deg, z, desc = parse_row(line)
            except ValueError as e:
                print(f"[X] 第 {ln} 行解析失败: {e}", file=sys.stderr)
                sys.exit(1)
            if z is None:
                z = args.z
            if str(tid) in tags:
                print(f"[!] 第 {ln} 行: id={tid} 重复，后者覆盖前者", file=sys.stderr)
            tags[str(tid)] = {
                "x": round(x, 4),
                "y": round(y, 4),
                "z": round(z, 4),
                "yaw": round(yaw_deg * math.pi / 180.0, 6),
                "desc": desc,
            }

    if not tags:
        print("[X] 没有解析到任何 tag", file=sys.stderr)
        sys.exit(1)

    out = args.out
    if out is None:
        base = os.path.splitext(os.path.basename(args.input))[0]
        out = os.path.join(os.path.dirname(os.path.abspath(args.input)) or '.',
                           base + '.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(tags, f, indent=2, ensure_ascii=False)

    ids_sorted = ', '.join(sorted(tags.keys(), key=int))
    print(f"[OK] 写入 {out}：{len(tags)} 个 tag → {ids_sorted}")
    print("   yaw 已按 '世界系逆时针为正、度→弧度' 转换。")
    print("   注意：地面/墙面 tag 的 yaw 含义需与运行时变换模式匹配（切换 tagset 时确认几何模式）。")


if __name__ == "__main__":
    main()
