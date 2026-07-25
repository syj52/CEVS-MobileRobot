#!/usr/bin/env python3
"""
gen_qr.py — 生成货架静态取货二维码

每个货物一张二维码, 内容指向局域网 cevs-server 的取货确认页:
    http://<server_ip>:8000/pick?goods=<id>

打印后贴到对应货架, 用户手机(连仓库WiFi)扫码即可取货。

用法:
    python gen_qr.py --ip 192.168.1.44 --goods 1,2,3 --out ./qrcodes

依赖:
    pip install "qrcode[pil]"
"""
import argparse
import os
import qrcode
from PIL import Image, ImageDraw, ImageFont


def make_qr_with_label(url, label, sublabel):
    """生成带文字标签的二维码图片"""
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")

    qw, qh = qr_img.size
    # 顶部标题 + 底部说明的画布
    pad_top = 60
    pad_bottom = 50
    canvas = Image.new("RGB", (qw, qh + pad_top + pad_bottom), "white")
    canvas.paste(qr_img, (0, pad_top))

    draw = ImageDraw.Draw(canvas)
    try:
        font_big = ImageFont.truetype("arial.ttf", 32)
        font_small = ImageFont.truetype("arial.ttf", 18)
    except Exception:
        font_big = ImageFont.load_default()
        font_small = ImageFont.load_default()

    # 顶部: 货物名 (居中)
    bbox = draw.textbbox((0, 0), label, font=font_big)
    tw = bbox[2] - bbox[0]
    draw.text(((qw - tw) / 2, 14), label, fill="black", font=font_big)

    # 底部: 扫码说明 (居中)
    bbox2 = draw.textbbox((0, 0), sublabel, font=font_small)
    tw2 = bbox2[2] - bbox2[0]
    draw.text(((qw - tw2) / 2, qh + pad_top + 12), sublabel, fill="#666666", font=font_small)

    return canvas


def main():
    parser = argparse.ArgumentParser(description='生成货架取货二维码')
    parser.add_argument('--ip', required=True, help='cevs-server 局域网 IP, 如 192.168.1.44')
    parser.add_argument('--port', type=int, default=8000, help='服务器端口 (默认 8000)')
    parser.add_argument('--goods', default='1,2,3', help='货物 ID 列表, 如 1,2,3')
    parser.add_argument('--out', default='./qrcodes', help='输出目录')
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    ids = [x.strip() for x in args.goods.split(',') if x.strip()]

    print(f"生成 {len(ids)} 个取货二维码 (server: {args.ip}:{args.port})")
    for gid in ids:
        url = f"http://{args.ip}:{args.port}/pick?goods={gid}"
        img = make_qr_with_label(url, f"货物 #{gid}", "微信/相机扫码取货")
        path = os.path.join(args.out, f"qr_goods_{gid}.png")
        img.save(path)
        print(f"  [OK] {path}")
        print(f"       {url}")

    print(f"\n完成! 保存至 {os.path.abspath(args.out)}/")
    print("打印后贴到对应货架, 确保扫码手机连接仓库同一 WiFi。")


if __name__ == '__main__':
    main()
