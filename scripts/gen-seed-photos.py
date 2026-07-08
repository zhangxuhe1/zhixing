#!/usr/bin/env python3
"""生成 seed 用的占位图片素材：12 张 800x600 渐变+文字 JPEG。

一次性运行、产物提交入库（packages/db/seed-assets/）；packages/db 的 seed CLI 只在运行期
读取这些本地文件，不会重新调用本脚本，也不联网、不调 LLM。

用法：python3 scripts/gen-seed-photos.py
"""
import os

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 800, 600
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "packages", "db", "seed-assets")

# 12 组渐变色（起止 RGB）+ 配文——纯装饰性占位图，不对应真实地点。
PLATES = [
    ((255, 183, 94), (235, 87, 87), "晨雾"),
    ((86, 204, 242), (47, 128, 237), "石桥"),
    ((149, 225, 211), (39, 174, 96), "老巷"),
    ((250, 208, 196), (235, 87, 87), "灯火"),
    ((189, 195, 199), (44, 62, 80), "青瓦"),
    ((255, 236, 179), (255, 152, 0), "归途"),
    ((207, 216, 220), (96, 125, 139), "烟雨"),
    ((255, 205, 210), (216, 27, 96), "市集"),
    ((178, 235, 242), (0, 131, 143), "渡口"),
    ((215, 204, 200), (93, 64, 55), "城墙"),
    ((197, 202, 233), (57, 73, 171), "星夜"),
    ((220, 237, 200), (104, 159, 56), "田野"),
]

FONT_CANDIDATES = [
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    # 找不到 CJK 字体时退回默认位图字体（英文占位环境下的兜底，正常 macOS/CI 不会走到这里）
    return ImageFont.load_default()


def make_gradient(top: tuple, bottom: tuple) -> Image.Image:
    img = Image.new("RGB", (WIDTH, HEIGHT), top)
    draw = ImageDraw.Draw(img)
    for y in range(HEIGHT):
        t = y / (HEIGHT - 1)
        row = tuple(round(top[c] + (bottom[c] - top[c]) * t) for c in range(3))
        draw.line([(0, y), (WIDTH, y)], fill=row)
    return img


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    font = load_font(64)
    total_bytes = 0
    for i, (top, bottom, label) in enumerate(PLATES, start=1):
        img = make_gradient(top, bottom)
        draw = ImageDraw.Draw(img)
        bbox = draw.textbbox((0, 0), label, font=font)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x, y = (WIDTH - w) / 2 - bbox[0], (HEIGHT - h) / 2 - bbox[1]
        for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2)):  # 简单描边增强可读性
            draw.text((x + dx, y + dy), label, font=font, fill=(0, 0, 0))
        draw.text((x, y), label, font=font, fill=(255, 255, 255))

        path = os.path.join(OUT_DIR, f"seed-{i:02d}.jpg")
        img.save(path, "JPEG", quality=72, optimize=True)
        size = os.path.getsize(path)
        total_bytes += size
        print(f"{os.path.relpath(path)}: {size / 1024:.1f} KB")

    print(f"合计 {len(PLATES)} 张，{total_bytes / 1024:.1f} KB")


if __name__ == "__main__":
    main()
