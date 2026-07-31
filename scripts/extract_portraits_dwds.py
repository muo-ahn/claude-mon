#!/usr/bin/env python3
"""Extract high-res battle-pose portraits from Digimon World DS sheets.

Companion to extract_pack_evolved_dwds.py, which pulls the ~32px field/walking
sprites near the bottom of each DWDS sheet for the menubar icon. Those are too
small to read once blown up, so this script instead grabs the big battle-pose
artwork every sheet carries near the top (roughly 100-180px tall, 3-5 poses
per sheet) and saves it at native resolution as a portrait.

Detection strategy: unlike the field-frame row (one row, small uniform cells,
found by sliding a band down the sheet), the battle poses sit in a block of
their own colour panels near the top, while credit text / rip-icon clutter is
scattered elsewhere on the same sheet. So instead of banding:

1. Sample the sheet's outer edge pixels (border_colors) to find the *sheet*
   backdrop colour(s) -- corners and margins are reliably empty on every sheet
   we have. This is different from dominant_colors(im, ...), which looks at
   the whole image and gets fooled on some sheets: a common outline/shading
   grey used inside every pose can individually cover a few percent of the
   total pixels, enough to be misread as a second backdrop colour and shred
   each pose into fragments too small to pass the size filter.
2. Flood-fill everything that isn't that backdrop colour (components(),
   merge_touching() -- both reused from extract_pack_evolved_dwds.py) and
   keep components in the size range a battle pose actually occupies.
3. Group survivors into rows by y-overlap and drop rows with only one member.
   A genuine pose row always has 2+ poses; a stray credit-text box or rip
   logo sitting off by itself is always alone in its row. This is what
   filters those out instead of a hand-picked box (checked against every
   sheet -- see verification note below).
4. The raw box from step 3 is often the whole colour panel/cell, not a tight
   crop of the character -- cell_backdrops() (reused) + is_backdrop() strip
   that panel colour per-crop and getbbox() tightens it, exactly like
   to_sprite() does for field frames, just without the 32x32 downscale.

Frame 0 is always the first pose in reading order (top-left, the sheet's main
idle/front pose in every sample we have). Frame 1 is chosen from the
remaining poses: the last one (in reading order) whose *tightly-cropped* size
is within +/-15% of frame 0's on both axes, since a wildly different size
would visibly "pop" when the menubar swaps frames -- and skipped if the
sheets's other poses don't have anything that close. Sheets where this
heuristic lands on a bad choice get an explicit override in POSE_OVERRIDES.

Usage: python3 scripts/extract_portraits_dwds.py [pack ...]
"""

import os
import sys
from collections import Counter

from PIL import Image

from extract_pack_evolved_dwds import (
    cell_backdrops,
    components,
    is_backdrop,
    merge_touching,
)

SHEET_DIR = "sprites/sheets/dwds"
PACK_DIR = "sprites/packs"

# Battle-pose size window (pixels). Field frames (the OTHER script's target)
# top out around 44x52, so anything above that is a big pose, not a field
# sprite or a stray icon-grid cell.
MIN_POSE_H, MAX_POSE_H = 60, 260
MIN_POSE_W, MAX_POSE_W = 40, 220
MIN_POSE_PX = 800

# Row clustering: boxes whose y-ranges actually overlap belong to the same
# pose row. 0, not a fuzzy tolerance -- on some sheets (metalgreymon,
# growlmon) the real gap between row 1 and row 2 is as little as 9px, well
# inside the y0 jitter a tolerant gap would need to hold a row together, so
# any positive slack here starts merging distinct rows.
ROW_GAP = 0

# Frame-1 acceptance window relative to frame 0's tight crop size.
SIZE_TOL = 0.15

# pack -> stage -> DWDS sheet, reusing the same mapping as
# extract_pack_evolved_dwds.PICKS (sheet names only; that script's frame
# indices are for the *field*-frame row and don't apply here).
PACK_SHEETS = {
    "agumon": {"adult": "greymon", "perfect": "metalgreymon", "ultimate": "wargreymon"},
    "guilmon": {"adult": "growlmon", "perfect": "wargrowlmon", "ultimate": "gallantmon"},
    "gabumon": {"adult": "garurumon", "perfect": "weregarurumon", "ultimate": "metalgarurumon"},
    "veemon": {"adult": "exveemon", "perfect": "paildramon", "ultimate": "imperialdramon_fm"},
    "renamon": {"adult": "kyubimon", "perfect": "taomon", "ultimate": "sakuyamon"},
    "terriermon": {"adult": "gargomon", "perfect": "rapidmon", "ultimate": "megagargomon"},
    "impmon": {"adult": "devimon", "perfect": "myotismon", "ultimate": "beelzemon"},
    "keramon": {"adult": "kurisarimon", "perfect": "infermon", "ultimate": "diaboromon"},
    "falcomon": {"adult": "peckmon", "perfect": "yatagaramon", "ultimate": "varodurumon"},
}

