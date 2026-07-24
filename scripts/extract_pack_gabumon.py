#!/usr/bin/env python3
"""Extract a 32x32 sprite pack for Gabumon from the GBA Digimon Battle
Spirit character sheet (sprites/sheets/gabumon.gif, 400x838 palette GIF,
teal/green uniform background).

Unlike Agumon's sheet, this one has richer state coverage: a full
tumble/roll-onto-back animation (used for limit95), a red-face hit
reaction row (used for limit80), and compact curled/seated poses (used
for digitama). No distinct evolved-form (Garurumon/MetalGarurumon) body
shape was found anywhere on the sheet after a full row-by-row scan --
every frame is the same Gabumon silhouette. Per the pack fallback rule,
perfect uses Gabumon's in-sheet "power up" recolor (yellow belly turning
to a red armor plate, the closest thing to a digivolve visual on this
sheet) and ultimate uses the named Blue Blaster ranged attack, mirroring
the perfect=power-stance / ultimate=special-attack split used for the
Agumon pack.

Usage: python3 scripts/extract_pack_gabumon.py
"""

from PIL import Image

SHEET_PATH = "sprites/sheets/gabumon.gif"
OUT_DIR = "sprites/packs/gabumon"
CANVAS_SIZE = 32
BG_COLOR = (2, 100, 76)

# Each entry: stageId -> list of source crop windows (x0, x1, y0, y1).
# Windows are generous; the actual sprite is tight-cropped out of each window.
FRAME_WINDOWS = {
    "digitama": [
        (11, 49, 620, 652),   # Curled/seated row, frame 1
        (98, 142, 620, 652),  # Curled/seated row, frame 3
    ],
    "baby": [
        (7, 37, 8, 42),       # Idle row, frame 1
        (42, 72, 7, 42),      # Idle row, frame 2
    ],
    "child": [
        (3, 41, 401, 437),    # Walk row, frame 1 (leaning stride, no dust)
        (45, 83, 401, 437),   # Walk row, frame 2 (opposite stride)
    ],
    "adult": [
        (196, 227, 258, 297),  # Run row, dust-cloud frame 1
        (230, 262, 258, 297),  # Run row, dust-cloud frame 2
    ],
    "perfect": [
        (187, 231, 656, 697),  # Power-up row: red chest armor starting
        (233, 265, 656, 697),  # Power-up row: more red armor visible
    ],
    "ultimate": [
        (210, 259, 176, 211),  # Blue Blaster: breath stream mid-release
        (267, 333, 176, 211),  # Blue Blaster: breath stream full extension
    ],
    "limit80": [
        (75, 105, 541, 579),   # Hit-reaction row: red flash face, frame 3
        (107, 140, 541, 579),  # Hit-reaction row: red flash face, frame 4
    ],
    "limit95": [
        (122, 165, 352, 390),  # Tumble row: rolling onto side
        (211, 256, 352, 390),  # Tumble row: flat on back
    ],
}


def tight_bbox(px, x0, x1, y0, y1):
    minx, miny, maxx, maxy = x1, y1, x0, y0
    found = False
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if px[x, y] != BG_COLOR:
                found = True
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    if not found:
        raise ValueError(f"no non-background pixels in window ({x0},{x1},{y0},{y1})")
    return minx, miny, maxx, maxy


def make_transparent(frame_rgb):
    frame_rgba = frame_rgb.convert("RGBA")
    pixels = frame_rgba.load()
    w, h = frame_rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if (r, g, b) == BG_COLOR:
                pixels[x, y] = (r, g, b, 0)
    return frame_rgba


def fit_to_canvas(frame_rgba):
    w, h = frame_rgba.size
    scaled = False
    if w > CANVAS_SIZE or h > CANVAS_SIZE:
        scale = min(CANVAS_SIZE / w, CANVAS_SIZE / h)
        new_w = max(1, int(w * scale))
        new_h = max(1, int(h * scale))
        frame_rgba = frame_rgba.resize((new_w, new_h), Image.NEAREST)
        w, h = new_w, new_h
        scaled = True
    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    paste_x = (CANVAS_SIZE - w) // 2
    paste_y = CANVAS_SIZE - h
    canvas.paste(frame_rgba, (paste_x, paste_y), frame_rgba)
    return canvas, scaled


def main():
    sheet = Image.open(SHEET_PATH).convert("RGB")
    px = sheet.load()
    scaled_stages = []

    for stage_id, windows in FRAME_WINDOWS.items():
        for n, (x0, x1, y0, y1) in enumerate(windows):
            minx, miny, maxx, maxy = tight_bbox(px, x0, x1, y0, y1)
            frame_rgb = sheet.crop((minx, miny, maxx + 1, maxy + 1))
            frame_rgba = make_transparent(frame_rgb)
            canvas, scaled = fit_to_canvas(frame_rgba)
            if scaled:
                scaled_stages.append(f"{stage_id}-{n}")
            out_path = f"{OUT_DIR}/{stage_id}-{n}.png"
            canvas.save(out_path)
            print(f"wrote {out_path} (source {maxx - minx + 1}x{maxy - miny + 1})")

    # idle-{0,1} is a copy of baby-{0,1}.
    for n in range(2):
        src = Image.open(f"{OUT_DIR}/baby-{n}.png")
        src.save(f"{OUT_DIR}/idle-{n}.png")
        print(f"wrote {OUT_DIR}/idle-{n}.png (copy of baby-{n})")

    if scaled_stages:
        print(f"downscaled to fit 32x32: {', '.join(scaled_stages)}")


if __name__ == "__main__":
    main()
