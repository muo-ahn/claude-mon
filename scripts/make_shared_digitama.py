#!/usr/bin/env python3
"""Draw the shared Digi-Egg (digitama) sprite used by every pack.

A Digi-Egg looks the same whoever is inside it, so the digitama stage is
species-agnostic and all packs share one sprite instead of each extract script
picking a Rookie pose out of its own sheet (which is what made stage 1 look
like a small standing Digimon rather than an egg).

Two frames: an upright egg and a slightly leaning, 1px shorter one, so the
menubar animation reads as a rocking egg. The lean is deliberately one-sided --
a symmetric +/- lean on a near-symmetric egg would render as a plain left/right
flip, the exact artifact this project already had to fix once.

Usage: python3 scripts/make_shared_digitama.py
"""

import os

from PIL import Image

OUT_DIR = "sprites/shared"
CANVAS = 32
CX = 16
BASE_Y = 30

# Egg silhouette: half-width per row, crown -> base. Widest at ~60% down, which
# is what reads as "egg" rather than "pear" or "bell".
HALF = [2, 3, 4, 5, 6, 7, 7, 8, 8, 9, 9, 9, 10, 10, 10, 10, 10, 10, 9, 9, 8, 8, 7, 6, 4]

OUTLINE = (34, 30, 40, 255)
SHELL = (249, 246, 235, 255)
SHADE = (208, 200, 178, 255)
HIGHLIGHT = (255, 255, 255, 255)
MARK = (64, 182, 172, 255)

# Three upward teal triangles across the belly.
MARK_OFFSETS = (-6, 0, 6)
MARK_APEX_ROW = 15
MARK_HEIGHT = 4


def egg_rows(lean, squash):
    """Rows as (y, half_width, x_offset). `squash` trims rows off the crown so
    the leaning frame also sits a pixel lower, like an egg settling."""
    widths = HALF[squash:]
    top = BASE_Y - len(widths) + 1
    span = max(1, BASE_Y - top)
    return [(top + i, h, round(lean * (BASE_Y - (top + i)) / span))
            for i, h in enumerate(widths)], top


def build(lean, squash):
    rows, _ = egg_rows(lean, squash)
    shell = {(x, y)
             for (y, h, dx) in rows
             for x in range(CX - h + dx, CX + h + dx + 1)}

    im = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    px = im.load()
    for point in shell:
        px[point] = SHELL

    for i, (y, h, dx) in enumerate(rows):
        for x in range(CX + h + dx - 1, CX + h + dx + 1):
            px[x, y] = SHADE
        if 3 <= i <= 10:
            px[CX - h + dx + 1, y] = HIGHLIGHT

    for offset in MARK_OFFSETS:
        for row in range(MARK_HEIGHT):
            i = MARK_APEX_ROW - squash + row
            if not 0 <= i < len(rows):
                continue
            y, _, dx = rows[i]
            reach = min(row, 2)
            for x in range(CX + offset - reach + dx, CX + offset + reach + dx + 1):
                if (x, y) in shell:
                    px[x, y] = MARK

    # Outline dilated outward, so it never eats into the shell.
    for (x, y) in shell:
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if (nx, ny) not in shell and 0 <= nx < CANVAS and 0 <= ny < CANVAS:
                px[nx, ny] = OUTLINE
    return im


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for n, (lean, squash) in enumerate(((0.0, 0), (1.6, 1))):
        path = os.path.join(OUT_DIR, f"digitama-{n}.png")
        build(lean, squash).save(path)
        print(f"wrote {path} (lean={lean}, squash={squash})")


if __name__ == "__main__":
    main()
