#!/usr/bin/env python3
"""Render the NT TES mark (same geometry as the macOS menu bar app's TesMark.swift,
favicon viewBox 32x32) into the tray and app icons. Needs Pillow."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

BODY = [(4, 2), (10, 2), (10, 16), (22, 16), (22, 2), (28, 2), (28, 22), (24, 22),
        (24, 26), (28, 26), (28, 30), (4, 30), (4, 26), (8, 26), (8, 22), (4, 22)]
EYE = [(12, 4), (20, 4), (20, 14), (12, 14)]
EYE_COLOR = (0x33, 0x54, 0xFF, 255)  # NTConsult blue
SS = 8  # supersampling


def mark(size, body_color, background=None, inset=0.0):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if background:
        d.rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * 0.22), fill=background)
    scale = big * (1 - 2 * inset) / 32
    off = big * inset
    pt = lambda p: (off + p[0] * scale, off + p[1] * scale)
    d.polygon([pt(p) for p in BODY], fill=body_color)
    d.polygon([pt(p) for p in EYE], fill=EYE_COLOR)
    return img.resize((size, size), Image.LANCZOS)


def main(out):
    out = Path(out)
    (out / "tray").mkdir(parents=True, exist_ok=True)
    # Tray: white body for dark bars, near-black for light bars (44px = 22pt @2x).
    mark(44, (255, 255, 255, 255)).save(out / "tray" / "tray-dark.png")
    mark(44, (28, 28, 30, 255)).save(out / "tray" / "tray-light.png")
    # App icon source: navy tile, white body.
    mark(1024, (255, 255, 255, 255), background=(14, 21, 33, 255), inset=0.16).save(out / "app-icon.png")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "src-tauri/icons")
