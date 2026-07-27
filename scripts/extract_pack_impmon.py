#!/usr/bin/env python3
"""Extract menubar-sized stage sprites from the Impmon Battle Spirit sheet.

Source sheet: sprites/sheets/impmon.gif (964x1950 GIF-palette, uniform pure
green background). The sheet contains three palette-swapped copies of
Rookie-stage Impmon only (labeled rows: idle, walking, walking plus, jump,
land, fall, jump2, HAHA!, defend, shot1, shot2, shot miss, in-air variants,
hit, hit2, on fire, shocked, win, lose) -- no Beelzemon digivolve frames are
present anywhere on the sheet, so this script only extracts digitama/baby/
child + limit80/limit95 frames from it. adult/perfect/ultimate are
extracted separately by scripts/extract_pack_evolved_dwds.py from the
Digimon World DS sheet. All windows below are taken from the first (vivid
blue "real color") copy in the top-left corner.

Usage: python3 scripts/extract_pack_impmon.py
"""

from PIL import Image

SHEET_PATH = "sprites/sheets/impmon.gif"
OUT_DIR = "sprites/packs/impmon"
CANVAS_SIZE = 32
BG_COLOR = (0, 128, 0)

# Each entry: stageId -> list of source crop windows (x0, x1, y0, y1).
# Windows are generous; the actual sprite is tight-cropped out of each window.
STAGE_WINDOWS = {
    "digitama": [
        (103, 136, 404, 437),  # Defend row, frame 1: calm guard stance
        (336, 370, 412, 442),  # Defend row, frame 4: standing, arms out guard
    ],
    "baby": [
        (17, 49, 10, 42),  # idle row, frame 1
        (48, 80, 9, 42),   # idle row, frame 2
    ],
    "child": [
        (26, 64, 122, 160),  # Walking row, frame 1
        (64, 101, 122, 160),  # Walking row, frame 2
    ],
}

# Rate-limit warning states for the menubar mascot. Output as
# sprites/packs/impmon/{id}-{n}.png (same 32x32 RGBA convention as
# STAGE_WINDOWS).
ALERT_WINDOWS = {
    "limit80": [
        (191, 229, 410, 442),  # Hit row: shocked impact, motion lines
        (231, 264, 409, 442),  # Hit row: recoil, arms flung up
    ],
    "limit95": [
        (834, 866, 552, 577),  # Hit2 row: knocked down, lying on ground
        (879, 910, 554, 577),  # Hit2 row: knocked down, second lying frame
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

    # idle is a straight copy of baby (contract requires both filenames).
    for n in range(2):
        src = Image.open(f"{OUT_DIR}/baby-{n}.png")
        src.save(f"{OUT_DIR}/idle-{n}.png")
        print(f"wrote {OUT_DIR}/idle-{n}.png (copy of baby-{n})")

    if scaled_stages:
        print(f"downscaled to fit 32x32: {', '.join(scaled_stages)}")


if __name__ == "__main__":
    main()
