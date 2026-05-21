#!/usr/bin/env python3
"""Generate the extension's PNG icons (pure stdlib, no dependencies).

Draws a Bandcamp-style blue parallelogram with a white Cast glyph. Edges are
supersampled in x only, so slanted edges stay smooth while horizontal edges
stay crisp. Run from anywhere: `python3 tools/make_icons.py`.
"""
import os
import struct
import zlib

ACCENT = (29, 160, 195)
WHITE = (255, 255, 255)

# The icon is a Bandcamp-style parallelogram: an upright rectangle sheared
# horizontally so each row shifts right toward the top. The values below
# describe the un-sheared rectangle, normalized to 0..1.
PAR_X = 0.09       # left edge of the rectangle
PAR_Y0 = 0.18      # top edge
PAR_Y1 = 0.82      # bottom edge
PAR_W = 0.62       # width of every row
SKEW = 0.22        # horizontal shift between the bottom and top edges
GLYPH = 0.52       # side of the centred square holding the cast glyph


def rrect(x, y, x0, y0, x1, y1, r):
    """True if (x, y) is inside the rounded rectangle."""
    dx = max(x0 + r - x, 0.0, x - (x1 - r))
    dy = max(y0 + r - y, 0.0, y - (y1 - r))
    return dx * dx + dy * dy <= r * r


def glyph(nx, ny):
    """True where the white Cast symbol should be drawn (normalized coords).

    A sharp-cornered rectangular "screen" outline with a square notch cut from
    its bottom-left corner, plus two square (L-shaped) broadcast waves and a
    square dot.
    """
    # Screen: a sharp-cornered rectangular outline band (radius 0).
    st = 0.088
    on_screen = (
        rrect(nx, ny, 0.15, 0.18, 0.86, 0.80, 0.0)
        and not rrect(nx, ny, 0.15 + st, 0.18 + st, 0.86 - st, 0.80 - st, 0.0)
    )
    # The notch keeps the arcs visually separate from the screen.
    notch = nx < 0.585 and ny > 0.41
    if on_screen and not notch:
        return True

    # Broadcast arcs + square dot, at the screen's bottom-left corner.
    dx, dy = nx - 0.205, 0.785 - ny
    if abs(dx) <= 0.072 and abs(dy) <= 0.072:   # square dot
        return True
    if dx >= 0.0 and dy >= 0.0:                 # square (L-shaped) waves
        d = max(dx, dy)                         # Chebyshev distance → squares
        for radius in (0.165, 0.285):
            if abs(d - radius) <= 0.042:
                return True
    return False


def render(size, ss=16):
    """Render one icon at `size` px.

    Supersampled in x only: every final pixel row is sampled once, so all
    horizontal edges land exactly on whole pixel rows (crisp, no
    anti-aliasing). Slanted edges are still smoothed across `ss` x-samples.
    """
    sw = size * ss                 # supersampled width; height stays `size`
    buf = bytearray(sw * size * 4)
    # Default: accent RGB with alpha 0, so downsampled edges stay clean.
    for i in range(0, len(buf), 4):
        buf[i], buf[i + 1], buf[i + 2], buf[i + 3] = ACCENT[0], ACCENT[1], ACCENT[2], 0

    height = PAR_Y1 - PAR_Y0
    gx0 = PAR_X + (PAR_W - GLYPH) / 2
    gy0 = PAR_Y0 + (height - GLYPH) / 2

    for y in range(size):
        ny = (y + 0.5) / size      # one sample per final row → crisp h-edges
        # Horizontal shear: rows shift right toward the top, turning the
        # rectangle into a parallelogram with sharp corners.
        shift = SKEW * (PAR_Y1 - ny) / height
        for x in range(sw):
            nx = (x + 0.5) / sw
            ux = nx - shift            # un-sheared x
            if not (PAR_X <= ux <= PAR_X + PAR_W and PAR_Y0 <= ny <= PAR_Y1):
                continue
            i = (y * sw + x) * 4
            # Map into the centred square that holds the cast glyph.
            if glyph((ux - gx0) / GLYPH, (ny - gy0) / GLYPH):
                buf[i], buf[i + 1], buf[i + 2], buf[i + 3] = WHITE + (255,)
            else:
                buf[i + 3] = 255

    # Box downsample across x only.
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            base = (y * sw + x * ss) * 4
            for k in range(ss):
                p = base + k * 4
                r += buf[p]; g += buf[p + 1]; b += buf[p + 2]; a += buf[p + 3]
            o = (y * size + x) * 4
            out[o], out[o + 1], out[o + 2], out[o + 3] = r // ss, g // ss, b // ss, a // ss
    return out


def write_png(path, size, rgba):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0
        raw += rgba[y * size * 4:(y + 1) * size * 4]

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(os.path.dirname(here), 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 48, 128):
        write_png(os.path.join(out_dir, f'icon{size}.png'), size, render(size))
        print(f'wrote icons/icon{size}.png')