# Manual overrides for sheets where the size-ratio heuristic either picks a
# poor frame 1 or (mistakenly) skips a perfectly good one. Keyed by sheet
# name; value is (frame0_index, frame1_index_or_None) into the flattened
# pose-candidate list (reading order: row by row, left to right; use a
# throwaway print in pick_frames to see the indices for a given sheet).
POSE_OVERRIDES = {
    # Every sheet below has a clean, clearly-recognisable second action pose
    # in its other row, but it misses the +/-15% size check by 15-30% (an
    # arm-cannon or a spread wing sticking out past the idle-pose bbox is
    # usually why). Left on auto-pick, most either got no frame 1 at all or
    # -- worse -- fell back to a same-row idle-animation duplicate. Since
    # save_pair() pads both frames to a shared canvas regardless, the size
    # mismatch these were rejected for doesn't actually show up as a jump;
    # picked by eye against a contact sheet, see the module docstring.
    "myotismon": (0, 4),         # wings-spread pose over the cloak/back view
    "metalgreymon": (0, 3),      # wings-spread roar over the size-fail-only alts
    "paildramon": (0, 4),        # open-mouth roar pose
    "imperialdramon_fm": (0, 5), # wings-spread sword pose (idx3 is a same-size dup)
    "kyubimon": (0, 4),          # tails-spread burst pose
    "taomon": (0, 4),            # crossed-arms side lunge over the back view
    "sakuyamon": (0, 3),         # full front staff-raised stance
    "beelzemon": (0, 3),         # wide crouch, cannons drawn
}


def border_colors(im, min_share=0.10, thickness=6):
    """Backdrop colour(s) sampled from the sheet's outer margin. More
    reliable than a whole-image dominant_colors() pass here: a pose's own
    outline/shading grey can recur often enough across a whole sheet to read
    as a second backdrop colour globally, but it never dominates the actual
    border since every sheet leaves its edges empty."""
    w, h = im.size
    px = im.load()
    pts = []
    for x in range(w):
        for t in range(thickness):
            pts.append(px[x, t])
            pts.append(px[x, h - 1 - t])
    for y in range(h):
        for t in range(thickness):
            pts.append(px[t, y])
            pts.append(px[w - 1 - t, y])
    hist = Counter(c for c in pts if c[3] >= 32)
    total = sum(hist.values()) or 1
    return {c for c, n in hist.items() if n / total >= min_share}


def cluster_rows(boxes, gap=ROW_GAP):
    """Group boxes into pose rows by y-overlap and drop rows with a single
    member. A real pose row always has 2+ poses; a stray credit-text box or
    rip-logo fragment that happens to pass the size filter is always alone
    in its row, so this reliably drops it without hand-picked boxes. Returns
    rows top-to-bottom, each sorted left-to-right."""
    boxes = sorted(boxes, key=lambda b: b[1])
    rows = []
    for b in boxes:
        for row in rows:
            ry0 = min(r[1] for r in row)
            ry1 = max(r[3] for r in row)
            if b[1] <= ry1 + gap and ry0 <= b[3] + gap:
                row.append(b)
                break
        else:
            rows.append([b])
    rows = [sorted(row, key=lambda b: b[0]) for row in rows if len(row) >= 2]
    rows.sort(key=lambda row: row[0][1])
    return rows


def detect_pose_boxes(sheet):
    """Return the sheet's battle-pose candidate rows, top-to-bottom, each
    row sorted left-to-right, plus the sheet-level backdrop colours."""
    im = Image.open(os.path.join(SHEET_DIR, sheet + ".png")).convert("RGBA")
    backdrops = border_colors(im)
    boxes = components(im, backdrops)
    for _ in range(4):
        boxes = merge_touching(boxes)
    boxes = [
        b for b in boxes
        if MIN_POSE_H <= b[3] - b[1] + 1 <= MAX_POSE_H
        and MIN_POSE_W <= b[2] - b[0] + 1 <= MAX_POSE_W
        and b[4] >= MIN_POSE_PX
    ]
    return im, cluster_rows(boxes), backdrops


def crop_pose(im, box, sheet_backdrops=()):
    """Tightly crop one pose out of its raw candidate box: strip the panel's
    own backdrop colour (reused cell_backdrops()/is_backdrop(), same as
    to_sprite() in extract_pack_evolved_dwds.py) and trim to content. Unlike
    to_sprite(), this keeps native resolution -- no 32x32 downscale.

    cell_backdrops() only samples the crop's own corners, so a raw box with
    a sliver of the sheet's real background *not* touching a corner (seen on
    beelzemon, where a panel-sized box left a solid teal patch by a foot)
    slips through. Folding in the sheet-level border_colors() result as a
    second, always-on set of backdrop colours catches that without changing
    the corner-based per-panel logic that handles each cell's own colour."""
    crop = im.crop((box[0], box[1], box[2] + 1, box[3] + 1)).convert("RGBA")
    backdrops = cell_backdrops(crop) | set(sheet_backdrops)
    px = crop.load()
    for y in range(crop.height):
        for x in range(crop.width):
            c = px[x, y]
            if is_backdrop(c, backdrops):
                px[x, y] = (c[0], c[1], c[2], 0)
    bbox = crop.getbbox() or (0, 0, crop.width, crop.height)
    return crop.crop(bbox)


