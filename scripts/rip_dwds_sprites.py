#!/usr/bin/env python3
"""Rip raw graphics out of an NDS ROM (Digimon World Dawn/Dusk) for sprites
that nobody has publicly ripped before, so they can eventually feed into
this project's existing DWDS extraction flow (scripts/extract_pack_evolved_dwds.py
reads sprites/sheets/dwds/<name>.png; see README "스프라이트 팩").

This script never guesses which graphics/palette/cell combination belongs
to which digimon -- see the `contact` subcommand. It only ever slices bytes
whose boundaries are self-declared in the data (Nitro G2D headers, NDS ROM
FAT/FNT tables), and it fails loudly instead of emitting placeholder output
when a ROM or pak file isn't present.

Pipeline stages (see README "ROM에서 직접 립하기" for the full walkthrough):

  1. list-rom    -- find the exact in-ROM path of spr_chr.pak / spr_pal.pak /
                     spr_cel.pak (varies by game/region; don't guess it).
  2. extract-rom -- pull one named file out of the ROM's ndspy filesystem.
  3. split-pak   -- a .pak has no public spec for this game, so instead of
                     guessing its container format, this scans the raw bytes
                     for Nitro G2D magic signatures (NCGR/NCLR/NCER each
                     self-declare their own length) and slices out every
                     one it finds, in file order.
  4. contact     -- render every (chr index, palette index) or (chr, cel)
                     candidate near a target index as a numbered strip, the
                     same convention scripts/extract_pack_evolved_dwds.py
                     uses for --contact -- a human looks at the strip and
                     picks the right combination. Nothing here auto-selects
                     a "best" combo.
  5. render      -- once a human has picked exact indices, bake out one
                     specific cell as a transparent PNG.

Usage:
    python3 scripts/rip_dwds_sprites.py list-rom rom.nds --filter spr_
    python3 scripts/rip_dwds_sprites.py extract-rom rom.nds data/spr_chr.pak /tmp/spr_chr.pak
    python3 scripts/rip_dwds_sprites.py split-pak /tmp/spr_chr.pak /tmp/chr_split
    python3 scripts/rip_dwds_sprites.py contact /tmp/chr_split /tmp/pal_split /tmp/cel_split \
        --index 12 --vary palette --out /tmp/contact-pal.png
    python3 scripts/rip_dwds_sprites.py render /tmp/chr_split/ncgr_0012.bin \
        /tmp/pal_split/nclr_0012.bin /tmp/cel_split/ncer_0012.bin /tmp/out.png --cell 0

Requires: pip3 install ndspy pillow
"""

import argparse
import json
import os
import struct
import sys

import ndspy.rom
from PIL import Image

import nitro_gfx as ng

# Magic bytes for each Nitro sub-format this pipeline cares about, and the
# 3-letter tag used in split-pak's output filenames. (see nitro_gfx.py for
# the format spec these magics belong to.)
_MAGIC_TAGS = {"RGCN": "ncgr", "RLCN": "nclr", "RECN": "ncer"}

CANVAS = 32
STRIP_GAP = 2
STRIP_TICK = 4


# ---------------------------------------------------------------------------
# Stage 1/2: pull files out of the NDS ROM filesystem.

def _walk_rom_paths(folder, prefix=""):
    for name in folder.files:
        yield prefix + name
    for name, subfolder in folder.folders:
        yield from _walk_rom_paths(subfolder, prefix + name + "/")


def cmd_list_rom(args):
    if not os.path.isfile(args.rom):
        raise SystemExit(f"error: ROM file not found: {args.rom}")
    try:
        rom = ndspy.rom.NintendoDSRom.fromFile(args.rom)
    except Exception as exc:
        raise SystemExit(f"error: couldn't parse '{args.rom}' as an NDS ROM: {exc}")

    paths = sorted(_walk_rom_paths(rom.filenames))
    if args.filter:
        needle = args.filter.lower()
        paths = [p for p in paths if needle in p.lower()]
    if not paths:
        raise SystemExit(
            f"error: no files matched filter {args.filter!r} in this ROM's filesystem "
            f"(ROM has {len(list(_walk_rom_paths(rom.filenames)))} files total) -- "
            "run without --filter to see the full list, or double check the ROM."
        )
    for p in paths:
        print(p)


def cmd_extract_rom(args):
    if not os.path.isfile(args.rom):
        raise SystemExit(f"error: ROM file not found: {args.rom}")
    try:
        rom = ndspy.rom.NintendoDSRom.fromFile(args.rom)
    except Exception as exc:
        raise SystemExit(f"error: couldn't parse '{args.rom}' as an NDS ROM: {exc}")

    try:
        data = rom.getFileByName(args.rom_path)
    except KeyError:
        raise SystemExit(
            f"error: '{args.rom_path}' not found in this ROM's filesystem -- "
            f"run `list-rom {args.rom} --filter <substring>` to find the exact path "
            "(don't guess it, it varies by game/region dump)"
        )

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "wb") as f:
        f.write(data)
    print(f"wrote {args.out} ({len(data)} bytes) <- {args.rom_path}")


