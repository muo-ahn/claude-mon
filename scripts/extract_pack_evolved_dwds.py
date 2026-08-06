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

from PIL import Image

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
        # ultimate-shinegreymon, superultimate-shinegreymon_burst 는 표 미등록
        # = 재현 불가, 인덱스 추측 금지. 자동 검출 프레임과 바이트가 달라
        # (수동 크롭으로 만들어짐) 원본 인덱스를 복원할 수 없다. 다음 실행에
        # 다른 프레임으로 덮이지 않도록 여기 항목을 추가하지 말 것.
    },
    "guilmon": {
        "adult": ("growlmon", [0, 1]),
        "perfect": ("wargrowlmon", [4, 5]),
        "ultimate": ("gallantmon", [6, 7]),
        "superultimate": ("gallantmon_crimson", [3, 4]),
        "perfect-blackmegalogrowlmon": ("blackwargrowlmon", [4, 5]),
        # ultimate-chaosdukemon 은 표 미등록 = 재현 불가, 인덱스 추측 금지
        # (수동 크롭으로 만들어져 원본 프레임 인덱스가 없음).
    },
    "gabumon": {
        "adult": ("garurumon", [6, 7]),
        "perfect": ("weregarurumon", [6, 7]),
        "ultimate": ("metalgarurumon", [6, 7]),
        "superultimate": ("omegamon", [5, 6]),
        "ultimate-darkdramon": ("darkdramon", [5, 6]),
        # perfect-blackweregarurumon 은 표 미등록 = 재현 불가, 인덱스 추측 금지
        # (수동 크롭으로 만들어져 원본 프레임 인덱스가 없음).
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
        # ultimate-kuzuhamon 은 표 미등록 = 재현 불가, 인덱스 추측 금지
        # (수동 크롭으로 만들어져 원본 프레임 인덱스가 없음).
    },
    "terriermon": {
        "adult": ("gargomon", [3, 4]),
        "perfect": ("rapidmon", [0, 1]),
        "ultimate": ("megagargomon", [0, 1]),
        # 프레임 순서 0<->1 반전이 맞다 (blackmegagargomon 시트, 현재 파일과
        # 바이트 일치 확인됨).
        "ultimate-blacksaintgalgomon": ("blackmegagargomon", [1, 0]),
        # perfect-blackrapidmon 은 표 미등록 = 재현 불가, 인덱스 추측 금지
        # (수동 크롭으로 만들어져 원본 프레임 인덱스가 없음).
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
        # ultimate-ravemon, superultimate-ravemon_bm 은 표 미등록 = 재현 불가,
        # 인덱스 추측 금지 (수동 크롭으로 만들어져 원본 프레임 인덱스가 없음).
    },
    # Impmon has no canonical Champion/Ultimate; the pack already stood in
    # 데블몬 for adult. 스컬사탄몬 is absent from DWDS, so perfect uses
    # 뱀파이몬 (Myotismon) -- pack.json carries the matching name. 베르제브몬
    # 블래스트 모드 시트(beelzemon_bm)는 이제 확보되어 아래 superultimate
    # 항목으로 들어간다.
    # 다크 분기(2026-08-06): DWDS 임프몬 Line 1 (이블몬 → 미이라몬 → 데스몬)에
    # 데스몬 블랙을 더해 초궁극체까지 잇는다 -- Wikimon 이 데스몬 → 데스몬(블랙)
    # 진화를 명시하므로 변종 승격이 아니라 정사 엣지다. 데스몬 2종 시트는
    # 동일 레이아웃 색교체판이라 프레임 인덱스도 같다.
    "impmon": {
        "adult": ("devimon", [0, 1]),
        "perfect": ("myotismon", [3, 4]),
        "ultimate": ("beelzemon", [4, 5]),
        "superultimate": ("beelzemon_bm", [1, 2]),
        "adult-vilemon": ("vilemon", [2, 3]),
        "perfect-mummymon": ("mummymon", [6, 7]),
        "ultimate-ghoulmon": ("ghoulmon", [3, 4]),
        "superultimate-ghoulmon_black": ("ghoulmon_black", [3, 4]),
    },
    # 가오몬 라인도 전 단계를 DWDS에서 뽑는다. 분기 없는 spine이라 유년기부터
    # 궁극체까지 시트가 하나씩만 있다.
    #
    # miragegaogamon_bm(미라지가오가몬 버스트 모드) 시트는 로컬에 있지만
    # photobucket 워터마크가 덮인 저해상도 리핑이라 field_frames()의 균일 셀
    # 행 탐지가 아예 실패하고(필드 프레임 행 자체가 없음), 수동 크롭으로
    # 뽑아도 32px 도트로는 종을 판별할 수 없다. 프레임 선택으로 해결 가능한
    # 문제가 아니라 대체 시트가 필요하므로 항목을 두지 않는다 -- pack.json도
    # superultimate 없이 궁극체(미라지가오가몬)를 최상위로 둔다. 쓸 만한 BM
    # 시트를 구하면 이 항목과 pack.json 양쪽에 한 줄씩 넣어 복귀시킨다.
    "gaomon": {
        "idle": ("gaomon", [1, 3]),
        "baby": ("wanyamon", [0, 1]),
        "child": ("gaomon", [1, 3]),
        "adult": ("gaogamon", [0, 1]),
        "perfect": ("machgaogamon", [2, 3]),
        "ultimate": ("miragegaogamon", [2, 3]),
    },
}

# 레나몬(사쿠야몬)에는 PICKS상 "superultimate" 키가 없다 -- 캐논상 초궁극체
# 자체가 없다. (임프몬은 beelzemon_bm 확보로 위에 superultimate 항목이 생겼고,
# 테리어몬은 "ultimate-blacksaintgalgomon" 키로 위에 있다 -- 둘 다 superultimate
# *스테이지*는 있으나 sprite 이름이 ultimate- 접두를 그대로 쓴다.)


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


def field_frames(sheet):
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
        for stage, (sheet, picks) in PICKS[pack].items():
            if picks is PENDING:
                print(f"skip {pack}/{stage}: frames not chosen yet "
                      f"-- run --contact {sheet} and fill in PICKS")
                continue
            if not os.path.exists(os.path.join(SHEET_DIR, sheet + ".png")):
                print(f"skip {pack}/{stage}: {SHEET_DIR}/{sheet}.png not found")
                continue
            if sheet not in cache:
                cache[sheet] = field_frames(sheet)
            im, boxes = cache[sheet]
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


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--contact":
        if len(args) < 2:
            raise SystemExit("usage: --contact <sheet> [out.png]")
        contact_sheet(args[1], args[2] if len(args) > 2 else f"/tmp/{args[1]}-frames.png")
        sys.exit(0)
    requested = args or list(PICKS)
    unknown = [p for p in requested if p not in PICKS]
    if unknown:
        raise SystemExit(f"unknown pack(s): {', '.join(unknown)}; known: {', '.join(PICKS)}")
    main(requested)
