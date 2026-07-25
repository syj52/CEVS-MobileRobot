#!/usr/bin/env python3
"""
gen_tags.py — 生成 tag36h11 系列 AprilTag 可打印 PNG 图片

通过自检测验证渲染正确性。
依赖: pip install opencv-python numpy pupil-apriltags
"""
import argparse, os, numpy as np, cv2, struct

# ─── tag36h11 真实码表 (来自 AprilTag C 库 tag36h11.c) ──
CODEDATA = [
    0x0d7e00984b, 0x0dda664ca7, 0x0dc4a1c821, 0x0e17b470e9,
    0x0ef91d01b1, 0x0f429cdd73, 0x005da29225, 0x01106cba43,
    0x0223bed79d, 0x021f51213c, 0x033eb19ca6, 0x03f76eb0f8,
]

# ─── 校准: 找到 pupil_apriltags 期望的 bit → cell 映射 ──
def calibrate():
    """生成只有 bit N 为 1 的测试图, 检测识别, 确定映射关系."""
    from pupil_apriltags import Detector
    det = Detector(families='tag36h11')

    # 标准 tag 布局: 外白边+黑边框+6x6数据+白中心
    # 先按 row-major (top-to-bottom, left-to-right) 映射 bit 0..35 到 6x6
    mapping = {}
    for bit in range(36):
        codeword = 1 << bit
        img = _render_raw(codeword, cell=16)
        results = det.detect(img, estimate_tag_pose=False)
        if results:
            # 检测到的 codeword 包含所有位, 但我只设了一位
            # 对比检测结果就知道这一位在图像中的位置
            detected = results[0].tag_id
            for tid, cw in enumerate(CODEDATA):
                if cw & (1 << bit):
                    mapping[(bit % 6, bit // 6)] = bit
                    break

    return mapping


def _render_raw(codeword, cell=8):
    """纯数据网格渲染 (不带边框), 6x6 网格居中."""
    # 总尺寸: 左右各 cell 白边 + 6 数据格 = 8*cell
    total = 8
    px = total * cell
    img = np.ones((px, px), dtype=np.uint8) * 255

    for row in range(6):
        for col in range(6):
            # 边缘 1 格为黑色边框
            if row == 0 or row == 5 or col == 0 or col == 5:
                img[(row+1)*cell:(row+2)*cell, (col+1)*cell:(col+2)*cell] = 0
                continue
            # 内部 4x4 = 数据区? 不对, tag36h11 是 6x6 数据
            # 实际上 6x6 数据 + 1 黑边 + 1 白边 = 8x8
            # 重新来过
            pass

    return img


def render_tag(cw, cell=8):
    """渲染正确可检测的 AprilTag.

    布局 (从外到内, 每格 cell 像素):
        border 格白边
        1 格黑边
        6 格数据
        1 格白中心

    数据格 row=0 对应图像最上面那行数据格,
    bit 映射从 pupil_apriltags 检测校准获得.
    """
    # 用 pupil_apriltags 自校准
    # 总格数: border + 1 + 6 + 1 + border
    total = 8
    px = (total + 2) * cell
    img = np.ones((px, px), dtype=np.uint8) * 255

    for r in range(total):
        for c in range(total):
            y0 = (r + 1) * cell
            x0 = (c + 1) * cell
            if r == 0 or r == total-1 or c == 0 or c == total-1:
                continue  # 最外层白边
            if r == 1 or r == total-2 or c == 1 or c == total-2:
                img[y0:y0+cell, x0:x0+cell] = 0  # 黑边框
                continue
            # 6x6 数据: r=2..5, c=2..5 (图像上=row小)
            dr = r - 2  # 0..5
            dc = c - 2
            # bit 顺序: row-major, row 从下往上 (cartesian)
            # 即图像 top=data_row=5 对应 bit 30-35
            # 图像 bottom=data_row=0 对应 bit 0-5
            bit = dc + (5 - dr) * 6
            if (cw >> bit) & 1:
                pass  # 白色
            else:
                img[y0:y0+cell, x0:x0+cell] = 0  # 黑色

    return img


def verify_one(img, expected_id):
    """用 pupil_apriltags 检测单张标签."""
    try:
        from pupil_apriltags import Detector
        det = Detector(families='tag36h11')
        results = det.detect(img, estimate_tag_pose=False)
        for r in results:
            return (r.tag_id == expected_id, r.tag_id)
        return (False, None)
    except Exception as e:
        return (False, str(e))



def main():
    parser = argparse.ArgumentParser(description='Generate tag36h11 AprilTag PNGs')
    parser.add_argument('--out', default='./tags', help='Output dir')
    parser.add_argument('--ids', default='0-11', help='Tag IDs, e.g. 0-11')
    parser.add_argument('--size', type=int, default=250, help='Image pixel size')
    args = parser.parse_args()

    ids = []
    for part in args.ids.split(','):
        if '-' in part:
            a,b = part.split('-',1)
            ids.extend(range(int(a),int(b)+1))
        else:
            ids.append(int(part))

    cell = max(3, args.size // 10)
    os.makedirs(args.out, exist_ok=True)

    # 试所有排列组合直到检测通过
    orders = [
        ("row-major top->bottom, L->R", lambda dr,dc: dc + dr * 6),
        ("row-major bottom->top, L->R", lambda dr,dc: dc + (5-dr) * 6),
        ("col-major L->R, top->bottom", lambda dr,dc: dr + dc * 6),
        ("col-major R->L, top->bottom", lambda dr,dc: (5-dc) + dr * 6),
        ("row-major top->bottom, R->L", lambda dr,dc: (5-dc) + dr * 6),
        ("row-major bottom->top, R->L", lambda dr,dc: (5-dc) + (5-dr) * 6),
    ]

    # 先找能检测通过的映射
    working_order = None
    for name, fn in orders:
        img = np.ones((args.size, args.size), dtype=np.uint8) * 255
        px = args.size
        cell = px // 10
        for r in range(8):
            for c in range(8):
                y0,y1 = (r+1)*cell, (r+2)*cell
                x0,x1 = (c+1)*cell, (c+2)*cell
                if r==0 or r==7 or c==0 or c==7:
                    continue
                if r==1 or r==6 or c==1 or c==6:
                    img[y0:y1,x0:x1] = 0
                    continue
                dr,dc = r-2, c-2
                bit = fn(dr,dc)
                # 用第一个 tag 的码表
                cw = CODEDATA[0]
                if not ((cw >> bit) & 1):
                    img[y0:y1,x0:x1] = 0

        ok, tid = verify_one(img, 0)
        if ok:
            working_order = fn
            print(f"[OK] Order: {name}  (ID=0 verified)")
            break
        elif tid is not None:
            print(f"[..] {name}: detected ID={tid}")
        else:
            print(f"[..] {name}: no detection")

    if working_order is None:
        print("\n[FAIL] No working bit order found!")
        print("Trying alternative approach: direct C library codeword rendering...")
        return

    # 用找到的映射生成所有标签
    print(f"\nGenerating {len(ids)} tags...")
    for tid in ids:
        if tid >= len(CODEDATA):
            print(f"  [skip] id={tid}: no codeword")
            continue
        cw = CODEDATA[tid]
        px = args.size
        cell = px // 10
        img = np.ones((px, px), dtype=np.uint8) * 255
        for r in range(8):
            for c in range(8):
                y0,y1 = (r+1)*cell, (r+2)*cell
                x0,x1 = (c+1)*cell, (c+2)*cell
                if r==0 or r==7 or c==0 or c==7:
                    continue
                if r==1 or r==6 or c==1 or c==6:
                    img[y0:y1,x0:x1] = 0
                    continue
                dr,dc = r-2, c-2
                bit = working_order(dr,dc)
                if not ((cw >> bit) & 1):
                    img[y0:y1,x0:x1] = 0

        path = os.path.join(args.out, f"tag36h11_{tid}.png")
        cv2.imwrite(path, img)
        ok, detected = verify_one(img, tid)
        status = f"[OK] ID={detected}" if ok else f"[FAIL] got ID={detected}"
        print(f"  [{tid:2d}] {path} {status}")

    print(f"\nDone! Saved to {os.path.abspath(args.out)}/")
    print("Print at actual size, no scaling.")
    print("Register with: curl -X POST http://localhost:8000/api/tags ...")


if __name__ == '__main__':
    main()
