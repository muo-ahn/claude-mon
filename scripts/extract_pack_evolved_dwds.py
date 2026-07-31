#!/usr/bin/env python3
"""Extract adult/perfect/ultimate stage sprites from Digimon World DS sheets.

Why a second source: every pack's Battle Spirit sheet (sprites/sheets/*.gif)
contains only the Rookie's own move set, so the existing extract_pack_<mon>.py
scripts had to fall back to "the rookie doing something dramatic" for the three
evolved stages -- the mascot was named 그레이몬 while the dots still showed
아구몬. Digimon World DS ships a field/walking sprite for every digivolution in
the game, at roughly the 32x32 the menubar wants, so adult/perfect/ultimate now
come from there instead.

Sheets are NOT committed (see README "스프라이트 팩"). Put the DWDS sheets in
sprites/sheets/dwds/<name>.png using the names in PICKS below; each one is the
full character sheet as ripped (battle poses on top, field sprites in a row or
grid further down).

Frame location is automatic rather than hand-tuned windows: a band is slid down
the sheet and segmented using the colours that dominate *that band* (sheets use
one backdrop colour plus a per-cell panel colour, and a panel is only dominant
inside its own row). The band scoring the most uniformly sized, evenly spaced,
unclipped small sprites is the field-sprite row. Only the two frame indices per
stage in PICKS were chosen by eye -- they select the front-facing pose, whose
position in the row differs per sheet.

Usage: python3 scripts/extract_pack_evolved_dwds.py [pack ...]
       python3 scripts/extract_pack_evolved_dwds.py --contact <sheet> [out.png]

--contact renders every detected field frame of one sheet into a numbered strip,
which is how the two indices per stage in PICKS get chosen without guessing.
"""

import os
import sys
from collections import Counter, deque

from PIL import Image, ImageDraw

SHEET_DIR = "sprites/sheets/dwds"
PACK_DIR = "sprites/packs"
CANVAS = 32

# Sliding-band search parameters (pixels).
BAND_H = 56
BAND_STEP = 8
MIN_H, MAX_H = 13, 44
MIN_W, MAX_W = 8, 52
MIN_PX = 70
COLOR_TOL = 12

# pack -> stage -> (DWDS sheet, [frame index, frame index] | [(x0,y0,x1,y1), ...])
#
# The second element is normally a pair of indices into the auto-detected
# field-frame row (see field_frames() below). Some sheets don't cooperate: the
# band search on metalgreymon locks onto a row that holds a back-facing pose
# mirrored left/right rather than a real 2-frame walk cycle, so indices 0/1
# there are the same pose flipped, not two frames. For those, give explicit
# (x0, y0, x1, y1) source boxes instead -- to_sprite() only reads box[0..3],
# so a literal box works exactly like boxes[index] would.
#
# `PENDING` marks a stage whose sheet is known but whose frames haven't been
# chosen yet: the two indices can only be read off the sheet itself, and sheets
# are never committed. Such a stage is skipped with a note instead of failing
# the run; drop the sheet in, run --contact <sheet> to get a numbered strip of
# the detected field frames, then replace PENDING with the pair you picked.
#
# Every sheet here puts the back-facing walk first and the front-facing walk
# last, so the picked pair is always near the end of the row.
PENDING = None

