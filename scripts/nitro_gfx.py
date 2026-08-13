#!/usr/bin/env python3
"""Pure-Python decoder for the Nintendo DS "Nitro" 2D graphics formats:
NCLR (palette), NCGR (tile pixel data) and NCER (cell/OBJ layout).

Why hand-roll this instead of shelling out to a tool: the usual GUI tool
for these formats (Tinke) is Windows/.NET-only and doesn't run on macOS,
and the CLI ROM-building tool (ndstool/devkitPro) only handles the NDS
filesystem, not sprite graphics. NCLR/NCGR/NCER are a small, fully
documented binary format (unlike the sheet-layout guessing this project
normally has to do), so decoding them is a spec implementation, not a
guess -- every offset below is taken from the reference C reader in
Garhoogin/NitroPaint (MIT-licensed, actively maintained open source),
files nclr.c/ncgr.c/ncer.c/nns.c, and cross-checked against the standard
GBA/NDS OBJ attribute layout (GBATEK).

This module has no NDS-specific dependency (just stdlib) so it can be
unit-tested against hand-built fixtures without a real ROM -- see
scripts/test_nitro_gfx.py.

Only the "new" Nitro G2D container format is supported (fileSize is a
direct self-declared u32 at offset 0x8). This is what every NDS game
released after ~2006 uses, which comfortably covers Digimon World
Dawn/Dusk (2007). The rarer "old" format needs the total blob length
supplied externally (it doesn't self-declare it), so callers that hit
it get a clear NitroFormatError instead of a silently wrong slice.

Only OBJ 1D character mapping is implemented for NCER cells (regular,
non-affine sprites). 2D mapping and rotate/scale (affine) OBJs raise
NitroFormatError rather than guessing a layout -- those aren't used by
DWDS field sprites as far as this pipeline has seen, and getting the
stride wrong would silently scramble the tiles.
"""

import struct

from PIL import Image


class NitroFormatError(ValueError):
    """Raised when a blob isn't a Nitro file this module can decode."""


# ---------------------------------------------------------------------------
# Generic Nitro G2D container: magic[4] + bom(u16) + version(u16) +
# fileSize(u32) + headerSize(u16, >=0x10) + numSections(u16), followed by
# `numSections` sections of magic[4] + size(u32, includes this 8-byte
# section header) + payload. (NitroPaint nns.c: NnsHeaderIsValid,
# NnsG2dGetSectionByMagic, NnsG2dFindBlockBySignature)

def _read_container(blob, expect_magic):
    if len(blob) < 0x10:
        raise NitroFormatError(f"blob too short for a Nitro header ({len(blob)} bytes)")
    magic = blob[0:4].decode("ascii", errors="replace")
    if magic != expect_magic:
        raise NitroFormatError(f"expected Nitro magic {expect_magic!r}, got {magic!r}")
    bom = struct.unpack_from("<H", blob, 0x4)[0]
    if bom not in (0xFFFE, 0xFEFF, 0x0000):
        raise NitroFormatError(f"bad BOM 0x{bom:04X} -- not a Nitro file")
    file_size = struct.unpack_from("<I", blob, 0x8)[0]
    header_size = struct.unpack_from("<H", blob, 0xC)[0]
    num_sections = struct.unpack_from("<H", blob, 0xE)[0]
    if header_size < 0x10 or num_sections < 1:
        raise NitroFormatError(f"bad Nitro header (headerSize={header_size}, numSections={num_sections})")
    if file_size != len(blob):
        # "old" format files don't self-declare their true size here (see
        # NnsG2dIsOld) -- we only support "new" format, so bail out clearly
        # instead of guessing where the file actually ends.
        raise NitroFormatError(
            f"declared fileSize (0x{file_size:X}) != blob length (0x{len(blob):X}) "
            "-- likely an 'old'-format Nitro G2D file, not supported"
        )
    return header_size, num_sections


def _find_section(blob, header_size, num_sections, section_magic):
    offset = header_size
    for _ in range(num_sections):
        if offset + 8 > len(blob):
            break
        magic = blob[offset:offset + 4].decode("ascii", errors="replace")
        size = struct.unpack_from("<I", blob, offset + 4)[0]
        if size < 8:
            raise NitroFormatError(f"section {magic!r} at 0x{offset:X} has bogus size {size}")
        if magic == section_magic:
            return blob[offset + 8:offset + size]
        offset += size
    return None


# ---------------------------------------------------------------------------
# NCLR -- palette. (NitroPaint nclr.c: PalReadNclr)

class Palette:
    def __init__(self, bit_depth, colors):
        self.bit_depth = bit_depth  # 4 or 8
        self.colors = colors        # list of (r, g, b) 0-255, index 0 per 16-bank is transparent

    def bank(self, index):
        """16-color bank `index` (only meaningful for 4bpp palettes)."""
        start = index * 16
        return self.colors[start:start + 16]


def _bgr555_to_rgb(word):
    r = (word & 0x1F) * 255 // 31
    g = ((word >> 5) & 0x1F) * 255 // 31
    b = ((word >> 10) & 0x1F) * 255 // 31
    return (r, g, b)