def similar_size(a, b, tol=SIZE_TOL):
    return abs(a[0] - b[0]) <= tol * b[0] and abs(a[1] - b[1]) <= tol * b[1]


def pick_frames(sheet):
    """Return (sprite0, sprite1_or_None) as tightly-cropped, native-res RGBA
    images."""
    im, rows, backdrops = detect_pose_boxes(sheet)
    if not rows:
        raise SystemExit(f"{sheet}: no battle-pose candidates found")
    flat = [b for row in rows for b in row]

    override = POSE_OVERRIDES.get(sheet)
    if override:
        i0, i1 = override
        sprite0 = crop_pose(im, flat[i0], backdrops)
        sprite1 = crop_pose(im, flat[i1], backdrops) if i1 is not None else None
        return sprite0, sprite1

    sprite0 = crop_pose(im, rows[0][0], backdrops)
    size0 = (sprite0.width, sprite0.height)

    # Prefer a pose from a *different* row: within one row, the sheets we've
    # seen only vary an idle animation (breathing, tiny limb shifts), so
    # those frames are near-duplicates of frame 0, not "a different pose".
    # Distinct action poses live in the other row(s). Only fall back to the
    # same row when the sheet has just the one (e.g. gallantmon,
    # wargrowlmon, whose 5 poses are laid out side by side, not 3+2).
    candidates = [b for row in rows[1:] for b in row] or rows[0][1:]

    sprite1 = None
    for box in candidates:
        candidate = crop_pose(im, box, backdrops)
        size1 = (candidate.width, candidate.height)
        if not similar_size(size1, size0):
            continue
        # Still skip a near-duplicate if one slips through (e.g. a sheet
        # that repeats the same pose across rows).
        if _mean_diff(sprite0, candidate) < 10:
            continue
        sprite1 = candidate
        break
    return sprite0, sprite1


def _mean_diff(a, b, size=24):
    """Coarse perceptual difference between two RGBA crops: resize both onto
    a flat grey background at a small fixed size and average the per-pixel
    absolute difference. Used only to tell "different pose" apart from "same
    idle pose duplicated/mirrored across the row" -- not a real hashing
    scheme, just enough signal for that one decision."""
    def flatten(im):
        bg = Image.new("RGB", (size, size), (128, 128, 128))
        fit = im.resize((size, size), Image.NEAREST)
        bg.paste(fit, (0, 0), fit)
        return bg

    pa, pb = flatten(a).load(), flatten(b).load()
    total = 0
    for y in range(size):
        for x in range(size):
            ca, cb = pa[x, y], pb[x, y]
            total += abs(ca[0] - cb[0]) + abs(ca[1] - cb[1]) + abs(ca[2] - cb[2])
    return total / (size * size * 3)


def save_pair(sprite0, sprite1, out_dir, stage):
    """Pad both frames to their union bbox size (paste centered horizontally,
    bottom-aligned, same convention as to_sprite()) so swapping frames
    doesn't jitter, then save at native resolution."""
    sprites = [sprite0] if sprite1 is None else [sprite0, sprite1]
    canvas_w = max(s.width for s in sprites)
    canvas_h = max(s.height for s in sprites)
    paths = []
    for n, sprite in enumerate(sprites):
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        canvas.paste(sprite, ((canvas_w - sprite.width) // 2, canvas_h - sprite.height), sprite)
        path = os.path.join(out_dir, f"portrait-{stage}-{n}.png")
        canvas.save(path)
        paths.append(path)
    return paths


def main(packs):
    cache = {}
    for pack in packs:
        out_dir = os.path.join(PACK_DIR, pack)
        if not os.path.isdir(out_dir):
            print(f"skip {pack}: {out_dir} does not exist")
            continue
        for stage, sheet in PACK_SHEETS[pack].items():
            if sheet not in cache:
                cache[sheet] = pick_frames(sheet)
            sprite0, sprite1 = cache[sheet]
            paths = save_pair(sprite0, sprite1, out_dir, stage)
            note = " + ".join(f"{p} ({Image.open(p).size[0]}x{Image.open(p).size[1]})" for p in paths)
            print(f"{pack}/{stage} <- {sheet}: {note}")


if __name__ == "__main__":
    requested = sys.argv[1:] or list(PACK_SHEETS)
    unknown = [p for p in requested if p not in PACK_SHEETS]
    if unknown:
        raise SystemExit(f"unknown pack(s): {', '.join(unknown)}; known: {', '.join(PACK_SHEETS)}")
    main(requested)