PICKS = {
    "agumon": {
        "adult": ("greymon", [6, 7]),
        "perfect": ("metalgreymon", [(291, 214, 319, 246), (292, 257, 320, 289)]),
        "ultimate": ("wargreymon", [0, 1]),
        # 아구몬·파피몬의 초궁극체는 둘 다 합체체인 오메가몬이라 같은 시트를
        # 공유한다 (계보상 사실이고, pack.json의 이름도 양쪽 다 오메가몬).
        "superultimate": ("omegamon", [5, 6]),
        # 분기 도트: 트리의 대체 노드(pack.json의 sprite 값이 그대로 prefix).
        "adult-geogreymon": ("geogreymon", [0, 1]),
        "perfect-rizegreymon": ("rizegreymon", [0, 1]),
        "ultimate-blackwargreymon": ("blackwargreymon", [0, 1]),
        # 샤인그레이몬 라인이 지오그레이몬 분기를 천장까지 잇는다. 두 시트 모두
        # withthewill의 격자 배치이고 row1이 정면 행이다 — 본체는 주황 볏과
        # 얼굴이, 버스트 모드는 파란 눈이 보이는 행이다.
        "ultimate-shinegreymon": ("shinegreymon", [2, 3], 1),
        "superultimate-shinegreymon_burst": ("shinegreymon_burst", [1, 2], 1),
    },
    "guilmon": {
        "adult": ("growlmon", [0, 1]),
        "perfect": ("wargrowlmon", [4, 5]),
        "ultimate": ("gallantmon", [6, 7]),
        "superultimate": ("gallantmon_crimson", [3, 4]),
        "perfect-blackmegalogrowlmon": ("blackwargrowlmon", [4, 5]),
    },
    "gabumon": {
        "adult": ("garurumon", [6, 7]),
        "perfect": ("weregarurumon", [6, 7]),
        "ultimate": ("metalgarurumon", [6, 7]),
        "superultimate": ("omegamon", [5, 6]),
        "ultimate-darkdramon": ("darkdramon", [5, 6]),
        # D4: 다크드라몬 hangs off 블랙워가루몬 now, not 워가루몬. row1 is the
        # front row (row0 is the back views -- the automatic band search picks
        # row0 here, which is exactly the bug --rows exists to expose).
        # idx1 matches the shipped 워가루몬 dot at IoU 0.828.
        "perfect-blackweregarurumon": ("blackweregarurumon", [1, 2], 1),
    },
    "veemon": {
        "adult": ("exveemon", [6, 7]),
        "perfect": ("paildramon", [5, 6]),
        "ultimate": ("imperialdramon_fm", [6, 7]),
        "superultimate": ("imperialdramon_pm", [6, 7]),
        "perfect-flamedramon": ("flamedramon", [3, 4]),
        "perfect-magnamon": ("magnamon", [4, 5]),
        "ultimate-imperialdramon_dm": ("imperialdramon_dm", [4, 5]),
    },
    "renamon": {
        "adult": ("kyubimon", [6, 7]),
        "perfect": ("taomon", [3, 4]),
        "ultimate": ("sakuyamon", [3, 4]),
        # withthewill sheets: 3-row grid, row1 is the front-facing row. Frames
        # chosen by matching row1 against the already-shipped 사쿠야몬 dots
        # (idx1 -> frame 0 at IoU 0.734, idx2 -> frame 1 at 0.597) rather than
        # by eye -- at 28px these sprites all read the same.
        "ultimate-kuzuhamon": ("kuzuhamon", [1, 2], 1),
    },
    "terriermon": {
        "adult": ("gargomon", [3, 4]),
        "perfect": ("rapidmon", [0, 1]),
        "ultimate": ("megagargomon", [0, 1]),
        # 블랙라피드몬: row1 (front) matched against the shipped 라피드몬 dots,
        # idx1 -> frame 0 (0.593), idx0 -> frame 1 (0.605).
        "perfect-blackrapidmon": ("blackrapidmon", [1, 0], 1),
        # 블랙세인트가르고몬 is a straight recolor, so row6 idx1 matches the
        # shipped 세인트가르고몬 frame 0 exactly (IoU 1.000). This sheet has 8
        # field rows rather than 3 -- the row index is per sheet, never assume.
        "ultimate-blacksaintgalgomon": ("blackmegagargomon", [1, 0], 6),
    },
    # 케라몬 라인은 Battle Spirit 시트가 없어 성장기·유년기까지 전부 DWDS에서
    # 온다. `idle`은 팩 로드의 최소 조건이자 대기 프레임인데 관례상 성장기
    # 도트와 같으므로 child와 같은 프레임을 쓴다 -- 스테이지 이름이 그대로
    # 파일 prefix라서 별도 처리 없이 여기에 적으면 된다.
    #
    # 아머게몬은 원본 프레임이 32px보다 훨씬 커서 축소된다(픽셀 1:1 아님).
    "keramon": {
        "idle": ("keramon", [3, 4]),
        "baby": ("kuramon", [3, 4]),
        "child": ("keramon", [3, 4]),
        "adult": ("kurisarimon", [1, 2]),
        "perfect": ("infermon", [1, 2]),
        "ultimate": ("diaboromon", [3, 4]),
        "superultimate": ("armagemon", [3, 4]),
        "ultimate-beelzebumon": ("beelzemon", [4, 5]),
    },
    # 팔코몬 라인도 전 단계를 DWDS에서 뽑는다. 초궁극체는 크로노몬 홀리 모드 --
    # DWDS의 최종 보스이고 게임 안에서 Super Ultimate로 불린다. 유년기는 게임
    # 진화표대로 토코몬이다(캐논 유년기 피나몬은 DWDS에 없다).
    #
    # 펙몬·야타가라몬·바로두르몬 시트는 필드 프레임 행이 3칸뿐이어서 고를 수
    # 있는 쌍이 [0, 1] 하나다.
    "falcomon": {
        "idle": ("falcomon", [3, 4]),
        "baby": ("tokomon", [3, 4]),
        "child": ("falcomon", [3, 4]),
        "adult": ("peckmon", [0, 1]),
        "perfect": ("yatagaramon", [0, 1]),
        "ultimate": ("varodurumon", [0, 1]),
        "superultimate": ("chronomon_hm", [6, 7]),
    },
    # Impmon has no canonical Champion/Ultimate; the pack already stood in
    # 데블몬 for adult. 스컬사탄몬 is absent from DWDS, so perfect uses
    # 뱀파이몬 (Myotismon) -- pack.json carries the matching name. 베르제브몬
    # 블래스트 모드는 캐논에는 있지만 DWDS 시트에 없다 (Dawn/Dusk
    # 섹션에도 없음). 초궁극체 도트를 구할 수 없으므로 impmon도 superultimate
    # 항목이 없고, 따라서 로테이션 후보에서 빠진다.
    "impmon": {
        "adult": ("devimon", [0, 1]),
        "perfect": ("myotismon", [3, 4]),
        "ultimate": ("beelzemon", [4, 5]),
        # Q5: the 베르제브몬 블래스트 모드 sheet exists after all, so 임프몬
        # rejoins the rotation without having to declare a lower ceiling.
        #
        # Lower confidence than the other new picks: Blast Mode's wings make
        # its silhouette too unlike plain 베르제브몬 for the IoU match to
        # decide the row (row1 0.431 vs row2 0.330). row1 wins on both that
        # weak signal and on being the symmetric, front-looking one.
        "superultimate": ("beelzemon_bm", [1, 2], 1),
    },
}

