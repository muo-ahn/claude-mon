#!/usr/bin/env python3
"""Fetch Wikimon-hosted Digimon Story overworld dots and normalize them into
this repo's node dot spec (sprites/nodes/<id>-0.png, 32x32 RGBA).

Wikimon hosts two relevant sprite sets per species, both named after the
species' Wikimon page title with spaces turned into underscores:

  <Title>_dst_map.png   -- Digimon Story: Dawn/Dusk overworld sprite (primary)
  <Title>_dsle_map.png  -- Digimon Story: Lost Evolution overworld sprite
                            (fallback, used when dst_map doesn't exist)

File existence and the real download URL are resolved through the MediaWiki
API (wikimon.net/api.php), never guessed or constructed by hand -- a File:
page that doesn't exist comes back with a "missing" page object instead of
imageinfo, which is what this script treats as "no dot available for this
species". Species without either sprite are reported as unavailable and no
placeholder is written; this repo's rule is "don't guess a missing asset"
(see scripts/rip_dwds_sprites.py header).

Some Wikimon titles don't map to their upload filename by the space-to-
underscore rule above -- colons/parentheses in the title ("Cherubimon
(Vice)", "ShineGreymon: Burst Mode") or MediaWiki forcing only the first
character of the title to uppercase while the rest of the upload keeps its
original casing ("DORUmon" -> "Dorumon_dst_map.png"). For these, a species
entry can carry an explicit "dot_file" with the exact uploaded filename;
when present, that exact name is looked up and title-based guessing is
skipped entirely -- if the given dot_file doesn't exist, the species is
unavailable rather than falling back to a guess.

Normalization for dst_map/dsle_map mirrors scripts/extract_pack_evolved_dwds.py's
CANVAS handling: RGBA convert -> getbbox() trim -> if either axis exceeds
32px, scale down with NEAREST preserving aspect ratio -> paste onto a 32x32
transparent canvas, horizontally centered and bottom-aligned (feet on the
floor). This path is untouched by the vpet handling below, so previously
generated dst_map/dsle_map sprites are unaffected.

A species entry can carry an optional "source" (e.g. "vpet_vb", "vpet_ws",
"vpet_dmc", "vpet_dv", "vpet_xloader", "vpet_dark") alongside "dot_file" to
pull from Wikimon's virtual-pet dot sets instead of the DS overworld sets --
this repo's node cap needs a bigger asset pool than the 337 dst/dsle_map
sprites cover. Any "source" starting with "vpet" routes through a second
normalization path, because vpet dots differ from map dots in two ways this
script has measured directly (see scripts/fetch-wikimon-dots.py's own
--dry-run/verification runs, not guessed):

  1. Background: some vpet uploads are already alpha-transparent (like map
     dots), but others carry an opaque white/solid backdrop, or a GIF whose
     "transparency" palette index doesn't cover every backdrop pixel. Before
     trimming, a Wikimon-adjacent backdrop-colour heuristic (corner colours
     appearing 2+ times, or a colour filling >=20% of opaque pixels -- the
     same heuristic as extract_pack_evolved_dwds.py's cell_backdrops()) finds
     candidate backdrop colours, then a flood fill *from the image border
     only* clears pixels connected to the edge that match one of those
     colours. Unlike a global colour replace, this leaves same-coloured
     regions that don't touch the border alone (e.g. a white eye highlight
     on a white-background sprite survives; the white background doesn't).
  2. Scale: vpet_vb uploads are 192x192 (measured: a consistent 3x NEAREST
     upscale of native art, e.g. a 64x64 grid); vpet_ws/vpet_dark/some
     vpet_dv are a 2x upscale; vpet_dmc/vpet_xloader are also 3x; some
     vpet_dv sprites aren't upscaled at all. Rather than assume a factor,
     each image's actual pixel-block size is measured (the GCD of the gaps
     between columns/rows that differ from their neighbour) and only used
     to downsample if it's a consistent integer factor across both axes
     that evenly divides the image -- otherwise this falls back to the same
     arbitrary NEAREST shrink the map-dot path uses. This keeps the pixel
     grid crisp for the common case without ever guessing a scale that
     doesn't fit.
  3. First frame only for animated GIFs (vpet_ws/dmc/dv/xloader/dark can be
     2-frame animations) -- PIL's Image.open() already opens on frame 0
     without decoding the rest, so no explicit frame-seeking is needed as
     long as nothing calls .seek() past it.

Both paths converge on the same final step: bbox trim -> shrink to 32px if
still oversized -> paste onto the 32x32 canvas, centered horizontally and
bottom-aligned.

--portrait writes the other half of the node's assets: the big-screen crop
sprites/nodes/portrait-<id>-0.png that the menubar's dropdown header and
evolution cut-in draw at native resolution (README "큰 화면용 도트 3종").
It resolves purely by enumerating every file linked from the species'
Wikimon page (enumerate_species_files, action=query&prop=images) rather
than guessing a suffix -- a fixed suffix ladder was tried first and
measurably undercounts: a 20-species sample turned up 25+ distinct vpet/
map/dot suffixes (vpet_vb, vpet_spirit, vpet_dvic, vpet_d3, vpet_dm,
vpet_dt, vpet_cutin, vpet_pen, vpet_penz, vpet_dpc, vpet_dscan, vpet_dark,
vpet_accel, vpet_dmc, vpet_dw, vpet_ws, vpet_dv, vpet_cycle, vpet_mini,
vpet_alysion, dot, sprite, dst_map, dsle_map, ...), and several of those
uploads are .gif rather than .png (e.g. Alraumon_vpet_dt.gif) -- a
suffix-and-extension guess would never find either kind. Enumeration uses
redirects=1 because some species (VenomVamdemon, YukiAgumon) are Wikimon
redirects and come back with zero images without it.

Enumerated files are narrowed to dot-like candidates (map/vpet/dot/sprite
in the filename, excluding vpet_cutin -- a 64x32 horizontal walk-cycle
strip, not a portrait crop -- and dst_map/dsle_map/_dot, which are either
the node dot's own source or, for _dot specifically, never produced a
usable portrait across this investigation; see PORTRAIT_EXCLUDE_KEYWORDS
for the measured evidence on each) and then chosen by *measured native
size*, not upload size -- a bigger upload isn't necessarily better pixel
art. Measured directly: Bakumon_dot.png and Craniummon_dot.png are
128x128 uploads that are an 8x NEAREST blowup of a 14x14 native grid, and
Craniummon_vpet_alysion.png is a 512x512 upload with a measured
block-factor of 1 -- i.e. anti-aliased render art, not a pixel grid,
which PORTRAIT_BOX's upper bound exists to reject. Neither of those is
the hardest case, though: Karatuki_Numemon_dot.png clears every size gate
(128x128 upload, block-factor 1, survives at a plausible 112x112) and is
still not usable -- it's a yellow/green rectangle grid, not a Numemon, on
inspection. Size alone can't catch that, which is what
PORTRAIT_MIN_TRANSITION_DENSITY (a corruption check based on how often
color changes column-to-column/row-to-row) is for -- see its definition
and _looks_like_corrupted_art(). Each candidate is downloaded (capped at
--max-candidates per species, default PORTRAIT_MAX_CANDIDATES, ranked by
upload area, to bound download volume) and measured through the same
pipeline that produces the final file (normalize_vpet_portrait); the
largest whose native size lands in (CANVAS, PORTRAIT_BOX] on both axes
*and* passes the corruption check wins. Raising the cap from 4 to 16
(effectively uncapped for this species pool) on the full
docs/graph-provenance.json batch, after both the vpet_cutin/map/_dot
exclusions and the corruption check were in place, changed 0 winning
picks -- upload-area ranking is a good enough predictor of native size
among the candidates that actually qualify that PORTRAIT_MAX_CANDIDATES=4
isn't leaving a better source on the table, so the default stays 4
rather than trading more downloads for a cap that measurably wasn't
costing anything. The DS map sets can't feed this mode even before the
explicit exclusion above: their uploads are ~30x39 natively (measured
across the 302 cached originals), so there is no bigger asset in them to
crop -- but that native size still clears CANVAS, so without the
exclusion a map file could still win a species with no better vpet/dot
candidate (measured: 8/192 picks in a --max-candidates 4 run were
dst_map/dsle_map before it was added). Species where every candidate's
native size is CANVAS-or-smaller are reported [no-gain] and no file is
written -- the node dot already carries every pixel there, and the
menubar's upscale fallback produces the same result.

Downloaded originals are cached under .omc/wikimon-cache/dots/ so re-running
this script doesn't re-fetch bytes it already has.

Usage:
    python3 scripts/fetch-wikimon-dots.py --species species.json
    python3 scripts/fetch-wikimon-dots.py --id angemon --title Angemon
    python3 scripts/fetch-wikimon-dots.py --species species.json --dry-run
    python3 scripts/fetch-wikimon-dots.py --species species.json --force
    python3 scripts/fetch-wikimon-dots.py --species-from-provenance --portrait

species.json format:
    [{"id": "angemon", "title": "Angemon"},
     {"id": "shinegreymon_burstmode", "title": "ShineGreymon: Burst Mode",
      "dot_file": "Shinegreymon_burst_mode_dst_map.png"},
     {"id": "achillesmon", "title": "Achillesmon",
      "dot_file": "Achillesmon_vpet_vb.png", "source": "vpet_vb"},
     {"id": "ancientgarurumon", "title": "AncientGarurumon",
      "file_bases": ["AncientGarurumon", "Ancientgarurumon"]}]
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, deque
from math import gcd

from PIL import Image

WIKIMON_API = "https://wikimon.net/api.php"
USER_AGENT = "claudemon-dot-fetch/1.0 (https://github.com/; scripts/fetch-wikimon-dots.py)"
CACHE_DIR = os.path.join(".omc", "wikimon-cache", "dots")
NODES_DIR = os.path.join("sprites", "nodes")
CANVAS = 32
API_BATCH_SIZE = 50  # MediaWiki query API's max titles per request
SUFFIXES = ["dst_map", "dsle_map"]  # primary, then fallback
COLOR_TOL = 12  # same tolerance as extract_pack_evolved_dwds.py's backdrop match

# enumerate_species_files's page-image request timeout. Longer than the
# 20s api_query_titles/resolve_titles uses for imageinfo lookups because a
# species page carries far more data per title: 30-100+ linked images
# (card scans, franchise logos, etc., not just the dot/vpet uploads this
# function is after), several times heavier than an imageinfo response.
# Measured directly: a real 19-title batch (docs/graph-provenance.json's
# larval/child-stage species) hit socket.timeout at 20s on every one of
# 10 sequential 2-title sub-batches, but the identical query succeeded on
# the first try at 60s.
ENUM_REQUEST_TIMEOUT = 60

# Finite retry with exponential backoff for enumerate_species_files's
# requests, on top of the longer timeout above -- a single dropped
# connection or transient 5xx shouldn't crash the whole run. Backoff is
# ENUM_RETRY_BACKOFF_SECONDS * 2**attempt seconds between attempts (2s,
# then 4s, for ENUM_MAX_RETRIES=3 total attempts) -- bounded, never
# infinite. A 4xx is treated as a real error and raised immediately,
# since retrying an already-malformed request can't help.
ENUM_MAX_RETRIES = 3
ENUM_RETRY_BACKOFF_SECONDS = 2

# menubar/claudemon-menubar.swift's portraitBox. A portrait bigger than this
# forces drawAspectFit into a fractional downscale, which re-blurs the pixel
# grid the portrait was added to preserve (README "박스가 그림보다 작으면"). It
# also doubles as the upper bound on an acceptable native size when picking a
# portrait source: a native crop past this is more likely anti-aliased render
# art than pixel art (measured: Craniummon_vpet_alysion.png is 512x512 with a
# block-factor of 1, i.e. no pixel grid at all -- see pick_portrait_source()).
PORTRAIT_BOX = 208

# --portrait candidate filter: filenames enumerated from a species' Wikimon
# page (enumerate_species_files) that don't look like dot/sprite art at all
# (e.g. artwork scans, card images) are dropped before anyone downloads them.
PORTRAIT_KEYWORDS = ("map", "vpet", "dot", "sprite")
# vpet_cutin uploads are measured to be 64x32 horizontal walk-cycle strips,
# not a portrait crop -- excluded even though the name matches "vpet".
#
# dst_map/dsle_map (SUFFIXES) are excluded too, even though they match the
# "map" keyword above: they're the exact overworld-walk art the node dot
# itself is already built from (resolve_species/normalize_to_node_dot), so
# accepting one as a portrait would just re-crop the dot's own source
# instead of adding the distinct battle-pose art a portrait exists for
# (README "배틀 포즈 초상"). Native size alone doesn't catch this -- map
# uploads measure ~30x39 natively (see this module's --portrait docstring
# section), comfortably inside the (CANVAS, PORTRAIT_BOX] accept window, so
# without this explicit exclusion a map file can still win a species that
# has no bigger vpet/dot candidate: measured 8/192 picks in a
# --max-candidates 4 run were dst_map/dsle_map before this exclusion.
#
# "_dot" (Wikimon's third map-adjacent suffix, e.g. Bakumon_dot.png) is
# excluded too. Measured across every "_dot" candidate this module's
# development turned up: Bakumon/Craniummon/Duftmon are a genuine 8x
# NEAREST blowup of a 14x14 grid (size-gated out on their own), but
# Karatuki_Numemon_dot.png -- the one "_dot" file that *did* clear every
# other gate, landing at a plausible 112x112 -- turned out on inspection to
# be a yellow/green rectangle grid, not a Numemon (likely a palette or
# reference image uploaded under the wrong filename; see
# PORTRAIT_MIN_TRANSITION_DENSITY for the measurement that confirms this
# programmatically). "_dot" has never produced a usable portrait across
# this investigation, so it's excluded outright rather than leaned on the
# corruption detector alone -- don't reintroduce it just because a future
# "_dot" upload's upload size looks promising; measure it first.
#
# "vpet_dpc" is excluded too, for a different reason than "_dot": these are
# 2-frame GIFs (84x84 upload) where BOTH frames are already fragmented --
# confirmed by opening the raw source directly, e.g. Mercurymon_vpet_dpc.gif
# (mode P, 84x84, n_frames=2, transparency index 4, duration 500): frame 0
# has 5171 opaque pixels, frame 1 has 5143, and alpha-compositing the two
# frames together (5510 opaque pixels) still doesn't reconstruct a
# recognizable silhouette -- the source art itself is a mosaic of
# fragments, not a script bug and not something frame-compositing can fix.
# A full 184-species visual audit caught 8 vpet_dpc species that had passed
# every other gate: apollomon, bearmon, crescemon, dianamon, flaremon,
# gryzmon, mercurymon, minervamon.
#
# Do NOT try to catch this family by raising PORTRAIT_MIN_TRANSITION_DENSITY
# instead of excluding the keyword -- measured across all 184 winning
# picks from that same audit, transition density does NOT separate real
# art from vpet_dpc corruption: confirmed-real dotshinegreymon measures
# 0.535 and dotmiragegaogamon 0.585, while confirmed-corrupted vpet_dpc
# picks range from gryzmon at 0.560 up to minervamon at 0.899 -- the real
# and corrupted distributions overlap, and a real "Dot"-line sprite (which
# is chunky/blocky by original design) sits *below* several corrupted
# vpet_dpc picks. Raising the threshold to exclude vpet_dpc would exclude
# real Dot-line sprites first. This is the detector's known limitation:
# it only catches the single failure mode (near-uniform rectangular
# blocks) it was measured against, not fragmented/mosaic corruption --
# new families need their own visual audit, not a threshold tweak.
#
# Both this list and PORTRAIT_KEYWORDS are matched against a filename with
# spaces normalized to underscores (see _is_portrait_candidate) -- Wikimon's
# page-image enumeration returns space-separated titles ("Bakumon dst
# map.png"), not the underscore form these suffix tokens are written in.
PORTRAIT_EXCLUDE_KEYWORDS = ("vpet_cutin", "_dot", "vpet_dpc") + tuple(SUFFIXES)

# --portrait corruption filter: some candidates pass every other gate
# (dot-like filename, native size inside the accept window) and still
# aren't character art -- Karatuki_Numemon_dot.png is the confirmed case
# above. Real pixel-art silhouettes change color on nearly every column
# and row of their trimmed crop (an organic outline sweeps across almost
# all of them); a handful of large uniform rectangular blocks -- e.g. a
# palette/reference chart -- only changes color at a few block boundaries,
# collapsing this toward 0. Measured directly (see _transition_density),
# the fraction of columns/rows that differ from their predecessor, on the
# *already-processed* (backdrop-cleared, downsampled, bbox-cropped) image:
# four visually-confirmed real sprites -- Angemon_vpet_vb (1.0),
# Zudomon_vpet_vb (0.984), Aeroveedramon_sprite_DSani (1.0),
# Dotshinegreymon_dst_battle_attack (0.535) -- versus
# Karatuki_Numemon_dot at 0.117. 0.3 sits with a wide margin on both sides
# of that gap (0.117 -> 0.3 -> 0.535). This threshold catches exactly that
# one failure mode (uniform rectangular blocks) -- it does NOT separate
# vpet_dpc's fragmented-mosaic corruption from real art (see the
# vpet_dpc comment on PORTRAIT_EXCLUDE_KEYWORDS for the overlapping
# measured distributions), so vpet_dpc is excluded by keyword instead of
# by raising this number.
PORTRAIT_MIN_TRANSITION_DENSITY = 0.3

# Cap on how many candidates get downloaded+measured per species. Ranked by
# upload area first so the cap drops the least-promising candidates, not an
# arbitrary prefix; most species have 1-3 real candidates, but a handful
# have a dozen+ sprite-sheet-adjacent uploads, and downloading all of them
# would multiply this script's network traffic for no benefit.
PORTRAIT_MAX_CANDIDATES = 4

# --portrait variant filter (see _is_variant_filename): sprite-set naming
# tokens, stripped out of a filename before it's compared against the
# species' own title, so a suffix qualifier the title doesn't have (a
# different form/variant, not this node's species) can be told apart
# from the sprite-set's own vocabulary (map/vpet suffix names, generic
# art-descriptor words). Confirmed directly:
#   - Gabumon_no_fur_pelt_vpet_dvp.gif (46x52) beat Gabumon_vpet_vb.png's
#     native size (35x35, since vpet_vb's 192x192 upload is a 3x blowup
#     vs. this variant's unscaled 1x upload) and, on inspection, is a
#     palette-swapped "no fur" form, not the base blue/yellow Gabumon --
#     "no"/"fur"/"pelt" are the qualifier _is_variant_filename must catch.
#   - "raid" (Apocalymon/Millenniumon/VenomVamdemon/Cherubimon-Vice/
#     Cherubimon-Virtue "... raid vpet vb/xloader" uploads, 109-128px --
#     the largest assets this whole investigation found, vs. ~40-64px for
#     a plain vpet upload) is a boss-scale rendition of the *same*
#     species, confirmed by rendering four of them -- correct species,
#     high-quality pixel art. It's sprite-set vocabulary, not a form
#     qualifier, and belongs here, not in a rejection.
#
# Every entry here was actually observed on an *accepted* candidate during
# this investigation, never guessed: every vpet_* suffix's second half
# (vb/ws/dmc/dv/xloader/dark/spirit/dvic/d3/dm/dt/cutin/pen/penz/dpc/
# dscan/accel/dw/cycle/mini/alysion -- cutin/dpc are already excluded by
# PORTRAIT_EXCLUDE_KEYWORDS, but listing them here too is harmless), the
# map suffixes' halves (dst/dsle), the base keywords (map/vpet/dot/
# sprite), a rendition-scale word (raid), and generic art-descriptor
# words seen on accepted files (color, battle, attack).
#
# A token this module has never seen (a new/unrecognized set name, or an
# actual species/form word) is treated as part of the species/form name,
# not vocabulary -- i.e. it can make _is_variant_filename reject that
# candidate. This is a deliberate safe-reject default: a wrongly-rejected
# candidate only costs that species a no-gain/unavailable result, which
# shows up as a visible number in the dry-run summary (and, per-token,
# in its "off-title variant tokens" breakdown) and is cheap to fix
# (confirm the token is really a set name, add it here); a
# wrongly-accepted one is a wrong-character portrait shipped silently,
# exactly the failure mode this filter exists to catch, and is much
# harder to notice after the fact than a missing portrait. This
# vocabulary list is exactly that kind of miss once already: "raid" was
# initially left off, and only a full 235-species before/after diff
# caught the 5 species it had silently cost (see _is_variant_filename's
# docstring for why "silently" -- the earlier subset-of-tokens version
# of this filter, not just a missing vocabulary word, is what caused the
# wider 13-species regression that prompted rewriting it as a
# prefix comparison).
PORTRAIT_SET_VOCABULARY = frozenset({
    "map", "vpet", "dot", "sprite",
    "vb", "ws", "dmc", "dv", "xloader", "dark", "spirit", "dvic", "d3",
    "dm", "dt", "cutin", "pen", "penz", "dpc", "dscan", "accel", "dw",
    "cycle", "mini", "alysion",
    "dst", "dsle",
    "raid",
    "color", "battle", "attack",
})


def title_to_filename(title, suffix):
    return f"{title.replace(' ', '_')}_{suffix}.png"


def _candidate_bases(species):
    """Return the ordered list of upload-name bases to try for a species.

    Wikimon's upload naming isn't consistent across sprite sets: dst_map/
    dsle_map uploads title-case only the first character and lowercase the
    rest ("AncientGarurumon" -> "Ancientgarurumon_dsle_map.png"), while vpet
    uploads keep the species' original mixed case ("Airdramon_vpet_vb.png").
    A species carrying "file_bases" supplies both candidates explicitly (the
    title with spaces turned to underscores, and a base recovered from an
    already-confirmed "dotSource" with its known map suffix stripped) --
    trying both against the vpet sets measurably matters: across the 235
    species in docs/graph-provenance.json, the title-derived base alone hit
    142 vpet_vb species, and adding the dotSource-derived base as a second
    candidate found 30 more (via vpet_xloader) that the title-derived guess
    alone missed.

    Species without "file_bases" fall back to the single title-derived
    guess, same as the original single-base behaviour.
    """
    if species.get("file_bases"):
        return list(species["file_bases"])
    return [species["title"].replace(" ", "_")]


def api_query_titles(filenames):
    """Query the MediaWiki API for imageinfo of up to API_BATCH_SIZE File:
    titles. Uses ENUM_REQUEST_TIMEOUT (60s), not a shorter imageinfo-sized
    timeout, even though this response is small -- measured directly by
    varying both batch size and timeout on the same query: response time
    was a consistent 22-25s regardless of batch size (10 titles: 25.3s: a
    25-title batch: 22.1s), so a 20s-or-under timeout always misses by a
    couple seconds no matter how small the batch is, and retrying at that
    same too-short timeout is pointless -- every attempt dies at the same
    point. Batch size is not a lever here; don't try to fix this by
    shrinking API_BATCH_SIZE instead of raising the timeout."""
    titles_param = "|".join(f"File:{fn}" for fn in filenames)
    query = urllib.parse.urlencode({
        "action": "query",
        "titles": titles_param,
        "prop": "imageinfo",
        "iiprop": "url|size|mime",
        "format": "json",
        "formatversion": "2",
    })
    url = f"{WIKIMON_API}?{query}"
    try:
        return _get_json_with_retry(url, timeout=ENUM_REQUEST_TIMEOUT)
    except OSError as exc:
        raise RuntimeError(f"Wikimon API query failed for {len(filenames)} titles: {exc}") from exc


def _merge_imageinfo_batch(batch, data, results):
    """Merge one api_query_titles() response for `batch` into `results`
    (filename -> imageinfo dict, or None for a confirmed-missing file).
    Factored out of resolve_titles so both the whole-batch path and the
    per-title fallback path (see resolve_titles) apply the exact same
    normalized-title lookup."""
    query = data.get("query", {})

    # MediaWiki normalizes "File:A_B.png" -> "File:A B.png"; only titles
    # that actually changed show up in "normalized", so default every
    # queried title to itself and override from that list.
    resolved_title_for = {f"File:{fn}": f"File:{fn}" for fn in batch}
    for norm in query.get("normalized", []):
        resolved_title_for[norm["from"]] = norm["to"]

    page_by_title = {p["title"]: p for p in query.get("pages", [])}

    for fn in batch:
        resolved = resolved_title_for[f"File:{fn}"]
        page = page_by_title.get(resolved)
        if page is None or page.get("missing"):
            results[fn] = None
        else:
            imageinfo = page.get("imageinfo")
            results[fn] = imageinfo[0] if imageinfo else None


def resolve_titles(filenames):
    """Resolve a list of File: filenames to their imageinfo dict, or None
    if missing.

    Mirrors enumerate_species_files's two-tier network handling: a whole
    batch is tried first (one api_query_titles call, which already
    retries transient failures -- see _get_json_with_retry), and only if
    every retry is exhausted does this fall back to querying the batch's
    filenames one at a time, so one bad title can't blank out or crash
    the rest of a batch of up to API_BATCH_SIZE.

    Returns (results, errors): results is {filename: imageinfo_dict_or_None}
    as before (None still means "confirmed missing on Wikimon"); errors is
    {filename: reason} for filenames whose lookup failed even after the
    per-title fallback -- a network fault, not a confirmed absence, so
    callers must report it as such (see unavailable_reason) rather than
    treating it like a missing file.
    """
    results = {}
    errors = {}
    for start in range(0, len(filenames), API_BATCH_SIZE):
        batch = filenames[start:start + API_BATCH_SIZE]
        try:
            data = api_query_titles(batch)
            _merge_imageinfo_batch(batch, data, results)
            continue
        except RuntimeError:
            pass  # fall through to the per-title fallback below

        for fn in batch:
            try:
                data = api_query_titles([fn])
                _merge_imageinfo_batch([fn], data, results)
            except RuntimeError as exc:
                results[fn] = None
                errors[fn] = str(exc)
    return results, errors


def _request_with_retry(url, timeout, parse):
    """GET `url`, retrying up to ENUM_MAX_RETRIES times with exponential
    backoff (ENUM_RETRY_BACKOFF_SECONDS * 2**attempt) on a timeout,
    connection error, or 5xx response, and return `parse(response)` on
    success. A 4xx is raised immediately -- it's a malformed request, not
    a transient fault, so retrying it can't help. Raises the last error
    once every attempt is exhausted: a genuinely unreachable resource must
    surface as a failure the caller can act on, never silently look like
    "confirmed absent" or "no images".

    `parse` is a callable applied to the open response object (e.g.
    json.load for an API call, `lambda resp: resp.read()` for a raw byte
    download) -- one retry policy shared by every urlopen call this module
    makes (enumerate_species_files's page-image queries,
    api_query_titles's imageinfo queries, fetch_bytes's image downloads),
    since all three hit the same Wikimon host and were observed to time
    out sporadically regardless of endpoint (measured directly: a plain
    imageinfo lookup for a single filename hit socket.timeout on one
    attempt and succeeded on a retry moments later; a 6-title imageinfo
    batch timed out on all 3 attempts in one run and succeeded outright
    in the next -- this is host-level flakiness, not something a smaller
    batch size reliably avoids, which is why batch size wasn't reduced as
    a fix here).
    """
    last_exc = None
    for attempt in range(ENUM_MAX_RETRIES):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return parse(resp)
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                raise
            last_exc = exc
        except OSError as exc:
            # Covers urllib.error.URLError and a bare socket timeout
            # (TimeoutError), both OSError subclasses.
            last_exc = exc
        if attempt < ENUM_MAX_RETRIES - 1:
            time.sleep(ENUM_RETRY_BACKOFF_SECONDS * (2 ** attempt))
    raise last_exc


def _get_json_with_retry(url, timeout=ENUM_REQUEST_TIMEOUT):
    """GET `url` and parse its JSON body -- see _request_with_retry for
    the retry/backoff policy this applies. `timeout` defaults to
    ENUM_REQUEST_TIMEOUT (enumerate_species_files's heavier page-image
    requests); api_query_titles passes its own shorter value for the
    lighter imageinfo lookups."""
    return _request_with_retry(url, timeout, json.load)


def _describe_network_error(exc):
    """Human-readable failure kind for unavailable_reason -- distinguishes
    a timeout from an HTTP 5xx so a report doesn't collapse both into a
    vague "network error"."""
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}"
    if isinstance(exc, TimeoutError):
        return "timeout"
    return str(exc) or exc.__class__.__name__


def _enumerate_batch(batch):
    """One images-enumeration request cycle (following imcontinue paging
    to the end) for a single list of titles. Raises OSError/HTTPError
    (via _get_json_with_retry) if any request in the cycle exhausts every
    retry -- the caller decides whether to retry at a coarser (batch) or
    finer (per-title) granularity; this function itself never retries at
    a different granularity or swallows a failure.

    Returns {title: [filename, ...]} for every title in `batch`.
    """
    base_params = {
        "action": "query",
        "titles": "|".join(batch),
        "prop": "images",
        "imlimit": "500",
        "redirects": "1",
        "format": "json",
        "formatversion": "2",
    }

    images_by_resolved = {}
    normalized_to = {}
    redirect_to = {}
    continue_params = {}
    while True:
        params = {**base_params, **continue_params}
        url = f"{WIKIMON_API}?{urllib.parse.urlencode(params)}"
        data = _get_json_with_retry(url)

        query_result = data.get("query", {})
        # A queried title may get normalized (spaces/underscores) and
        # then redirected to a different page; both "normalized" and
        # "redirects" only list titles that actually changed, so these
        # accumulate across continuation requests same as "pages" does.
        normalized_to.update({n["from"]: n["to"] for n in query_result.get("normalized", [])})
        redirect_to.update({r["from"]: r["to"] for r in query_result.get("redirects", [])})
        for p in query_result.get("pages", []):
            images_by_resolved.setdefault(p["title"], []).extend(p.get("images", []))

        if "continue" not in data:
            break
        continue_params = data["continue"]

    result = {}
    for t in batch:
        resolved = redirect_to.get(normalized_to.get(t, t), normalized_to.get(t, t))
        images = images_by_resolved.get(resolved, [])
        result[t] = [img["title"][len("File:"):] for img in images if img["title"].startswith("File:")]
    return result


def enumerate_species_files(titles):
    """Enumerate every File: title linked from each species' Wikimon page.

    Uses action=query&prop=images&imlimit=500&redirects=1 rather than
    guessing an upload filename -- this is the only way to discover a
    species' actual portrait-source candidates, because Wikimon's vpet
    upload names don't follow one consistent suffix scheme (25+ distinct
    suffixes observed across a 20-species sample, see this module's
    --portrait docstring section) and several vpet uploads are .gif, not
    .png (e.g. Alraumon_vpet_dt.gif), which a suffix-and-extension guess
    would never find. redirects=1 is required: species like VenomVamdemon
    or YukiAgumon are Wikimon redirects, and without redirect-following
    their page comes back with zero images.

    imlimit=500 is a per-*request* cap on the total number of images
    returned across every title in the batch, not a per-page cap -- most
    Wikimon pages carry 30-100+ images (card scans, franchise logos, etc.,
    plus the dot/vpet uploads this function is after), so a batch of
    API_BATCH_SIZE titles routinely exceeds 500 combined before reaching
    every title. Measured directly: a real 35-title batch from
    docs/graph-provenance.json returned a "continue" token after ~19
    titles, and every title after that point in the batch came back with
    an empty image list -- not because the page has no images, but
    because the API never got to it. _enumerate_batch's loop follows that
    "continue" token (imcontinue) until the response omits it,
    accumulating each page's images across requests, so no title in a
    batch is silently starved by an earlier one's image count.

    Network faults are handled in two tiers, both via _get_json_with_retry
    (see ENUM_REQUEST_TIMEOUT/ENUM_MAX_RETRIES): first the whole batch is
    retried as one request cycle (_enumerate_batch); if that still fails
    after every retry (e.g. a batch containing one abnormally heavy page --
    measured: Digitama, a franchise-wide index page, returns a fixed
    HTTP 500 under imlimit=500 no matter how many retries), the batch is
    split and each title is requested on its own, so one bad title can't
    blank out or crash the rest of the batch. A title that still fails
    after that individual retry is recorded in `errors_for`, never
    silently folded into "confirmed no images" or allowed to raise and
    kill the whole run.

    `titles` are species page titles (not "File:..." titles).

    Returns (files_for, errors_for). files_for is {title: [filename, ...]}
    -- one entry per input title, filenames without the "File:" prefix,
    exactly as the API returned them (never reassembled by hand); a title
    that failed even the per-title fallback gets an empty list here.
    errors_for is {title: reason} for exactly those titles -- a network
    failure, not a confirmed absence, so callers (see
    resolve_portrait_species/unavailable_reason) must report it as such
    rather than treating it as "nothing on Wikimon".
    """
    files_for = {}
    errors_for = {}
    for start in range(0, len(titles), API_BATCH_SIZE):
        batch = titles[start:start + API_BATCH_SIZE]
        try:
            files_for.update(_enumerate_batch(batch))
            continue
        except OSError:
            pass  # fall through to the per-title fallback below

        for t in batch:
            try:
                files_for.update(_enumerate_batch([t]))
            except OSError as exc:
                files_for[t] = []
                errors_for[t] = _describe_network_error(exc)
    return files_for, errors_for


def _is_portrait_candidate(filename):
    """Filter enumerate_species_files() output down to dot-like uploads.

    A filename containing "map"/"vpet"/"dot"/"sprite" passes, except
    vpet_cutin (64x32 walk-cycle strip) and dst_map/dsle_map (the node
    dot's own source -- see PORTRAIT_EXCLUDE_KEYWORDS).

    The match is case-insensitive *and* space/underscore-insensitive:
    enumerate_species_files() returns titles the way Wikimon's page-image
    list gives them, which is space-separated ("Babamon vpet dark
    color.png", "Bakumon dst map.png"), while the tokens this filter
    checks against are written with underscores ("vpet_cutin", "dst_map").
    Without normalizing both to the same separator first, "vpet_cutin"
    never matches "Plotmon vpet cutin.gif" and the exclusion silently does
    nothing -- measured directly: Plotmon's 60x32 vpet_cutin upload was
    picked as a portrait before this normalization was added.
    """
    normalized = filename.lower().replace(" ", "_")
    if any(x in normalized for x in PORTRAIT_EXCLUDE_KEYWORDS):
        return False
    return any(k in normalized for k in PORTRAIT_KEYWORDS)


def _tokenize(text):
    """Lowercase word tokens, in order, split on anything that isn't a
    letter or digit (spaces, underscores, colons, parentheses, hyphens,
    periods, ...). Order matters here (unlike a plain set of tokens):
    _variant_extra_tokens concatenates these back into a string to
    compare against a title the same way, so "Mugen Dramon" and
    "Mugendramon" -- same species, no space in the upload -- normalize
    to the identical string "mugendramon"."""
    tokens = []
    current = []
    for ch in text.lower():
        if ch.isalnum():
            current.append(ch)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return tokens


def _species_tokens(filename):
    """`filename`'s tokens (extension stripped) with PORTRAIT_SET_VOCABULARY
    entries removed -- the tokens that should name the species/form,
    sprite-set naming stripped out. Shared by _variant_extra_tokens (is
    this filename a variant?) and _matches_full_title (does it name the
    species' full title, qualifier included?)."""
    stem = filename.rsplit(".", 1)[0]
    return [t for t in _tokenize(stem) if t not in PORTRAIT_SET_VOCABULARY]


def _matches_full_title(filename, title):
    """True if `filename`'s species tokens (vocabulary stripped) spell
    out the species' *entire* title, form qualifier included -- e.g.
    "Cherubimon virtue vpet vb.png" for title "Cherubimon (Virtue)".

    Used only as a tie-break priority in pick_portrait_source among
    candidates that already passed _is_variant_filename, never as a
    filter on its own: some species genuinely have more than one real
    form sharing very similar art (confirmed directly -- Cherubimon
    (Vice) and Cherubimon (Virtue) each have both a form-specific upload
    ("Cherubimon vice/virtue vpet vb.png") and an ambiguous one that
    doesn't name either form ("Cherubimon raid vpet vb.png", a
    boss-scale rendition that isn't clearly one form or the other). Both
    pass _is_variant_filename (neither has a suffix qualifier the title
    lacks), so without this tie-break the larger upload wins regardless
    of which one actually confirms it's the right form -- a
    form-specific candidate should win that even if it's smaller.
    """
    return "".join(_species_tokens(filename)) == "".join(_tokenize(title))


def _variant_extra_tokens(filename, title):
    """If `filename` names a different form/variant of the species than
    `title`, return the filename's own tokens that make it one (for
    reporting -- see resolve_portrait_species's "off-title variant
    tokens" tally); otherwise return None (not a variant).

    An earlier version of this check rejected a filename if *any* of its
    tokens wasn't a title word or PORTRAIT_SET_VOCABULARY entry. That
    over-rejected badly: title/filename spelling differences are common
    on Wikimon -- "Mugen Dramon" (title) vs. "Mugendramon" (filename, no
    space), "BanchoLeomon" (title) vs. "Bantyoliomon" (filename, a
    different romanization) -- and every token in a differently-spelled
    species name looked exactly as "unrecognized" as an actual variant
    qualifier. Measured directly: fixing PORTRAIT_SET_VOCABULARY's
    biggest single gap ("raid") on its own didn't fix this -- a full
    235-species before/after diff still showed 13 legitimate species
    losing their real portrait this way.

    This version compares NORMALIZED STRINGS instead of token sets:
    strip PORTRAIT_SET_VOCABULARY tokens out of the filename, concatenate
    what's left (the filename's "species part") and concatenate the
    title's own tokens the same way, then check whether the title-string
    is a *strict* (proper, shorter) prefix of the species-part string.
    The two strings simply being equal (spacing/romanization differences
    aside) means the same species under a different upload spelling --
    not a variant, no extra tokens. Extra characters *after* the species
    name (a suffix qualifier like "no fur pelt" or "Burst Mode") do mean
    a different form -- unless the title *also* names that qualifier
    ("Ravmon: Burst Mode" already contains "burst", so
    "Ravmon burst vpet vb.png" is an exact match, not a variant).

    A mismatch anywhere before the title is exhausted -- including a
    qualifier written *before* the species name -- doesn't trip this
    check at all; every variant actually observed in this investigation
    appends its qualifier after the name, so that's the shape this
    function is built to catch, not a claim that no other shape exists.

    Worked examples (title -> filename's species part -> verdict):
      "Mugen Dramon" -> "mugendramon" (equal, not a proper prefix) -> not a variant
      "BanchoLeomon" -> "bantyoliomon" (diverges before title ends) -> not a variant
      "Aero V-dramon" -> "aeroveedramondsani" (diverges before title ends) -> not a variant
      "Apocalymon" -> "apocalymon" ("raid" stripped as vocabulary, equal) -> not a variant
      "Gabumon" -> "gabumonnofurpelt" (title is a proper prefix) -> variant, extra=[no, fur, pelt]
    """
    species_tokens = _species_tokens(filename)
    title_part = "".join(_tokenize(title))
    species_part = "".join(species_tokens)
    if not (len(title_part) < len(species_part) and species_part.startswith(title_part)):
        return None

    # Walk the (ordered) species tokens to find which whole tokens fall
    # entirely after the title's own prefix -- these are the qualifier
    # words responsible for the rejection. In every case observed here
    # the boundary lands on a token edge (the species name is its own
    # token(s), immediately followed by separate qualifier tokens), so
    # this simple walk is exact for reporting purposes.
    consumed = 0
    extra = []
    for tok in species_tokens:
        if consumed >= len(title_part):
            extra.append(tok)
        consumed += len(tok)
    return extra


def _is_variant_filename(filename, title):
    """True if `filename` names a different form/variant of the species
    than `title` -- see _variant_extra_tokens."""
    return _variant_extra_tokens(filename, title) is not None


def resolve_species(species_list, suffixes=SUFFIXES):
    """Resolve each species to its Wikimon source file.

    Each species dict may carry an explicit "dot_file" (the exact uploaded
    filename, e.g. "Shinegreymon_burst_mode_dst_map.png") for titles whose
    Wikimon-title-derived guess doesn't match the real upload (colons,
    parentheses, MediaWiki's forced-capital-first normalization, etc.). When
    "dot_file" is present, that exact filename is looked up and nothing else
    is guessed -- a missing dot_file is unavailable, it never falls back to
    guessing from the title, to keep this script from ever guessing an
    asset name. This path is untouched by everything below.

    Species without "dot_file" are resolved by trying every (suffix, base)
    combination in order: outer loop over `suffixes` (SUFFIXES for the map
    dots -- the only caller left; --portrait resolves through
    resolve_portrait_species instead, which enumerates a species' actual
    Wikimon page rather than guessing a suffix), inner loop over each
    species' _candidate_bases() slot -- so a species with two file_bases
    gets its first base tried against every suffix's earlier slots before
    falling back to its second base. Every (suffix, slot) combination is
    resolved as one batched API query covering all species that still have
    a candidate there, and a hit removes that species from `pending`
    immediately so it's never queried again. With suffixes=SUFFIXES and no
    species carrying "file_bases" (bases collapse to the single
    title-derived guess), this is exactly the original two-suffix,
    single-base loop -- regenerating the existing map dots is unaffected.

    Returns a list of dicts (input order preserved), each the input species
    dict plus: suffix, filename, info -- where info is the imageinfo dict on
    success, or None if no source resolves on Wikimon. Unresolved species
    also carry "tried": the list of suffixes that were attempted.
    """
    order = {s["id"]: i for i, s in enumerate(species_list)}
    records = {}

    explicit = [s for s in species_list if s.get("dot_file")]
    if explicit:
        filename_for = {s["id"]: s["dot_file"] for s in explicit}
        # resolve_titles no longer crashes on a network fault (it falls
        # back per-title and reports failures separately) -- this map
        # path doesn't distinguish "confirmed not on Wikimon" from "we
        # never reached the page" the way --portrait's enum_error does,
        # so a network-failed title here still resolves to info=None,
        # same as before this fallback existed.
        resolved, _ = resolve_titles(list(filename_for.values()))
        for s in explicit:
            fn = filename_for[s["id"]]
            info = resolved.get(fn)
            records[s["id"]] = {**s, "suffix": "dot_file", "filename": fn, "info": info}

    pending = [s for s in species_list if not s.get("dot_file")]
    bases_for = {s["id"]: _candidate_bases(s) for s in pending}
    max_slots = max((len(bases_for[s["id"]]) for s in pending), default=0)

    for suffix in suffixes:
        if not pending:
            break
        for slot in range(max_slots):
            if not pending:
                break
            slot_candidates = [s for s in pending if slot < len(bases_for[s["id"]])]
            if not slot_candidates:
                continue
            filename_for = {
                s["id"]: title_to_filename(bases_for[s["id"]][slot], suffix)
                for s in slot_candidates
            }
            resolved, _ = resolve_titles(list(filename_for.values()))

            hit_ids = set()
            for s in slot_candidates:
                fn = filename_for[s["id"]]
                info = resolved.get(fn)
                if info:
                    records[s["id"]] = {**s, "suffix": suffix, "filename": fn, "info": info}
                    hit_ids.add(s["id"])
            pending = [s for s in pending if s["id"] not in hit_ids]

    for s in pending:
        records[s["id"]] = {**s, "suffix": None, "filename": None, "info": None, "tried": list(suffixes)}

    return [records[s["id"]] for s in sorted(species_list, key=lambda s: order[s["id"]])]


def fetch_bytes(url, cache_path):
    """Download `url`'s raw bytes (cached at `cache_path`), retrying
    transient failures via _request_with_retry at the same 30s
    per-attempt timeout this always used. A --portrait run downloads up
    to PORTRAIT_MAX_CANDIDATES images per species across hundreds of
    species; one candidate's download timing out must not crash the
    whole run any more than an enumeration or imageinfo timeout should
    (see pick_portrait_source, which catches this call's RuntimeError and
    moves on to the next candidate instead of propagating it)."""
    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            return f.read()
    try:
        data = _request_with_retry(url, timeout=30, parse=lambda resp: resp.read())
    except OSError as exc:
        raise RuntimeError(f"download failed for {url}: {exc}") from exc
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, "wb") as f:
        f.write(data)
    return data


def _place_on_canvas(im):
    """Shared final stage for both normalization paths: bbox trim -> shrink
    with NEAREST if still oversized (preserving aspect ratio) -> paste onto
    a 32x32 transparent canvas, centered horizontally and bottom-aligned."""
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    if im.width > CANVAS or im.height > CANVAS:
        factor = min(CANVAS / im.width, CANVAS / im.height)
        im = im.resize(
            (max(1, int(im.width * factor)), max(1, int(im.height * factor))),
            Image.NEAREST,
        )
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(im, ((CANVAS - im.width) // 2, CANVAS - im.height), im)
    return canvas


def normalize_to_node_dot(raw_bytes):
    """dst_map/dsle_map path: RGBA convert straight into the shared canvas
    stage. These uploads are already properly alpha-transparent, so no
    backdrop removal or scale detection runs here -- unchanged from before
    the vpet source was added, so existing sprites/nodes output is unaffected."""
    im = Image.open(io.BytesIO(raw_bytes)).convert("RGBA")
    return _place_on_canvas(im)


def _backdrop_colors(im):
    """Candidate backdrop colours: any colour filling 2+ corners, or a
    single colour covering >=20% of opaque pixels -- same heuristic as
    scripts/extract_pack_evolved_dwds.py's cell_backdrops()."""
    px = im.load()
    w, h = im.size
    corners = Counter(px[x, y] for x in (0, w - 1) for y in (0, h - 1))
    backdrops = {c for c, n in corners.items() if n >= 2 and c[3] >= 32}
    opaque = [c for c in im.getdata() if c[3] >= 32]
    if opaque:
        color, n = Counter(opaque).most_common(1)[0]
        if n / (w * h) >= 0.20:
            backdrops.add(color)
    return backdrops


def _close_to_any(color, backdrops):
    return any(
        abs(color[0] - b[0]) + abs(color[1] - b[1]) + abs(color[2] - b[2]) <= COLOR_TOL
        for b in backdrops
    )


def clear_border_backdrop(im):
    """Flood-fill from the image border, clearing to transparent only the
    background pixels connected to the edge. Unlike a global colour
    replace, a same-coloured region that never touches the border (e.g. a
    white eye highlight on a white-background sprite) survives untouched --
    only the connected backdrop itself is cleared."""
    im = im.convert("RGBA")
    w, h = im.size
    backdrops = _backdrop_colors(im)
    if not backdrops:
        return im
    px = im.load()
    seen = bytearray(w * h)
    queue = deque()
    for x in range(w):
        queue.append((x, 0))
        queue.append((x, h - 1))
    for y in range(h):
        queue.append((0, y))
        queue.append((w - 1, y))
    while queue:
        x, y = queue.popleft()
        idx = y * w + x
        if seen[idx]:
            continue
        seen[idx] = 1
        c = px[x, y]
        if not _close_to_any(c, backdrops):
            continue
        if c[3] != 0:
            px[x, y] = (c[0], c[1], c[2], 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx]:
                queue.append((nx, ny))
    return im


def _axis_block_factor(im, axis):
    """GCD of the gaps between positions where a column (axis=0) or row
    (axis=1) first differs from its predecessor. On a clean NEAREST upscale
    of a smaller pixel-art grid, every gap is a multiple of the upscale
    factor; any anti-aliasing or native per-pixel detail collapses this to 1."""
    px = im.load()
    w, h = im.size
    gaps = []
    prev = 0
    if axis == 0:
        for x in range(1, w):
            if any(px[x, y] != px[x - 1, y] for y in range(h)):
                gaps.append(x - prev)
                prev = x
        gaps.append(w - prev)
    else:
        for y in range(1, h):
            if any(px[x, y] != px[x, y - 1] for x in range(w)):
                gaps.append(y - prev)
                prev = y
        gaps.append(h - prev)
    gaps = [g for g in gaps if g > 0]
    result = gaps[0] if gaps else 1
    for g in gaps[1:]:
        result = gcd(result, g)
    return result


def downsample_integer_block(im):
    """If the image is larger than the target canvas and both axes agree on
    the same integer upscale factor that evenly divides the image, reduce by
    that exact factor (one representative pixel per block -- lossless for a
    uniform block). Otherwise leave the image as-is; _place_on_canvas's
    arbitrary NEAREST shrink is the fallback for anything that doesn't fit
    this pattern, so a scale is never guessed."""
    if max(im.size) <= CANVAS:
        return im
    fx = _axis_block_factor(im, 0)
    fy = _axis_block_factor(im, 1)
    if fx == fy and fx > 1 and im.width % fx == 0 and im.height % fx == 0:
        im = im.resize((im.width // fx, im.height // fx), Image.NEAREST)
    return im


def _transition_density(im, axis):
    """Fraction of columns (axis=0) or rows (axis=1) that differ from their
    immediate predecessor -- see PORTRAIT_MIN_TRANSITION_DENSITY for why
    this separates real sprite art from a uniform-block image such as a
    palette or reference chart uploaded under a dot-like filename."""
    px = im.load()
    w, h = im.size
    if axis == 0:
        if w <= 1:
            return 1.0
        transitions = sum(1 for x in range(1, w) if any(px[x, y] != px[x - 1, y] for y in range(h)))
        return transitions / (w - 1)
    if h <= 1:
        return 1.0
    transitions = sum(1 for y in range(1, h) if any(px[x, y] != px[x, y - 1] for x in range(w)))
    return transitions / (h - 1)


def _looks_like_corrupted_art(im):
    """True if `im` (already through normalize_vpet_portrait -- backdrop
    cleared, downsampled, bbox-cropped) is probably not real character art.
    See PORTRAIT_MIN_TRANSITION_DENSITY for the measured threshold."""
    return min(_transition_density(im, 0), _transition_density(im, 1)) < PORTRAIT_MIN_TRANSITION_DENSITY


def normalize_vpet_dot(raw_bytes):
    """vpet_* path: RGBA convert (first frame only for animated GIFs, which
    Image.open() already opens on without extra seeking) -> border-flood
    backdrop removal -> integer-block downsample if measured -> shared
    canvas stage."""
    im = Image.open(io.BytesIO(raw_bytes)).convert("RGBA")
    im = clear_border_backdrop(im)
    im = downsample_integer_block(im)
    return _place_on_canvas(im)


def normalize_vpet_portrait(raw_bytes):
    """Portrait counterpart of normalize_vpet_dot: same preprocessing (RGBA
    convert -> border-flood backdrop removal -> integer-block downsample),
    but stops short of _place_on_canvas -- a portrait is the trimmed
    native-resolution crop, not a 32px-squeezed node dot (README "원본 crop
    그대로"). Returns None when the trimmed art is CANVAS-or-smaller on both
    axes: the node dot at sprites/nodes/<id>-0.png already holds every pixel
    Wikimon has for this species, so a portrait file would be redundant with
    the menubar's own 32px upscale fallback."""
    im = Image.open(io.BytesIO(raw_bytes)).convert("RGBA")
    im = clear_border_backdrop(im)
    im = downsample_integer_block(im)
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    if im.width <= CANVAS and im.height <= CANVAS:
        return None
    return im


def pick_portrait_source(candidates, max_candidates=PORTRAIT_MAX_CANDIDATES, title=None):
    """Pick the best portrait source among one species' candidate files.

    `candidates` is a list of (filename, imageinfo) pairs already resolved
    via the MediaWiki API (enumerate_species_files + resolve_titles) --
    this function only ranks, downloads, and measures; it never queries or
    guesses a filename. `title` (the species' Wikimon title) is optional
    and used only for the _matches_full_title tie-break below -- omitting
    it just disables that tie-break, it never turns into a filter.

    Ranks by *upload* area descending (dropping anything whose upload
    doesn't even exceed CANVAS on some axis -- a smaller upload can never
    yield a bigger-than-dot native crop) and downloads+measures at most
    `max_candidates` of them, most-promising first, to bound how many
    requests one species can trigger (0 or negative means no cap -- every
    sized candidate gets measured). Each downloaded candidate is measured
    through the exact normalize_vpet_portrait pipeline (backdrop clear ->
    integer-block downsample -> bbox crop), so the size that decides
    selection is the same size that will be written -- not the raw upload
    pixel count, which is frequently inflated by a NEAREST upscale (e.g.
    Bakumon_dot.png: 128x128 upload, 14x14 native) or, for renders like
    vpet_alysion, isn't pixel art in the first place
    (Craniummon_vpet_alysion.png: 512x512 upload, measured block-factor 1).

    Among candidates whose native size lands in (CANVAS, PORTRAIT_BOX] on
    both axes *and* pass _looks_like_corrupted_art's check, the winner is
    chosen by (form match, native area, filename): a candidate whose
    filename spells out the species' *entire* title -- form qualifier
    included, e.g. "Cherubimon virtue vpet vb.png" for "Cherubimon
    (Virtue)" -- beats one that doesn't (see _matches_full_title), even
    if the other candidate has a bigger native size; within the same
    form-match tier, the largest by native area wins; ties break on
    filename so a re-run is reproducible. A candidate that fails the
    corruption check is skipped in favor of the next-ranked one, not
    treated as if the whole species had no candidate.

    Returns (winner, status, truncated, corrupted, download_failed) where
    status is "ok" (winner is (filename, info, (native_w, native_h))),
    "no_gain" (every downloaded candidate was CANVAS-or-smaller, winner is
    None), or "unavailable" (nothing else -- no candidate, only
    over-PORTRAIT_BOX ones, only corrupted ones, or every download failed,
    winner is None). truncated is how many upload-area-ranked candidates
    were dropped solely by the max_candidates cap (always 0 when
    uncapped). corrupted is how many measured candidates were rejected by
    _looks_like_corrupted_art. download_failed is how many candidates'
    fetch_bytes call failed even after its own retries -- a candidate
    that fails to download is skipped in favor of the next-ranked one,
    the same as a corrupted or over-PORTRAIT_BOX one, never allowed to
    raise and crash the whole run (see fetch_and_write's docstring for
    why this matters at 200+ species x up to max_candidates downloads).
    """
    ranked = [c for c in candidates if max(c[1]["width"], c[1]["height"]) > CANVAS]
    ranked.sort(key=lambda c: c[1]["width"] * c[1]["height"], reverse=True)
    if max_candidates > 0:
        truncated = max(0, len(ranked) - max_candidates)
        ranked = ranked[:max_candidates]
    else:
        truncated = 0

    in_window = []
    too_small = 0
    corrupted = 0
    download_failed = 0
    for fn, info in ranked:
        cache_path = os.path.join(CACHE_DIR, fn)
        try:
            raw = fetch_bytes(info["url"], cache_path)
        except RuntimeError:
            download_failed += 1
            continue
        native = normalize_vpet_portrait(raw)
        if native is None:
            too_small += 1
            continue
        if max(native.width, native.height) > PORTRAIT_BOX:
            continue
        if _looks_like_corrupted_art(native):
            corrupted += 1
            continue
        in_window.append((native.width * native.height, fn, info, (native.width, native.height)))

    if in_window:
        in_window.sort(key=lambda m: (0 if title and _matches_full_title(m[1], title) else 1, -m[0], m[1]))
        _, fn, info, native_size = in_window[0]
        return (fn, info, native_size), "ok", truncated, corrupted, download_failed
    if ranked and too_small == len(ranked):
        return None, "no_gain", truncated, corrupted, download_failed
    return None, "unavailable", truncated, corrupted, download_failed


def resolve_portrait_species(species_list, max_candidates=PORTRAIT_MAX_CANDIDATES):
    """Resolve each species' --portrait source by enumerating every file
    linked from its Wikimon page instead of guessing a suffix (see this
    module's --portrait docstring section for the measured evidence that
    made a fixed suffix ladder unworkable).

    Enumeration (enumerate_species_files) and the imageinfo lookup
    (resolve_titles) are each done once, batched across every species in
    `species_list`, before any per-species ranking/downloading happens
    (pick_portrait_source) -- so this stays a handful of API round trips
    for the whole batch, not one per species. `max_candidates` is passed
    straight through to pick_portrait_source (see its docstring).

    Returns (records, truncated, corrupted, variant_rejected,
    variant_tokens): records is a list of dicts (input order preserved)
    shaped like resolve_species()'s output -- id, title, filename, info
    -- where info is the imageinfo dict of the *winning* candidate, or
    None. A record with no winner additionally carries one of:
    no_gain=True (every downloaded candidate was CANVAS-or-under),
    candidates_tried (the candidate filenames that were checked, for
    unavailable_reason -- optionally with download_failures, a count of
    how many of those failed to download rather than being measured), or
    enum_error (enumerate_species_files couldn't reach this species' page
    at all after every retry -- a network fault, not a confirmed absence;
    see unavailable_reason). A resolved record also carries native_size,
    the measured (width, height) of the file that will actually be
    written. truncated is the total candidates dropped across all
    species solely by pick_portrait_source's max_candidates cap;
    corrupted is the total dropped by its _looks_like_corrupted_art
    check; variant_rejected is the total candidates dropped by
    _variant_extra_tokens (see PORTRAIT_SET_VOCABULARY) -- reported
    separately because it can turn an otherwise-resolvable species into
    no_gain/unavailable, and that shouldn't happen silently; variant_tokens
    is a Counter of the specific qualifier tokens (e.g. "no", "fur",
    "pelt") responsible, for a per-token breakdown -- a new/legitimate
    sprite-set word missing from PORTRAIT_SET_VOCABULARY shows up here as
    a token with an unexpectedly high count across many species, rather
    than requiring another full before/after diff to notice.
    """
    titles = [s["title"] for s in species_list]
    files_for, enum_errors = enumerate_species_files(titles)

    candidates_for = {}
    variant_rejected_total = 0
    variant_tokens = Counter()
    for s in species_list:
        dot_like = [f for f in files_for.get(s["title"], []) if _is_portrait_candidate(f)]
        kept = []
        for f in dot_like:
            extra = _variant_extra_tokens(f, s["title"])
            if extra is None:
                kept.append(f)
            else:
                variant_rejected_total += 1
                variant_tokens.update(extra)
        candidates_for[s["id"]] = kept
    all_filenames = sorted({fn for fns in candidates_for.values() for fn in fns})
    # imageinfo_errors (a network fault per filename, after resolve_titles's
    # own batch+per-title retry) isn't surfaced per-species here -- a
    # filename that fails this lookup just resolves to None, the same as a
    # confirmed-missing file, and is silently excluded from that species'
    # candidates. This is a smaller-impact simplification than a crash:
    # by this point the filename has already survived resolve_titles's
    # batch retry (ENUM_MAX_RETRIES attempts) and per-title fallback
    # (ENUM_MAX_RETRIES more), so a residual failure here is rare, and the
    # worst case is one candidate being underrepresented rather than the
    # whole run dying.
    imageinfo_for, _imageinfo_errors = resolve_titles(all_filenames) if all_filenames else ({}, {})

    records = []
    truncated_total = 0
    corrupted_total = 0
    for s in species_list:
        if s["title"] in enum_errors:
            # A network fault, not a confirmed absence -- keep it
            # distinct from candidates_tried so reporting never implies
            # "checked Wikimon and found nothing" for a page we never
            # actually reached.
            records.append({**s, "filename": None, "info": None, "enum_error": enum_errors[s["title"]]})
            continue

        raw_candidates = candidates_for[s["id"]]
        sized_candidates = [(fn, imageinfo_for[fn]) for fn in raw_candidates if imageinfo_for.get(fn)]

        winner, status, truncated, corrupted, download_failed = pick_portrait_source(
            sized_candidates, max_candidates=max_candidates, title=s["title"]
        )
        truncated_total += truncated
        corrupted_total += corrupted

        if status == "ok":
            fn, info, native_size = winner
            records.append({**s, "filename": fn, "info": info, "native_size": native_size})
        elif status == "no_gain":
            records.append({**s, "filename": None, "info": None, "no_gain": True})
        else:
            record = {**s, "filename": None, "info": None, "candidates_tried": raw_candidates}
            if download_failed:
                record["download_failures"] = download_failed
            records.append(record)

    return records, truncated_total, corrupted_total, variant_rejected_total, variant_tokens


def _existing_portrait_size(species_id):
    """Native size of an already-written sprites/nodes/portrait-<id>-0.png,
    or None if it doesn't exist yet. Used to report how many species would
    get a bigger portrait than what's already on disk (see main())."""
    path = os.path.join(NODES_DIR, f"portrait-{species_id}-0.png")
    if not os.path.exists(path):
        return None
    with Image.open(path) as im:
        return im.size


def unavailable_reason(record):
    if record.get("enum_error"):
        return f"network fault enumerating its Wikimon page ({record['enum_error']}) -- not confirmed absent"
    if record.get("dot_file"):
        return f"dot_file={record['dot_file']!r} not found on Wikimon"
    if "candidates_tried" in record:
        tried = record["candidates_tried"]
        if not tried:
            return "no map/vpet/dot/sprite file linked from its Wikimon page"
        reason = (
            f"{len(tried)} candidate(s) found ({', '.join(tried)}) but none native-sized "
            f"in ({CANVAS}, {PORTRAIT_BOX}]px"
        )
        if record.get("download_failures"):
            reason += (
                f" ({record['download_failures']} failed to download after retries -- "
                "network fault, not confirmed absent)"
            )
        return reason
    tried = record.get("tried") or SUFFIXES
    return f"no {'/'.join(tried)} on Wikimon"


def print_dry_run(records):
    for r in records:
        if r.get("no_gain"):
            print(f"[no-gain] {r['id']} ({r['title']}): every candidate already fits within {CANVAS}px")
        elif r["info"] is None:
            print(f"[unavailable] {r['id']} ({r['title']}): {unavailable_reason(r)}")
        else:
            info = r["info"]
            native = r.get("native_size")
            size = f"{native[0]}x{native[1]}" if native else f"{info['width']}x{info['height']}"
            print(
                f"[ok] {r['id']} ({r['title']}): source={r['filename']} size={size}"
            )


def fetch_and_write(records, force, portrait=False, truncated=0, corrupted=0, variant_rejected=0):
    ok = skip = unavailable = nogain = network_unavailable = 0
    os.makedirs(CACHE_DIR, exist_ok=True)
    largest_dim = 0
    largest_id = None
    largest_size = None

    for r in records:
        if r.get("no_gain"):
            nogain += 1
            print(f"[no-gain] {r['id']} ({r['title']}): every candidate already fits within {CANVAS}px, skipping portrait")
            continue
        if r["info"] is None:
            unavailable += 1
            if r.get("enum_error") or r.get("download_failures"):
                network_unavailable += 1
            print(f"[unavailable] {r['id']} ({r['title']}): {unavailable_reason(r)}")
            continue

        if portrait:
            out_path = os.path.join(NODES_DIR, f"portrait-{r['id']}-0.png")
        else:
            out_path = os.path.join(NODES_DIR, f"{r['id']}-0.png")
        if os.path.exists(out_path) and not force:
            skip += 1
            print(f"[skip] {r['id']}: {out_path} already exists (use --force to overwrite)")
            continue

        cache_path = os.path.join(CACHE_DIR, r["filename"])
        raw = fetch_bytes(r["info"]["url"], cache_path)

        if portrait:
            dot = normalize_vpet_portrait(raw)
            if dot is None:
                nogain += 1
                print(f"[no-gain] {r['id']}: {r['filename']} already fits within {CANVAS}px, skipping portrait")
                continue
        else:
            is_vpet = str(r.get("source", "")).startswith("vpet")
            dot = normalize_vpet_dot(raw) if is_vpet else normalize_to_node_dot(raw)

        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        dot.save(out_path)
        ok += 1
        info = r["info"]
        size_note = f" [{dot.width}x{dot.height}]" if portrait else ""
        print(
            f"[ok] {r['id']}: {r['filename']} ({info['width']}x{info['height']}) -> {out_path}{size_note}"
        )

        if portrait:
            dim = max(dot.width, dot.height)
            if dim > largest_dim:
                largest_dim = dim
                largest_id = r["id"]
                largest_size = (dot.width, dot.height)

    summary = f"\nok={ok} skip={skip} unavailable={unavailable} total={len(records)}"
    if portrait:
        summary += (
            f" no-gain={nogain} truncated={truncated} corrupted={corrupted} "
            f"variant-rejected={variant_rejected} network-unavailable={network_unavailable}"
        )
    print(summary)

    if portrait and largest_id is not None:
        print(f"largest portrait: {largest_id} ({largest_size[0]}x{largest_size[1]})")
        if largest_dim > PORTRAIT_BOX:
            print(
                f"WARNING: {largest_id}'s portrait ({largest_size[0]}x{largest_size[1]}) "
                f"exceeds PORTRAIT_BOX={PORTRAIT_BOX} -- re-measure the menubar's "
                "portraitBox constant"
            )

    return unavailable


def species_from_provenance(path):
    """Build a --portrait species list from docs/graph-provenance.json's
    per-node "id"/"title"/"dotSource" entries.

    Each entry's "file_bases" is the title-derived base ("Aero V-dramon" ->
    "Aero_V-dramon") plus, when "dotSource" is present, a second base
    recovered by stripping a known map-suffix tail off it (e.g.
    "Aerovdramon_dst_map.png" -> "Aerovdramon"). The tail to strip is
    derived from SUFFIXES rather than hardcoded, so a dotSource that doesn't
    end in one of those suffixes simply contributes no second base. See
    _candidate_bases's docstring for why trying both matters (142/30 hit
    counts measured across this exact 235-species batch).
    """
    with open(path, encoding="utf-8") as f:
        entries = json.load(f)

    species_list = []
    for entry in entries:
        file_bases = [entry["title"].replace(" ", "_")]
        dot_source = entry.get("dotSource")
        if dot_source:
            for suffix in SUFFIXES:
                tail = f"_{suffix}.png"
                if dot_source.endswith(tail):
                    base = dot_source[: -len(tail)]
                    if base not in file_bases:
                        file_bases.append(base)
                    break
        species_list.append({"id": entry["id"], "title": entry["title"], "file_bases": file_bases})
    return species_list


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--species", help="JSON file: [{\"id\": ..., \"title\": ...}, ...]")
    parser.add_argument("--id", help="single species id (use together with --title)")
    parser.add_argument("--title", help="single species Wikimon page title (use together with --id)")
    parser.add_argument(
        "--species-from-provenance", nargs="?", const=os.path.join("docs", "graph-provenance.json"),
        help="build the species list from a graph-provenance.json file (default: docs/graph-provenance.json)",
    )
    parser.add_argument(
        "--portrait", action="store_true",
        help="fetch sprites/nodes/portrait-<id>-0.png (native-resolution vpet crop) instead of the 32px node dot",
    )
    parser.add_argument(
        "--max-candidates", type=int, default=PORTRAIT_MAX_CANDIDATES,
        help=(
            "--portrait: cap on how many upload-area-ranked candidates get "
            f"downloaded and measured per species (default {PORTRAIT_MAX_CANDIDATES}). "
            "0 or negative means no cap -- every sized candidate is measured."
        ),
    )
    parser.add_argument("--dry-run", action="store_true", help="resolve sources only, write nothing")
    parser.add_argument(
        "--force", action="store_true",
        help="overwrite an existing sprites/nodes/<id>-0.png (default: skip)",
    )
    args = parser.parse_args()

    sources_given = sum([
        bool(args.species),
        bool(args.id or args.title),
        args.species_from_provenance is not None,
    ])
    if sources_given == 0:
        parser.error("one of --species, --id/--title, or --species-from-provenance is required")
    if sources_given > 1:
        parser.error("--species, --id/--title, and --species-from-provenance are mutually exclusive")
    if bool(args.id) != bool(args.title):
        parser.error("--id and --title must be used together")

    if args.species:
        with open(args.species, encoding="utf-8") as f:
            species_list = json.load(f)
    elif args.species_from_provenance is not None:
        species_list = species_from_provenance(args.species_from_provenance)
    else:
        species_list = [{"id": args.id, "title": args.title}]

    if args.portrait:
        records, truncated, corrupted, variant_rejected, variant_tokens = resolve_portrait_species(
            species_list, max_candidates=args.max_candidates
        )
    else:
        records = resolve_species(species_list)
        truncated = 0
        corrupted = 0
        variant_rejected = 0
        variant_tokens = Counter()

    if args.dry_run:
        print_dry_run(records)
        if args.portrait:
            larger_count = 0
            for r in records:
                native = r.get("native_size")
                if not native:
                    continue
                existing = _existing_portrait_size(r["id"])
                if existing is None or native[0] * native[1] > existing[0] * existing[1]:
                    larger_count += 1
            print(f"\nlarger-than-existing: {larger_count}")
            print(f"candidates truncated by --max-candidates cap ({args.max_candidates}): {truncated}")
            print(f"candidates rejected as corrupted/non-sprite art: {corrupted}")
            print(f"candidates rejected as off-title variant: {variant_rejected}")
            if variant_tokens:
                breakdown = ", ".join(f"{tok}={n}" for tok, n in variant_tokens.most_common())
                print(f"off-title variant tokens: {breakdown}")
            network_unavailable = sum(1 for r in records if r.get("enum_error") or r.get("download_failures"))
            print(f"unavailable due to network error (not confirmed absent): {network_unavailable}")
        sys.exit(1 if any(r["info"] is None and not r.get("no_gain") for r in records) else 0)

    unavailable = fetch_and_write(
        records, args.force, portrait=args.portrait,
        truncated=truncated, corrupted=corrupted, variant_rejected=variant_rejected,
    )
    sys.exit(1 if unavailable else 0)


if __name__ == "__main__":
    main()
