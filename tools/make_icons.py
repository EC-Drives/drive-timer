"""Draw the app icons (PNG and SVG) with no image library: a stopwatch with a blue lap sweep.

    python tools/make_icons.py

Writes icons/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png (180 px)
and icon.svg. Shapes are drawn as signed-distance fields with one-pixel anti-aliasing.
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'icons')

BG = (13, 13, 13)
WHITE = (255, 255, 255)
BLUE = (42, 120, 214)      # palette blue 450
BLUE_DARK = (24, 79, 149)  # palette blue 600

# design in a unit square; the dial sits slightly low to leave room for the crown
CX, CY = 0.5, 0.545
R_RING = 0.30
W_RING = 0.058
SWEEP_DEG = 125  # lap sweep, clockwise from 12 o'clock


def write_png(path, w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw.extend(rgba[y * w * 4:(y + 1) * w * 4])
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def sector_dist(ang, r, s):
    """Approximate signed distance to the sector from 12 o'clock clockwise to angle s."""
    if 0 <= ang <= s:
        return -r * math.sin(min(ang, s - ang, math.pi / 2))
    return r * math.sin(min(2 * math.pi - ang, ang - s, math.pi / 2))


def rounded_rect(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - hw + r
    qy = abs(py - cy) - hh + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def render(size, scale=1.0, bg_full=True):
    px_w = 1.0 / size
    buf = bytearray(size * size * 4)
    hand_ang = math.radians(SWEEP_DEG)
    hx = CX + 0.205 * math.sin(hand_ang)
    hy = CY - 0.205 * math.cos(hand_ang)
    for j in range(size):
        for i in range(size):
            # map pixel to design space (scale around the centre for the maskable variant)
            u = ((i + 0.5) / size - 0.5) / scale + 0.5
            v = ((j + 0.5) / size - 0.5) / scale + 0.5
            aa = px_w / scale
            col = list(BG)

            def blend(c, d):
                a = max(0.0, min(1.0, 0.5 - d / aa))
                if a > 0:
                    for k in range(3):
                        col[k] = col[k] * (1 - a) + c[k] * a

            dx, dy = u - CX, v - CY
            r = math.hypot(dx, dy)
            ang = math.atan2(dx, -dy) % (2 * math.pi)  # 0 at 12 o'clock, clockwise
            # dial: dark disc, then the bright lap sweep on top (anti-aliased radial edges)
            inner = R_RING - W_RING / 2 - 0.035
            blend(BLUE_DARK, r - inner)
            blend(BLUE, max(r - inner, sector_dist(ang, r, math.radians(SWEEP_DEG))))
            # ring
            blend(WHITE, abs(r - R_RING) - W_RING / 2)
            # crown and stem
            blend(WHITE, rounded_rect(u, v, CX, CY - R_RING - 0.075, 0.07, 0.03, 0.015))
            blend(WHITE, rounded_rect(u, v, CX, CY - R_RING - 0.035, 0.022, 0.03, 0.006))
            # side button at about 1:30
            bx = CX + (R_RING + 0.045) * math.sin(math.radians(45))
            by = CY - (R_RING + 0.045) * math.cos(math.radians(45))
            blend(WHITE, seg_dist(u, v, bx - 0.02, by - 0.02, bx + 0.02, by + 0.02) - 0.025)
            # hand and hub
            blend(WHITE, seg_dist(u, v, CX, CY, hx, hy) - 0.021)
            blend(WHITE, r - 0.042)
            blend(BG, r - 0.016)
            o = (j * size + i) * 4
            buf[o:o + 4] = bytes((int(round(col[0])), int(round(col[1])), int(round(col[2])), 255))
    return buf


def svg():
    a = math.radians(SWEEP_DEG)
    inner = R_RING - W_RING / 2 - 0.035
    s = 512
    ex = (CX + inner * math.sin(a)) * s
    ey = (CY - inner * math.cos(a)) * s
    hx = (CX + 0.205 * math.sin(a)) * s
    hy = (CY - 0.205 * math.cos(a)) * s
    bx = (CX + (R_RING + 0.045) * math.sin(math.radians(45))) * s
    by = (CY - (R_RING + 0.045) * math.cos(math.radians(45))) * s
    c = lambda v: f'{v * s:.1f}'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#0d0d0d"/>
<circle cx="{c(CX)}" cy="{c(CY)}" r="{c(inner)}" fill="#184f95"/>
<path d="M{c(CX)} {c(CY)}L{c(CX)} {c(CY - inner)}A{c(inner)} {c(inner)} 0 0 1 {ex:.1f} {ey:.1f}Z" fill="#2a78d6"/>
<circle cx="{c(CX)}" cy="{c(CY)}" r="{c(R_RING)}" fill="none" stroke="#fff" stroke-width="{c(W_RING)}"/>
<rect x="{c(CX - 0.07)}" y="{c(CY - R_RING - 0.105)}" width="{c(0.14)}" height="{c(0.06)}" rx="{c(0.015)}" fill="#fff"/>
<rect x="{c(CX - 0.022)}" y="{c(CY - R_RING - 0.065)}" width="{c(0.044)}" height="{c(0.06)}" rx="{c(0.006)}" fill="#fff"/>
<line x1="{bx - 0.02 * s:.1f}" y1="{by - 0.02 * s:.1f}" x2="{bx + 0.02 * s:.1f}" y2="{by + 0.02 * s:.1f}" stroke="#fff" stroke-width="{c(0.05)}" stroke-linecap="round"/>
<line x1="{c(CX)}" y1="{c(CY)}" x2="{hx:.1f}" y2="{hy:.1f}" stroke="#fff" stroke-width="{c(0.042)}" stroke-linecap="round"/>
<circle cx="{c(CX)}" cy="{c(CY)}" r="{c(0.042)}" fill="#fff"/>
<circle cx="{c(CX)}" cy="{c(CY)}" r="{c(0.016)}" fill="#0d0d0d"/>
</svg>
'''


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, scale in [('icon-192.png', 192, 1.0), ('icon-512.png', 512, 1.0), ('apple-touch-icon.png', 180, 1.0), ('icon-maskable-512.png', 512, 0.8)]:
        write_png(os.path.join(OUT, name), size, size, render(size, scale))
        print('wrote', name)
    with open(os.path.join(OUT, 'icon.svg'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(svg())
    print('wrote icon.svg')


if __name__ == '__main__':
    main()