# 레나몬(사쿠야몬)·테리어몬(세인트가르고몬)에도 superultimate 항목이 없다 --
# 이쪽은 캐논상 초궁극체 자체가 없다. 세 팩 모두 pack.json에 이름이 비어 있어
# lib/daily.js의 로테이션 후보에서 빠진다 (README "로테이션 후보 요건").


def dominant_colors(im, min_share):
    total = im.width * im.height
    hist = Counter(c for c in im.getdata() if c[3] >= 32)
    return {c for c, n in hist.items() if n / total >= min_share}


def is_backdrop(color, backdrops):
    return any(abs(color[0] - b[0]) + abs(color[1] - b[1]) + abs(color[2] - b[2]) <= COLOR_TOL
               for b in backdrops)


def components(im, backdrops):
    w, h = im.size
    px = im.load()
    fg = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            c = px[x, y]
            if c[3] >= 32 and not is_backdrop(c, backdrops):
                fg[y * w + x] = 1
    seen = bytearray(w * h)
    boxes = []
    for y in range(h):
        for x in range(w):
            if not fg[y * w + x] or seen[y * w + x]:
                continue
            seen[y * w + x] = 1
            queue = deque([(x, y)])
            x0 = x1 = x
            y0 = y1 = y
            count = 0
            while queue:
                cx, cy = queue.popleft()
                count += 1
                x0 = min(x0, cx); x1 = max(x1, cx)
                y0 = min(y0, cy); y1 = max(y1, cy)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < w and 0 <= ny < h and fg[ny * w + nx] and not seen[ny * w + nx]:
                            seen[ny * w + nx] = 1
                            queue.append((nx, ny))
            boxes.append((x0, y0, x1, y1, count))
    return boxes