# ---------------------------------------------------------------------------
# Stage 3: split-pak. No public spec for this game's .pak container, so this
# scans raw bytes for Nitro G2D magics instead of assuming any pak header
# shape. Works whether the .pak is a bespoke container or a standard NARC
# wrapper, since it never looks at the wrapper -- only at the self-declaring
# Nitro sub-blobs inside it.

def _scan_nitro_blobs(data):
    """Yield (offset, magic, size, blob) for every self-consistent Nitro G2D
    blob found in `data`. A magic hit with an implausible declared size
    (out of bounds, too small) is reported separately as a `warning`
    rather than silently sliced -- see split_pak()'s caller."""
    warnings = []
    found = []
    offset = 0
    while offset + 0x10 <= len(data):
        magic = data[offset:offset + 4]
        tag = _MAGIC_TAGS.get(magic.decode("ascii", errors="replace"))
        if tag is None:
            offset += 1
            continue
        try:
            declared_size = struct.unpack_from("<I", data, offset + 8)[0]
        except struct.error:
            offset += 1
            continue
        if declared_size < 0x10 or offset + declared_size > len(data):
            warnings.append(
                f"0x{offset:X}: {magic.decode('ascii', errors='replace')!r} magic found but "
                f"declared size 0x{declared_size:X} doesn't fit in the remaining pak -- skipped, not sliced"
            )
            offset += 1
            continue
        blob = data[offset:offset + declared_size]
        found.append((offset, tag, declared_size, blob))
        offset += declared_size  # each Nitro sub-blob self-declares its own length; jump past it
    return found, warnings


def cmd_split_pak(args):
    if not os.path.isfile(args.pak):
        raise SystemExit(f"error: pak file not found: {args.pak}")
    with open(args.pak, "rb") as f:
        data = f.read()

    found, warnings = _scan_nitro_blobs(data)
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    if not found:
        raise SystemExit(
            f"error: found zero NCGR/NCLR/NCER blobs in '{args.pak}' ({len(data)} bytes). "
            "Either this isn't a graphics pak, or its contents are compressed "
            "(LZ10/LZ11) -- this tool does not guess at decompression."
        )

    os.makedirs(args.out_dir, exist_ok=True)
    manifest = []
    counters = {"ncgr": 0, "nclr": 0, "ncer": 0}
    for offset, tag, size, blob in found:
        idx = counters[tag]
        counters[tag] += 1
        name = f"{tag}_{idx:04d}.bin"
        with open(os.path.join(args.out_dir, name), "wb") as f:
            f.write(blob)
        manifest.append({"index": idx, "type": tag, "offset": offset, "size": size, "file": name})

    with open(os.path.join(args.out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"split {args.pak} -> {args.out_dir}: "
          + ", ".join(f"{n} {t}" for t, n in counters.items() if n))


# ---------------------------------------------------------------------------
# Stage 4: contact -- render candidate combinations for human review. Never
# auto-picks a "best" one.

def _load_blob(directory, tag, index):
    path = os.path.join(directory, f"{tag}_{index:04d}.bin")
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return f.read()


def _render_candidate(chr_dir, pal_dir, cel_dir, chr_idx, pal_idx, cel_idx, cell_no, palette_bank_offset):
    """Best-effort render of one (chr, pal, cel) candidate. Returns a PIL
    image, or None with a reason string if this exact combination can't be
    decoded (missing file / index out of range / format error) -- callers
    render that as a blank labeled cell rather than crashing the whole
    contact sheet over one bad candidate."""
    chr_blob = _load_blob(chr_dir, "ncgr", chr_idx)
    pal_blob = _load_blob(pal_dir, "nclr", pal_idx)
    cel_blob = _load_blob(cel_dir, "ncer", cel_idx)
    if chr_blob is None or pal_blob is None or cel_blob is None:
        return None, "missing"
    try:
        tile_bank = ng.read_ncgr(chr_blob)
        palette = ng.read_nclr(pal_blob)
        cells = ng.read_ncer(cel_blob)
        if cell_no >= len(cells):
            return None, f"only {len(cells)} cells"
        img = ng.render_cell(cells[cell_no], tile_bank, palette, palette_bank_offset)
        return img, None
    except ng.NitroFormatError as exc:
        return None, str(exc)[:24]


def cmd_contact(args):
    if args.palette is None:
        args.palette = args.index
    for directory in (args.chr_dir, args.pal_dir, args.cel_dir):
        if not os.path.isdir(directory):
            raise SystemExit(f"error: not a directory (did split-pak run on all three paks?): {directory}")

    indices = list(range(max(0, args.index - args.window), args.index + args.window + 1))
    if args.vary == "palette":
        candidates = [(args.index, p, args.index) for p in indices]
        labels = [str(p) for p in indices]
    else:  # --vary index: chr/pal/cel all shift together
        candidates = [(i, args.palette, i) for i in indices]
        labels = [str(i) for i in indices]

    cells = []
    for (chr_idx, pal_idx, cel_idx), label in zip(candidates, labels):
        img, reason = _render_candidate(
            args.chr_dir, args.pal_dir, args.cel_dir,
            chr_idx, pal_idx, cel_idx, args.cell, args.palette_bank_offset,
        )
        cells.append((label, img, reason))

    strip = Image.new(
        "RGBA",
        (len(cells) * (CANVAS + STRIP_GAP), CANVAS + STRIP_TICK),
        (0, 0, 0, 0),
    )
    for i, (label, img, reason) in enumerate(cells):
        x = i * (CANVAS + STRIP_GAP)
        if img is not None:
            w, h = img.size
            scale = min(CANVAS / w, CANVAS / h, 1)
            if scale < 1:
                img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.NEAREST)
            strip.paste(img, (x, CANVAS - img.size[1]), img)
        if i % 5 == 0:
            for ty in range(CANVAS, CANVAS + STRIP_TICK):
                for tx in range(x, x + CANVAS):
                    strip.putpixel((tx, ty), (255, 0, 0, 255))

    strip.save(args.out)
    print(f"{args.out}  <- vary={args.vary}, indices {labels[0]}..{labels[-1]} "
          f"(red tick under every 5th cell, left-to-right = ascending index)")
    for label, img, reason in cells:
        if reason:
            print(f"  index {label}: not rendered ({reason})")


