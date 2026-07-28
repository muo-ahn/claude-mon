#!/usr/bin/env python3
"""Extract menubar-sized stage sprites from the Terriermon Battle Spirit sheet.

Source sheet: sprites/sheets/terriermon.gif (317x300 GIF-palette, uniform
light-gray background). The sheet only contains Terriermon-stage frames (no
Gargomon/other digivolve frames present), so this script only extracts
digitama/baby/child + limit80/limit95 frames from it -- picked to loosely
track each stage's expected energy (curled ball for digitama, calm stance
for baby, reach/lunge for child, and the sheet's alternate-tinted big poses
for the limit warnings). adult/perfect/ultimate are extracted separately by
scripts/extract_pack_evolved_dwds.py from the Digimon World DS sheet.

Extraction method: the sheet is not scanned in row bands (that approach
pulled in neighboring sprite fragments and half-cropped characters on this
tightly-packed sheet). Instead, background-subtracted pixels are grouped
into connected components (8-connectivity, small gaps bridged) so every
crop window below already corresponds to exactly one complete character,
confirmed by eye against a numbered contact sheet before being hardcoded
here. A couple of sheet elements were deliberately excluded during that
review: a dotted motion-trail effect (no character body) and a tornado/spin
visual effect with no character features.

Usage: python3 scripts/extract_pack_terriermon.py
"""

from PIL import Image

SHEET_PATH = "sprites/sheets/terriermon.gif"
OUT_DIR = "sprites/packs/terriermon"
CANVAS_SIZE = 32
BG_COLOR = (224, 219, 220)

# Each entry: stageId -> list of source crop windows (x0, x1, y0, y1).
# Windows are exact connected-component bounding boxes (one full character
# each), verified visually against
# sprites/packs/_debug/terriermon_candidates.png.
STAGE_WINDOWS = {
    "digitama": [
        (106, 151, 73, 104),  # curled snail-shell coil, roundest pose
        (260, 281, 109, 136), # small curled ball with face
    ],
    "baby": [
        (133, 157, 36, 64),  # standing idle stance
        (5, 30, 37, 64),     # standing idle stance, mirrored
    ],
    "child": [
        (37, 61, 39, 65),  # standing stance, calm expression
        (69, 95, 38, 64),  # standing stance, alert expression, same facing
    ],
}

# Rate-limit warning states for the menubar mascot. Output as
# sprites/packs/terriermon/{id}-{n}.png (same 32x32 RGBA convention as
# STAGE_WINDOWS). These reuse the sheet's alternate-tinted big poses, which
# read as a distinct "off" state well suited to a warning indicator.
ALERT_WINDOWS = {
    "limit80": [
        (232, 252, 164, 184),  # alternate-tinted big pose
        (156, 190, 206, 231),  # alternate-tinted big pose, variant
    ],
    "limit95": [
        (48, 72, 196, 233),   # crouched/sitting low-energy pose
        (85, 113, 197, 232),  # crouched pose, other angle
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