def merge_touching(boxes):
    """An outline gap can split one sprite into several components; overlapping
    bounding boxes belong to the same sprite."""
    merged = []
    for b in sorted(boxes, key=lambda b: (b[1], b[0])):
        for i, m in enumerate(merged):
            if b[0] <= m[2] and m[0] <= b[2] and b[1] <= m[3] and m[1] <= b[3]:
                merged[i] = (min(m[0], b[0]), min(m[1], b[1]),
                             max(m[2], b[2]), max(m[3], b[3]), m[4] + b[4])
                break
        else:
            merged.append(b)
    return merged


def segment(band, drop_clipped=True):
    boxes = components(band, dominant_colors(band, 0.08))
    for _ in range(3):
        boxes = merge_touching(boxes)
    return [b for b in boxes
            if MIN_H <= b[3] - b[1] + 1 <= MAX_H
            and MIN_W <= b[2] - b[0] + 1 <= MAX_W
            and b[4] >= MIN_PX
            # a box touching the band edge is a slice of a taller battle sprite
            and (not drop_clipped or (b[1] >= 1 and b[3] <= band.height - 2))]


def score_band(boxes):
    """Frames of one animation are near-identical in size and evenly spaced;
    fragments of a big battle sprite are neither."""
    boxes = [b for b in boxes if 0.5 <= (b[2] - b[0] + 1) / (b[3] - b[1] + 1) <= 1.6]
    if len(boxes) < 3:
        return 0, []
    heights = sorted(b[3] - b[1] + 1 for b in boxes)
    median = heights[len(heights) // 2]
    keep = [b for b in boxes if abs((b[3] - b[1] + 1) - median) <= max(4, median * 0.25)]
    if len(keep) < 3:
        return 0, []
    keep.sort(key=lambda b: b[0])
    gaps = [keep[i + 1][0] - keep[i][0] for i in range(len(keep) - 1)]
    gap = sorted(gaps)[len(gaps) // 2] or 1
    regular = sum(1 for g in gaps if abs(g - gap) <= max(3, gap * 0.2))
    return len(keep) + regular, keep


# Every field-sprite row on the sheet, top to bottom, each sorted
# left-to-right.
#
# field_frames() below keeps only the best-scoring band, which is right for
# the sheets whose field sprites sit in a single bottom row. The withthewill
# rips lay them out as a 3-row grid where *each row is a facing direction*,
# and there the best-scoring band is whichever direction happened to win --
# on blackweregarurumon that was the row of back views. Nothing downstream
# could express "the other row", so the sheet was unusable.
#
# Clustering by y-overlap (rather than banding) is what separates the rows:
# a row's sprites all share a baseline, and two rows never overlap
# vertically.
def field_rows(sheet):
    im = Image.open(os.path.join(SHEET_DIR, sheet + ".png")).convert("RGBA")
    boxes = components(im, dominant_colors(im, 0.02))
    for _ in range(4):
        boxes = merge_touching(boxes)
    boxes = [
        b for b in boxes
        if MIN_H <= b[3] - b[1] + 1 <= MAX_H
        and MIN_W <= b[2] - b[0] + 1 <= MAX_W
        and b[4] >= MIN_PX
    ]
    rows = []
    for b in sorted(boxes, key=lambda b: b[1]):
        for row in rows:
            if any(not (b[3] < o[1] or b[1] > o[3]) for o in row):
                row.append(b)
                break
        else:
            rows.append([b])
    for row in rows:
        row.sort(key=lambda b: b[0])
    return im, rows


def field_frames(sheet, row=None):
    if row is not None:
        im, rows = field_rows(sheet)
        if row >= len(rows):
            raise SystemExit(
                f"{sheet}: asked for row {row} but only {len(rows)} field rows "
                f"were found -- run --rows {sheet} to see them")
        return im, rows[row]
    im = Image.open(os.path.join(SHEET_DIR, sheet + ".png")).convert("RGBA")
    w, h = im.size
    best_score, best_top, best_boxes = 0, 0, []
    for y0 in range(0, max(1, h - MIN_H), BAND_STEP):
        score, boxes = score_band(segment(im.crop((0, y0, w, min(h, y0 + BAND_H)))))
        if score > best_score:
            best_score, best_top, best_boxes = score, y0, boxes
    if not best_boxes:
        return im, []
    # re-cut tightly around the winning row so nothing stays clipped
    top = max(0, best_top + min(b[1] for b in best_boxes) - 6)
    bottom = min(h, best_top + max(b[3] for b in best_boxes) + 7)
    _, boxes = score_band(segment(im.crop((0, top, w, bottom)), drop_clipped=False))
    boxes = [(b[0], b[1] + top, b[2], b[3] + top, b[4]) for b in boxes]
    boxes.sort(key=lambda b: b[0])
    return im, boxes


def cell_backdrops(crop):
    """A colour filling 2+ corners of a frame is its panel, never the sprite."""
    px = crop.load()
    w, h = crop.width, crop.height
    corners = Counter(px[x, y] for x in (0, w - 1) for y in (0, h - 1))
    backdrops = {c for c, n in corners.items() if n >= 2 and c[3] >= 32}
    color, n = Counter(c for c in crop.getdata() if c[3] >= 32).most_common(1)[0]
    if n / (w * h) >= 0.20:
        backdrops.add(color)
    return backdrops


def to_sprite(im, box):
    crop = im.crop((box[0], box[1], box[2] + 1, box[3] + 1)).convert("RGBA")
    backdrops = cell_backdrops(crop)
    px = crop.load()
    for y in range(crop.height):
        for x in range(crop.width):
            c = px[x, y]
            if is_backdrop(c, backdrops):
                px[x, y] = (c[0], c[1], c[2], 0)
    crop = crop.crop(crop.getbbox() or (0, 0, crop.width, crop.height))
    scaled = crop.width > CANVAS or crop.height > CANVAS
    if scaled:
        factor = min(CANVAS / crop.width, CANVAS / crop.height)
        crop = crop.resize((max(1, int(crop.width * factor)), max(1, int(crop.height * factor))),
                           Image.NEAREST)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(crop, ((CANVAS - crop.width) // 2, CANVAS - crop.height), crop)
    return canvas, scaled


def main(packs):
    cache = {}
    scaled_frames = []
    for pack in packs:
        out_dir = os.path.join(PACK_DIR, pack)
        if not os.path.isdir(out_dir):
            print(f"skip {pack}: {out_dir} does not exist")
            continue
        for stage, entry in PICKS[pack].items():
            # (sheet, picks) or (sheet, picks, row). The third element names
            # which field-sprite row to index into, for sheets where the
            # automatic band lands on the wrong facing direction.
            sheet, picks = entry[0], entry[1]
            row = entry[2] if len(entry) > 2 else None
            if picks is PENDING:
                print(f"skip {pack}/{stage}: frames not chosen yet "
                      f"-- run --rows {sheet} and fill in PICKS")
                continue
            if not os.path.exists(os.path.join(SHEET_DIR, sheet + ".png")):
                print(f"skip {pack}/{stage}: {SHEET_DIR}/{sheet}.png not found")
                continue
            key = (sheet, row)
            if key not in cache:
                cache[key] = field_frames(sheet, row)
            im, boxes = cache[key]
            indices = [p for p in picks if isinstance(p, int)]
            if indices and len(boxes) <= max(indices):
                raise SystemExit(
                    f"{pack}/{stage}: {sheet} yielded {len(boxes)} field frames, "
                    f"need index {max(indices)} -- check the sheet or the PICKS table")
            for n, pick in enumerate(picks):
                if isinstance(pick, int):
                    src_box, label = boxes[pick], f"[{pick}]"
                else:
                    src_box, label = pick, f"{pick}"
                sprite, scaled = to_sprite(im, src_box)
                path = os.path.join(out_dir, f"{stage}-{n}.png")
                sprite.save(path)
                if scaled:
                    scaled_frames.append(path)
                print(f"{path}  <- {sheet}{label}")
    if scaled_frames:
        print("\ndownscaled to fit 32x32 (pixels are no longer 1:1): "
              + ", ".join(scaled_frames))


# Writes every detected field frame of `sheet` side by side, in index order,
# each on its own 32x32 cell with a tick mark under the cell whose index is a
# multiple of 5 (so counting stays honest past ~6 frames). This is what turns
# "pick the front-facing pose by eye" into a two-step loop: render the strip,
# look at it, write the two indices into PICKS.
def contact_sheet(sheet, out_path):
    im, boxes = field_frames(sheet)
    if not boxes:
        raise SystemExit(f"{sheet}: no field-frame row detected -- is the sheet a DWDS rip?")
    cells = [to_sprite(im, b)[0] for b in boxes]
    gap, tick = 2, 4
    strip = Image.new("RGBA", (len(cells) * (CANVAS + gap), CANVAS + tick), (0, 0, 0, 0))
    for i, cell in enumerate(cells):
        x = i * (CANVAS + gap)
        strip.paste(cell, (x, 0), cell)
        if i % 5 == 0:
            for ty in range(CANVAS, CANVAS + tick):
                for tx in range(x, x + CANVAS):
                    strip.putpixel((tx, ty), (255, 0, 0, 255))
    strip.save(out_path)
    print(f"{out_path}  <- {sheet}, {len(cells)} frames (indices 0..{len(cells) - 1}, "
          f"red tick under 0, 5, 10, ...)")


# Every row, stacked and labelled, upscaled enough to actually read a 28px
# sprite. Use this before --contact on an unfamiliar sheet: --contact only
# ever shows the one row the band search picked, so on a grid-layout sheet it
# can show you six back views and give no hint that a front row exists.
#
# Direction is legible from a stacked view in a way it isn't frame by frame --
# the front row is the one where every sprite has visible eyes.
def rows_sheet(sheet, out_path, scale=7):
    im, rows = field_rows(sheet)
    if not rows:
        raise SystemExit(f"{sheet}: no field rows detected -- is the sheet a DWDS rip?")
    cell, gap, label_w = CANVAS * scale, 8, 88
    width = max(len(r) for r in rows) * (cell + gap) + gap + label_w
    height = len(rows) * (cell + gap + 16) + gap
    out = Image.new("RGBA", (width, height), (32, 32, 40, 255))
    draw = ImageDraw.Draw(out)
    y = gap
    for ri, row in enumerate(rows):
        draw.text((6, y + cell // 2), f"row{ri}", fill=(140, 220, 255, 255))
        x = label_w
        for ci, box in enumerate(row):
            out.alpha_composite(to_sprite(im, box)[0].resize((cell, cell), Image.NEAREST),
                                (x, y + 16))
            draw.text((x + 2, y), str(ci), fill=(255, 230, 120, 255))
            x += cell + gap
        print(f"  row{ri}: {len(row)} frames at y={row[0][1]}..{row[0][3]}")
        y += cell + gap + 16
    out.save(out_path)
    print(f"{out_path}  <- {sheet}, {len(rows)} rows. Front row = the one whose "
          f"sprites have visible eyes; pass it as PICKS' third element.")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--contact":
        if len(args) < 2:
            raise SystemExit("usage: --contact <sheet> [out.png]")
        contact_sheet(args[1], args[2] if len(args) > 2 else f"/tmp/{args[1]}-frames.png")
        sys.exit(0)
    if args and args[0] == "--rows":
        if len(args) < 2:
            raise SystemExit("usage: --rows <sheet> [out.png]")
        rows_sheet(args[1], args[2] if len(args) > 2 else f"/tmp/{args[1]}-rows.png")
        sys.exit(0)
    requested = args or list(PICKS)
    unknown = [p for p in requested if p not in PICKS]
    if unknown:
        raise SystemExit(f"unknown pack(s): {', '.join(unknown)}; known: {', '.join(PICKS)}")
    main(requested)
