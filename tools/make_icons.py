"""PWA 아이콘 PNG 생성 (외부 라이브러리 없이 zlib 로 직접 씀).

디자인: 짙은 남색 배경 + 우상향 막대 3개 + 상승 화살표.
  python3 tools/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"

BG = (14, 17, 23)
CARD = (22, 27, 34)
BAR = (110, 168, 254)
ACCENT = (217, 45, 32)
WHITE = (240, 243, 248)


def png(path: Path, size: int, draw, bg=BG) -> None:
    rows = [[bg] * size for _ in range(size)]
    draw(rows, size)
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("BBB", *px) for px in row) for row in rows
    )
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    )


def rect(rows, x0, y0, x1, y1, color, radius=0):
    n = len(rows)
    for y in range(max(0, int(y0)), min(n, int(y1))):
        for x in range(max(0, int(x0)), min(n, int(x1))):
            if radius:
                dx = min(x - x0, x1 - 1 - x)
                dy = min(y - y0, y1 - 1 - y)
                if dx < radius and dy < radius:
                    if (radius - dx) ** 2 + (radius - dy) ** 2 > radius * radius:
                        continue
            rows[y][x] = color


def line(rows, x0, y0, x1, y1, color, width):
    """굵은 선분 (거리 기반)."""
    n = len(rows)
    dx, dy = x1 - x0, y1 - y0
    length2 = dx * dx + dy * dy or 1
    lo_x, hi_x = int(min(x0, x1) - width), int(max(x0, x1) + width) + 1
    lo_y, hi_y = int(min(y0, y1) - width), int(max(y0, y1) + width) + 1
    for y in range(max(0, lo_y), min(n, hi_y)):
        for x in range(max(0, lo_x), min(n, hi_x)):
            t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / length2))
            px, py = x0 + t * dx, y0 + t * dy
            if (x - px) ** 2 + (y - py) ** 2 <= (width / 2) ** 2:
                rows[y][x] = color


def art(rows, size, pad_ratio=0.0):
    """막대 3개 + 우상향 라인."""
    u = size / 100.0
    pad = size * pad_ratio
    inner = size - pad * 2

    def U(v):  # 100 기준 좌표 -> 픽셀
        return pad + inner * v / 100.0

    heights = [38, 58, 78]
    for i, h in enumerate(heights):
        x = 20 + i * 24
        rect(rows, U(x), U(82 - h), U(x + 16), U(82), BAR if i < 2 else WHITE,
             radius=max(1, int(3 * u)))
    line(rows, U(24), U(40), U(50), U(26), ACCENT, max(2.0, 5 * u))
    line(rows, U(50), U(26), U(78), U(14), ACCENT, max(2.0, 5 * u))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        png(OUT / f"icon-{size}.png", size, lambda r, s: art(r, s))
    # maskable: 안전영역 확보를 위해 여백을 더 준다
    png(OUT / "icon-maskable-512.png", 512, lambda r, s: art(r, s, pad_ratio=0.16))
    png(OUT / "apple-touch-icon.png", 180, lambda r, s: art(r, s, pad_ratio=0.06))
    for p in sorted(OUT.glob("*.png")):
        print(f"  {p.name}  {p.stat().st_size:,}B")


if __name__ == "__main__":
    main()
