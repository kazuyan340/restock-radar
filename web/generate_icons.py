# -*- coding: utf-8 -*-
"""
PWA用アイコン(192px/512px)をベル型シルエットで自動生成する1回限りのスクリプト。
デザインツールが無くても最低限のアイコンを用意できる。実行後は再利用不要。
    python generate_icons.py
"""
import os

from PIL import Image, ImageDraw

BG_COLOR = (20, 22, 29)
FG_COLOR = (108, 140, 255)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")


def _make_icon(size: int, out_path: str) -> None:
    img = Image.new("RGB", (size, size), BG_COLOR)
    draw = ImageDraw.Draw(img)

    cx = size / 2
    top = size * 0.24
    bottom = size * 0.60
    top_width = size * 0.13
    bottom_width = size * 0.32
    dome_radius = top_width

    draw.pieslice(
        [cx - dome_radius, top - dome_radius, cx + dome_radius, top + dome_radius],
        180,
        360,
        fill=FG_COLOR,
    )
    draw.polygon(
        [
            (cx - top_width, top),
            (cx + top_width, top),
            (cx + bottom_width, bottom),
            (cx - bottom_width, bottom),
        ],
        fill=FG_COLOR,
    )

    rim_height = size * 0.05
    rim_pad = size * 0.02
    draw.rounded_rectangle(
        [cx - bottom_width - rim_pad, bottom, cx + bottom_width + rim_pad, bottom + rim_height],
        radius=rim_height / 2,
        fill=FG_COLOR,
    )

    clapper_r = size * 0.035
    clapper_y = bottom + rim_height + size * 0.06
    draw.ellipse(
        [cx - clapper_r, clapper_y - clapper_r, cx + clapper_r, clapper_y + clapper_r],
        fill=FG_COLOR,
    )

    knob_r = size * 0.025
    knob_y = top - dome_radius
    draw.ellipse(
        [cx - knob_r, knob_y - knob_r * 1.4, cx + knob_r, knob_y + knob_r * 0.6],
        fill=FG_COLOR,
    )

    img.save(out_path, "PNG")


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    _make_icon(192, os.path.join(OUT_DIR, "icon-192.png"))
    _make_icon(512, os.path.join(OUT_DIR, "icon-512.png"))
    print(f"アイコンを生成しました: {OUT_DIR}")


if __name__ == "__main__":
    main()