def read_nclr(blob):
    header_size, num_sections = _read_container(blob, "RLCN")
    pltt = _find_section(blob, header_size, num_sections, "TTLP")
    if pltt is None:
        raise NitroFormatError("NCLR has no TTLP (palette data) section")
    depth_code = struct.unpack_from("<I", pltt, 0x0)[0]
    bit_depth = 1 << (depth_code - 1)
    if bit_depth not in (4, 8):
        raise NitroFormatError(f"unexpected NCLR bit depth code {depth_code} (want 4bpp or 8bpp)")
    data_size = struct.unpack_from("<I", pltt, 0x8)[0]
    data_offset = struct.unpack_from("<I", pltt, 0xC)[0]
    pcmp = _find_section(blob, header_size, num_sections, "PMCP")
    if pcmp is not None:
        # Palette compression (index table mapping stored palettes to slot
        # numbers) shows up in some games but is rare for field sprites --
        # fail clearly rather than silently returning an unindexed table.
        raise NitroFormatError("NCLR uses PMCP palette compression, not supported by this decoder")
    n_colors = data_size // 2
    raw = pltt[data_offset:data_offset + n_colors * 2]
    colors = [_bgr555_to_rgb(w) for w in struct.unpack(f"<{n_colors}H", raw)]
    return Palette(bit_depth, colors)


# ---------------------------------------------------------------------------
# NCGR -- tile pixel data. (NitroPaint ncgr.c: ChrReadNcgr)

class TileBank:
    def __init__(self, bit_depth, mapping_1d, tile_data):
        self.bit_depth = bit_depth      # 4 or 8
        self.mapping_1d = mapping_1d    # True for 1D char mapping, False for 2D
        self.tile_data = tile_data      # raw bytes, tiles packed back-to-back
        self.bytes_per_tile = 32 if bit_depth == 4 else 64

    @property
    def n_tiles(self):
        return len(self.tile_data) // self.bytes_per_tile

    def tile_pixels(self, tile_index):
        """8x8 array (list of 8 lists of 8 ints) of palette indices for one tile."""
        offset = tile_index * self.bytes_per_tile
        chunk = self.tile_data[offset:offset + self.bytes_per_tile]
        if len(chunk) < self.bytes_per_tile:
            raise NitroFormatError(f"tile index {tile_index} out of range ({self.n_tiles} tiles present)")
        rows = []
        if self.bit_depth == 4:
            for row in range(8):
                row_bytes = chunk[row * 4:row * 4 + 4]
                pixels = []
                for b in row_bytes:
                    pixels.append(b & 0xF)
                    pixels.append((b >> 4) & 0xF)
                rows.append(pixels)
        else:
            for row in range(8):
                rows.append(list(chunk[row * 8:row * 8 + 8]))
        return rows


def read_ncgr(blob):
    header_size, num_sections = _read_container(blob, "RGCN")
    char = _find_section(blob, header_size, num_sections, "RAHC")
    if char is None:
        raise NitroFormatError("NCGR has no RAHC (CHAR) section")
    depth_code = struct.unpack_from("<I", char, 0x4)[0]
    bit_depth = 1 << (depth_code - 1)
    if bit_depth not in (4, 8):
        raise NitroFormatError(f"unexpected NCGR bit depth code {depth_code} (want 4bpp or 8bpp)")
    mapping_code = struct.unpack_from("<I", char, 0x8)[0]
    bitmap_type = struct.unpack_from("<I", char, 0xC)[0]
    if bitmap_type == 1:
        raise NitroFormatError("NCGR is a raw bitmap (non-tiled), not supported by this decoder")
    gfx_offset = struct.unpack_from("<I", char, 0x14)[0]
    tile_data = char[gfx_offset:]
    # mapping_code: 0..3 = 1D (32K/64K/128K/256K boundary), 4 = 2D.
    mapping_1d = mapping_code != 4
    return TileBank(bit_depth, mapping_1d, tile_data)


# ---------------------------------------------------------------------------
# NCER -- cell (OBJ group) layout. (NitroPaint ncer.c: CellReadNcer,
# CellDecodeOamAttributes)

# Standard GBA/NDS OBJ shape+size -> (width, height) in pixels. Hardware
# constant, not something this project guesses -- see GBATEK "OBJ Attribute
# 0/1" tables.
_OBJ_DIMENSIONS = {
    (0, 0): (8, 8), (0, 1): (16, 16), (0, 2): (32, 32), (0, 3): (64, 64),
    (1, 0): (16, 8), (1, 1): (32, 8), (1, 2): (32, 16), (1, 3): (64, 32),
    (2, 0): (8, 16), (2, 1): (8, 32), (2, 2): (16, 32), (2, 3): (32, 64),
}


class OamEntry:
    def __init__(self, x, y, width, height, tile_index, bit_depth, palette, flip_x, flip_y, disabled):
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.tile_index = tile_index
        self.bit_depth = bit_depth
        self.palette = palette
        self.flip_x = flip_x
        self.flip_y = flip_y
        self.disabled = disabled


