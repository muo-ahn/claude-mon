#!/usr/bin/env python3
"""Extract menubar-sized baby/child sprites from the Guilmon Battle Spirit 1.5
sheet, plus the shared limit80/limit95 alert frames.

Source sheet: sprites/guilmon15.png (1201x1918 RGB, uniform purple background).
The sheet contains only Guilmon's own move set, so this script only extracts
baby/child + limit80/limit95 frames from it. adult/perfect/ultimate
(Growlmon/WarGrowlmon/Gallantmon) are extracted separately by
scripts/extract_pack_evolved_dwds.py from the Digimon World DS sheet -- do
not add those stages back here, since re-running this script would overwrite
the DWDS-sourced dots with this sheet's Rookie-only frames (species mismatch;
this happened once and had to be recovered from). For each stage this picks
two (or more) frames from a specific motion row on the sheet, tight-crops
them to their sprite content, makes the background transparent, and places
them bottom-center on a 32x32 RGBA canvas. Frames larger than 32px in either
dimension are downscaled with NEAREST to preserve the hard pixel-art edges.

Usage: python3 scripts/extract-sprites.py
"""

from PIL import Image

SHEET_PATH = "sprites/guilmon15.png"
OUT_DIR = "sprites/packs/guilmon"
CANVAS_SIZE = 32
BG_COLOR = (111, 49, 152)

# Each entry: stageId -> list of source crop windows (x0, x1, y0, y1).
# Windows are generous; the actual sprite is tight-cropped out of each window.
#
# adult/perfect/ultimate are deliberately absent: this sheet only has Guilmon
# (Rookie) art, so those three stages come from extract_pack_evolved_dwds.py
# instead, which pulls the correctly-evolved Growlmon/WarGrowlmon/Gallantmon
# dots from a Digimon World DS sheet. Re-adding them here would overwrite
# those DWDS dots with Guilmon-shaped frames under the evolved stages' names.
#
# digitama is also absent: the menubar always reads the Digi-Egg sprite from
# sprites/shared/, never from a pack directory (see
# menubar/claudemon-menubar.swift's `sharedStages = ["digitama"]`), so a
# per-pack digitama-*.png here would be dead output the app never loads.
STAGE_WINDOWS = {
    "baby": [
        (8, 36, 10, 40),      # Idle row, frame 1
        (45, 73, 10, 40),     # Idle row, frame 2
    ],
    "child": [
        (11, 35, 291, 322),   # Walking row, frame 1
        (69, 93, 291, 322),   # Walking row, frame 3
    ],
}

# Rate-limit warning states for the menubar mascot. Output as
# sprites/packs/guilmon/{id}-{n}.png (same 32x32 RGBA convention as STAGE_WINDOWS).
ALERT_WINDOWS = {
    "limit80": [
        (69, 92, 700, 747),    # Hit row, frame 3: reeling back, sweat drop, panting
        (126, 150, 700, 747),  # Hit row, frame 5: reeling back, two sweat drops
    ],
    "limit95": [
        (413, 453, 1633, 1663),  # Win row lie-down loop, frame 1: flat on ground, small breath bubble
        (586, 627, 1633, 1663),  # Win row lie-down loop, frame 5: flat on ground, breath bubble at its largest
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

    for stage_id, windows in {**STAGE_WINDOWS, **ALERT_WINDOWS}.items():
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

    if scaled_stages:
        print(f"downscaled to fit 32x32: {', '.join(scaled_stages)}")


if __name__ == "__main__":
    main()
