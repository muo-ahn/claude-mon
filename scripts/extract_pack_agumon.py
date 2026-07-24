#!/usr/bin/env python3
"""Extract a 32x32 sprite pack for Agumon from the GBA Digimon Battle
Spirit character sheet (sprites/sheets/agumon.gif, 308x686 palette GIF,
teal/green uniform background).

The sheet contains only Agumon's own move set (idle, walk, run, claw
combo, roar, Pepper Breath fireball throw) -- no distinct evolved-form
(Greymon/WarGreymon) frames were found anywhere on the sheet after a
full row-by-row visual scan. Per the pack fallback rule, perfect/ultimate
use Agumon's strongest in-sheet frames (roar -> Pepper Breath fireball
throw) instead of a true digivolution sprite. The sheet also has no
explicit hit-reaction or knock-out/lying frame, so limit80/limit95 use
the closest available tired/hunched poses.

Usage: python3 scripts/extract_pack_agumon.py
"""

from PIL import Image

SHEET_PATH = "sprites/sheets/agumon.gif"
OUT_DIR = "sprites/packs/agumon"
CANVAS_SIZE = 32
BG_COLOR = (0, 156, 107)

# Each entry: stageId -> list of source crop windows (x0, x1, y0, y1).
# Windows are generous; the actual sprite is tight-cropped out of each window.
FRAME_WINDOWS = {
    "digitama": [
        (14, 44, 166, 196),   # Walk row, frame 1: compact standing stance
        (117, 148, 166, 196),  # Walk row, frame 4: arms crossed, guard-like
    ],
    "baby": [
        (17, 46, 44, 76),     # Idle row, frame 1
        (48, 75, 44, 76),     # Idle row, frame 2
    ],
    "child": [
        (46, 76, 166, 196),   # Walk row, frame 2 (mid-stride)
        (150, 184, 166, 196),  # Walk row, frame 5 (opposite stride, arm up)
    ],
    "adult": [
        (10, 49, 330, 367),   # Running row, frame 1 (dust cloud trail)
        (90, 127, 330, 367),  # Running row, frame 3 (dust cloud trail)
    ],
    "perfect": [
        (9, 43, 420, 458),    # Roar row, frame 1: roar wind-up
        (80, 118, 420, 458),  # Roar row, frame 3: full roar, mouth wide
    ],
    "ultimate": [
        (196, 244, 425, 458),  # Pepper Breath: charging fireball, body glow
        (243, 297, 425, 458),  # Pepper Breath: fireball released, full effect
    ],
    "limit80": [
        (183, 213, 168, 196),  # Walk row, frame 6: eyes squinting, tired
        (215, 246, 168, 196),  # Walk row, frame 7: eyes closed, more tired
    ],
    "limit95": [
        (17, 44, 87, 118),    # Claw-combo row, frame 1: hunched forward
        (151, 182, 129, 159),  # Dive-attack row, frame 4: low, collapsed stance
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
