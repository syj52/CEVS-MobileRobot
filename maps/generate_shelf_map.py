#!/usr/bin/env python3
"""Shelf grid map: 4m x 4m, 0.02m res, 4 corner shelves."""
import os

W  = 200; H = 200; RES = 0.02; OX = -2.0; OY = -2.0
data = bytearray(W * H)
for i in range(len(data)): data[i] = 254

SW = 15; SH = 5; MG = 15  # shelf 0.3m x 0.1m, 0.3m edge margin

shelves = [
    (MG, H - MG - SH), (W - MG - SW, H - MG - SH),
    (MG, MG), (W - MG - SW, MG),
]
for col, row in shelves:
    for r in range(row, row + SH):
        for c in range(col, col + SW): data[r * W + c] = 0

hdr = f"P5\n{W} {H}\n255\n".encode()
body = bytes([0 if d == 0 else 254 for d in data])
d = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(d, "nav2_map.pgm"), "wb") as f: f.write(hdr + body)
with open(os.path.join(d, "nav2_map.yaml"), "w") as f:
    f.write(f"image: nav2_map.pgm\nmode: trinary\nresolution: {RES}\norigin: [{OX}, {OY}, 0.0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n")

print(f"Map: {W}x{H} @ {RES}m  origin=({OX},{OY})")
print(f"Aisle: {(W-2*MG-2*SW)*RES:.1f}m")
for col, row in shelves:
    cx = (col+SW/2)*RES + OX; cy = (row+SH/2)*RES + OY
    print(f"  Shelf: ({cx:.3f}, {cy:.3f})")