# ---------------------------------------------------------------------------
# Stage 5: render -- bake out one confirmed (chr, pal, cel, cell) combo.

def cmd_render(args):
    for path in (args.chr_blob, args.pal_blob, args.cel_blob):
        if not os.path.isfile(path):
            raise SystemExit(f"error: file not found: {path}")

    with open(args.chr_blob, "rb") as f:
        tile_bank = ng.read_ncgr(f.read())
    with open(args.pal_blob, "rb") as f:
        palette = ng.read_nclr(f.read())
    with open(args.cel_blob, "rb") as f:
        cells = ng.read_ncer(f.read())

    if args.cell >= len(cells):
        raise SystemExit(f"error: --cell {args.cell} out of range ({len(cells)} cells in {args.cel_blob})")

    img = ng.render_cell(cells[args.cell], tile_bank, palette, args.palette_bank_offset)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    img.save(args.out)
    print(f"wrote {args.out} ({img.size[0]}x{img.size[1]})")


# ---------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("list-rom", help="list files in an NDS ROM's filesystem")
    p.add_argument("rom")
    p.add_argument("--filter", help="only show paths containing this substring")
    p.set_defaults(func=cmd_list_rom)

    p = sub.add_parser("extract-rom", help="pull one named file out of an NDS ROM")
    p.add_argument("rom")
    p.add_argument("rom_path", help="exact in-ROM path, e.g. data/spr_chr.pak (see list-rom)")
    p.add_argument("out")
    p.set_defaults(func=cmd_extract_rom)

    p = sub.add_parser("split-pak", help="scan a .pak for NCGR/NCLR/NCER blobs")
    p.add_argument("pak")
    p.add_argument("out_dir")
    p.set_defaults(func=cmd_split_pak)

    p = sub.add_parser("contact", help="render candidate chr/pal/cel combos for human review")
    p.add_argument("chr_dir")
    p.add_argument("pal_dir")
    p.add_argument("cel_dir")
    p.add_argument("--index", type=int, required=True, help="target index to center the candidate window on")
    p.add_argument("--window", type=int, default=3, help="candidates shown = index-window..index+window (default 3)")
    p.add_argument("--vary", choices=["palette", "index"], default="palette",
                   help="'palette': fix chr/cel at --index, vary palette index; "
                        "'index': shift chr/pal/cel together (default: palette)")
    p.add_argument("--palette", type=int, default=None,
                   help="palette index to use when --vary=index (default: same as --index)")
    p.add_argument("--cell", type=int, default=0, help="which NCER cell (pose) to render (default 0)")
    p.add_argument("--palette-bank-offset", type=int, default=0,
                   help="shift the 16-color bank a 4bpp OAM's palette field selects")
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_contact)

    p = sub.add_parser("render", help="bake out one confirmed combo as a PNG")
    p.add_argument("chr_blob")
    p.add_argument("pal_blob")
    p.add_argument("cel_blob")
    p.add_argument("out")
    p.add_argument("--cell", type=int, default=0)
    p.add_argument("--palette-bank-offset", type=int, default=0)
    p.set_defaults(func=cmd_render)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
