#!/usr/bin/env python3
"""Extract a 32x32 sprite pack for Veemon from the GBA Digimon Battle
Spirit character sheet (sprites/sheets/veemon.png, 356x1075 RGB, light
blue uniform background).

This sheet is labeled by section (STAND TYPES/DUCK, WALK(RUN)/SLIDE,
JUMP/LAND, TAUNT, ATTACKS, AERIAL ATTACKS, DAMAGE/RECOVERY), which made
mapping straightforward. No distinct evolved-form (ExVeemon/Imperialdramon)
body shape was found anywhere on the sheet -- every frame is the same
Veemon silhouette; the two large painterly renders at the very bottom
of the sheet are cover/signature art for the "Trance" rip, not sprite
frames, and were not used. Per the pack fallback rule, perfect/ultimate
use Veemon's in-sheet "Vee Punch" attack, whose boxing glove visibly
grows from normal size to a huge overgrown glove across the ATTACKS
section -- perfect takes a mid-charge frame, ultimate takes the peak
frame, mirroring the perfect=power-stance / ultimate=full-effect split
used for the Agumon and Gabumon packs.

Usage: python3 scripts/extract_pack_veemon.py
"""

from PIL import Image

SHEET_PATH = "sprites/sheets/veemon.png"
OUT_DIR = "sprites/packs/veemon"
CANVAS_SIZE = 32
BG_COLOR = (196, 225, 255)

# Each entry: stageId -> list of source crop windows (x0, x1, y0, y1).
# Windows are generous; the actual sprite is tight-cropped out of each window.
FRAME_WINDOWS = {
    "digitama": [
        (175, 202, 84, 114),   # Duck row, frame 1
        (202, 225, 84, 114),   # Duck row, frame 2
    ],
    "baby": [
        (6, 33, 39, 71),       # Stand Types row, frame 1
        (32, 58, 39, 71),      # Stand Types row, frame 2
    ],
    "child": [
        (5, 32, 148, 182),     # Walk row, frame 1
        (89, 117, 150, 182),   # Walk row, frame 4 (opposite stride)
    ],
    "adult": [
        (40, 78, 184, 223),    # Run row, dust-cloud frame 1
        (77, 115, 184, 223),   # Run row, dust-cloud frame 2
    ],
    "perfect": [
        (61, 95, 608, 644),    # Vee Punch: glove mid-charge
        (95, 126, 600, 644),   # Vee Punch: glove growing bigger
    ],
    "ultimate": [
        (97, 125, 600, 644),   # Vee Punch: glove near peak size
        (125, 149, 598, 644),  # Vee Punch: glove at peak size
    ],
    "limit80": [
        (5, 32, 878, 922),     # Damage/Recovery: reeling from hit
        (67, 99, 887, 922),    # Damage/Recovery: knocked into a tumble
    ],
    "limit95": [
        (21, 48, 930, 952),    # Damage/Recovery: flat on the ground
        (48, 84, 943, 963),    # Damage/Recovery: flat on the ground, variant
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
