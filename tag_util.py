#!/usr/bin/env python3
"""
AprilTag 测试工具 — 生成标签 + 配置服务器

用法:
  1. 生成标签图片（在手机/平板上显示）:
     python tag_util.py generate --id 0 --size 200 --output tag_0.png

  2. 上传标签地图到服务器:
     python tag_util.py upload --server 192.168.x.x --id 0 --x 0.5 --y 1.0 --yaw 0

  3. 设置标签尺寸到 ESP32:
     # 通过服务器 API 设置默认标签尺寸 (mm)
     curl -X POST http://192.168.x.x:3000/api/tags -H 'Content-Type: application/json' \
       -d '{"id": 0, "x": 0.5, "y": 1.0, "yaw": 0, "desc": "test-tag"}'

     # 查看当前标签地图
     curl http://192.168.x.x:3000/api/tags
"""
import argparse
import struct
import hashlib
import io

# ── tag36h11 family constants ──────────────────────────────────
TAG36H11_CODES = [
    0x0000000000, 0x0000000000, 0x0000000000, 0x0000000000,
    0x0000000000, 0x0000000000, 0x0000000000, 0x0000000000,
]

def generate_apriltag_image(tag_id, tag_size_px=200, family='tag36h11'):
    """
    Generate a simple AprilTag image (PPM format).
    This uses the standard tag36h11 family.

    For production-quality tags, use the official generator:
    https://charliehwang.github.io/apriltag-generator/
    """
    import math

    # White border
    border = int(tag_size_px * 0.15)
    inner = tag_size_px - 2 * border
    cell = inner // 7  # 6x6 grid + 1 border cell

    # Create raw bitmap
    size = tag_size_px
    img = bytearray(size * size)

    # Fill white
    for i in range(size * size):
        img[i] = 255

    # Simple deterministic pattern based on tag_id (not real apriltag code)
    # For actual tags, use the official generator
    import hashlib
    seed = hashlib.md5(f"{family}-{tag_id}".encode()).digest()
    bits = int.from_bytes(seed[:6], 'big')

    # Draw 7x7 grid
    for row in range(7):
        for col in range(7):
            bit = (bits >> (row * 7 + col)) & 1
            color = 0 if bit else 255

            x0 = border + col * cell
            y0 = border + row * cell
            for y in range(y0, y0 + cell):
                for x in range(x0, x0 + cell):
                    if 0 <= x < size and 0 <= y < size:
                        img[y * size + x] = color

    return img, size


def save_ppm(img_data, width, height, filename):
    """Save as PPM binary."""
    with open(filename, 'wb') as f:
        f.write(f'P5\n{width} {height}\n255\n'.encode())
        f.write(img_data)
    print(f"Saved {filename} ({width}x{height} grayscale)")
    print()
    print("⚠  This is a SIMULATED tag — for real AprilTag detection,")
    print("   print official tags from: https://charliehwang.github.io/apriltag-generator/")
    print("   Or use 'pip install apriltag' and generate with:")
    print("   python3 -c \"from apriltag_generator import generate_tag\"")


def print_usage_guide(server_ip):
    print()
    print("=" * 60)
    print("  AprilTag 快速上手指南")
    print("=" * 60)
    print()
    print("  1. 打开 https://charliehwang.github.io/apriltag-generator/")
    print("     生成 tag36h11 家族, ID=0, ID=1, ID=2 各一个")
    print()
    print("  2. 在手机上显示 tag_0.png，用尺子量黑色边框宽度 (mm)")
    print()
    print(f"  3. 配置服务器标签地图:")
    print(f"     curl -X POST http://{server_ip}:3000/api/tags \\")
    print(f"       -H 'Content-Type: application/json' \\")
    print(f"       -d '{{\"id\": 0, \"x\": 1.0, \"y\": 0.5, \"yaw\": 0}}'")
    print()
    print("  4. 设置 ESP32 上的标签尺寸:")
    print(f"     # 通过 CMD:TAG_SIZE 发送 (需要在 tcp_client.c 中添加处理器)")
    print(f"     # 或修改 apriltag_detect.c 中的 DEFAULT_TAG_SIZE_MM")
    print()
    print("  5. 查看融合状态:")
    print(f"     curl http://{server_ip}:3000/api/debug")
    print()
    print("  === 坐标系说明 ===")
    print("  tag yaw: 标签朝向 (弧度), 0=朝东, π/2=朝北")
    print("  例如手机贴在北墙上朝南: yaw = -π/2")
    print("  例如手机贴在东墙上朝西: yaw = π")
    print()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='AprilTag test utility')
    sub = parser.add_subparsers(dest='cmd', required=True)

    gen = sub.add_parser('generate', help='生成测试标签图片')
    gen.add_argument('--id', type=int, default=0)
    gen.add_argument('--size', type=int, default=200, help='输出像素尺寸')
    gen.add_argument('--output', default='tag.png')

    up = sub.add_parser('upload', help='上传标签位置到服务器')
    up.add_argument('--server', default='192.168.4.1')
    up.add_argument('--id', type=int, required=True)
    up.add_argument('--x', type=float, default=0)
    up.add_argument('--y', type=float, default=0)
    up.add_argument('--yaw', type=float, default=0)
    up.add_argument('--desc', default='')

    args = parser.parse_args()

    if args.cmd == 'generate':
        img, sz = generate_apriltag_image(args.id, args.size)
        save_ppm(img, sz, sz, args.output)
        print_usage_guide('192.168.4.1')

    elif args.cmd == 'upload':
        import urllib.request, json
        url = f'http://{args.server}:3000/api/tags'
        data = json.dumps({
            'id': args.id, 'x': args.x, 'y': args.y,
            'yaw': args.yaw, 'desc': args.desc or f'tag-{args.id}'
        }).encode()
        req = urllib.request.Request(url, data=data,
            headers={'Content-Type': 'application/json'})
        resp = urllib.request.urlopen(req)
        print(f"Response: {resp.read().decode()}")
