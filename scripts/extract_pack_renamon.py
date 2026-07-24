#!/usr/bin/env python3
"""Extract menubar-sized stage sprites from the Renamon Battle Spirit sheet.

Source sheet: sprites/sheets/renamon.gif (347x500 GIF-palette, uniform
light-gray background). The sheet only contains Rookie-stage Renamon frames
(no Sakuyamon digivolve frames present), so every stage below falls back to
one of Renamon's own poses per the pack fallback convention -- picked to
loosely track the stage's expected energy (calm stance for digitama/baby,
more active poses for adult/perfect, biggest/fiercest poses for ultimate,
flinch-like poses for the limit warnings).

Extraction method: the sheet is not scanned in row bands (that approach
pulled in neighboring sprite fragments and half-cropped characters on this
tightly-packed sheet). Instead, background-subtracted pixels are grouped
into connected components (8-connectivity, small gaps bridged) so every
crop window below already corresponds to exactly one complete character,
confirmed by eye against a numbered contact sheet before being hardcoded
here.

Usage: python3 scripts/extract_pack_renamon.py
"""

from PIL import Image

SHEET_PATH = "sprites/sheets/renamon.gif"
OUT_DIR = "sprites/packs/renamon"
CANVAS_SIZE = 32
BG_COLOR = (224, 219, 220)

# Each entry: stageId -> list of source crop windows (x0, x1, y0, y1).
# Windows are exact connected-component bounding boxes (one full character
# each), verified visually against sprites/packs/_debug/renamon_candidates.png.
STAGE_WINDOWS = {
    "digitama": [
        (7, 33, 68, 98),    # small idle stance, facing left
        (71, 93, 68, 98),   # small idle stance, mirrored
    ],
    "baby": [
        (39, 63, 68, 97),   # idle stance variant
        (101, 134, 72, 104),  # small surprised/alert pose
    ],
    "child": [
        (84, 121, 108, 140),  # forward fighting stance, fist raised
        (81, 106, 396, 431),  # walking pose, leg stepping forward
    ],
    "adult": [
        (46, 74, 104, 139),   # forward fighting stance, larger
        (35, 72, 398, 435),   # forward stance, leg forward
    ],
    "perfect": [
        (1, 42, 194, 229),    # Diamond Storm charge, fire-paw pose
        (195, 232, 299, 332), # attack pose with slash-effect swirl
    ],
    "ultimate": [
        (36, 81, 347, 392),   # biggest jump-kick pose with sparkle effect
        (167, 208, 202, 235), # big spin-kick pose with slash effect
    ],
}

# Rate-limit warning states for the menubar mascot. Output as
# sprites/packs/renamon/{id}-{n}.png (same 32x32 RGBA convention as STAGE_WINDOWS).
ALERT_WINDOWS = {
    "limit80": [
        (179, 221, 255, 284),  # standing pose, arms out (flinch-adjacent)
        (0, 32, 345, 382),     # small running/recoiling pose
    ],
    "limit95": [
        (89, 121, 149, 197),  # curled, tail-wrapped defensive pose
        (155, 184, 297, 334), # crouched pose, large tail (low-energy)
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