class Cell:
    def __init__(self, oam_entries):
        self.oam_entries = oam_entries


def _decode_oam(attr0, attr1, attr2):
    shape = attr0 >> 14
    size = attr1 >> 14
    dims = _OBJ_DIMENSIONS.get((shape, size))
    if dims is None:
        raise NitroFormatError(f"invalid OBJ shape/size combo ({shape}, {size})")
    width, height = dims
    x = attr1 & 0x1FF
    if x >= 256:
        x -= 512
    y = attr0 & 0xFF
    if y >= 128:
        y -= 256
    rotate_scale = (attr0 >> 8) & 1
    if rotate_scale:
        raise NitroFormatError("OBJ uses rotate/scale (affine) attributes, not supported by this decoder")
    disabled = (attr0 >> 9) & 1
    flip_x = (attr1 >> 12) & 1
    flip_y = (attr1 >> 13) & 1
    tile_index = attr2 & 0x3FF
    palette = (attr2 >> 12) & 0xF
    is_8bpp = (attr0 >> 13) & 1
    bit_depth = 8 if is_8bpp else 4
    return OamEntry(x, y, width, height, tile_index, bit_depth, palette, bool(flip_x), bool(flip_y), bool(disabled))


def read_ncer(blob):
    header_size, num_sections = _read_container(blob, "RECN")
    cebk = _find_section(blob, header_size, num_sections, "CEBK")
    if cebk is None:
        raise NitroFormatError("NCER has no CEBK (cell bank) section")
    n_cells = struct.unpack_from("<H", cebk, 0x0)[0]
    bank_attribs = struct.unpack_from("<H", cebk, 0x2)[0]
    cell_data_offset = struct.unpack_from("<I", cebk, 0x4)[0]
    per_cell_size = 16 if bank_attribs == 1 else 8
    oam_data_base = cell_data_offset + n_cells * per_cell_size

    cells = []
    for i in range(n_cells):
        rec_offset = cell_data_offset + i * per_cell_size
        n_oam = struct.unpack_from("<H", cebk, rec_offset + 0)[0]
        oam_ptr = struct.unpack_from("<I", cebk, rec_offset + 4)[0]
        entries = []
        if n_oam:
            attrs = struct.unpack_from(f"<{n_oam * 3}H", cebk, oam_data_base + oam_ptr)
            for j in range(n_oam):
                a0, a1, a2 = attrs[j * 3:j * 3 + 3]
                entries.append(_decode_oam(a0, a1, a2))
        cells.append(Cell(entries))
    return cells


# ---------------------------------------------------------------------------
# Compositing: render one Cell to an RGBA canvas given its TileBank + Palette.

def render_cell(cell, tile_bank, palette, palette_bank_offset=0):
    """Render one Cell (from read_ncer) to a PIL RGBA Image.

    palette_bank_offset shifts which 16-color bank a 4bpp OAM's `palette`
    field selects -- lets a caller test candidate palette alignments
    without re-decoding anything (see rip_dwds_sprites.py `contact`).
    """
    visible = [e for e in cell.oam_entries if not e.disabled]
    if not visible:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0))

    min_x = min(e.x for e in visible)
    min_y = min(e.y for e in visible)
    max_x = max(e.x + e.width for e in visible)
    max_y = max(e.y + e.height for e in visible)
    canvas = Image.new("RGBA", (max_x - min_x, max_y - min_y), (0, 0, 0, 0))

    for e in visible:
        tiles_w = e.width // 8
        tiles_h = e.height // 8
        obj_img = Image.new("RGBA", (e.width, e.height), (0, 0, 0, 0))
        # 1D character mapping: successive tiles of a multi-tile OBJ are
        # contiguous in tile-index space, row-major (GBATEK OBJ char
        # mapping). This project only ever reads e.tile_index as already
        # being in the bank's own native tile-slot units (see tile_pixels),
        # so no bpp-dependent stride adjustment is needed here.
        for ty in range(tiles_h):
            for tx in range(tiles_w):
                tile_no = e.tile_index + ty * tiles_w + tx
                pixels = tile_bank.tile_pixels(tile_no)
                bank = palette.bank(e.palette + palette_bank_offset) if e.bit_depth == 4 else palette.colors
                for py in range(8):
                    for px in range(8):
                        idx = pixels[py][px]
                        if idx == 0:
                            continue  # index 0 is always transparent (hw convention)
                        if idx >= len(bank):
                            continue  # out-of-range candidate combo; caller's contact sheet will show it blank
                        obj_img.putpixel((tx * 8 + px, ty * 8 + py), (*bank[idx], 255))
        if e.flip_x:
            obj_img = obj_img.transpose(Image.FLIP_LEFT_RIGHT)
        if e.flip_y:
            obj_img = obj_img.transpose(Image.FLIP_TOP_BOTTOM)
        canvas.paste(obj_img, (e.x - min_x, e.y - min_y), obj_img)

    return canvas
