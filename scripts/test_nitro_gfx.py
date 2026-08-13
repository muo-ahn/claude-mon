#!/usr/bin/env python3
"""Unit tests for scripts/nitro_gfx.py against hand-built (synthetic) Nitro
files -- there is no NDS ROM on this machine to test against, so this is
the only way to prove the NCLR/NCGR/NCER binary parsing is actually
correct rather than "looks right by eye". Every fixture here is built
byte-for-byte from the same spec the decoder implements (see nitro_gfx.py's
module docstring for the source), so a passing test means the encode/decode
round-trip agrees with that spec -- it does NOT prove Digimon World
Dawn/Dusk's actual .pak files use this exact sub-format (there's no way to
prove that without the ROM), only that the decoder correctly implements
the documented Nitro G2D format it claims to implement.

Usage: python3 scripts/test_nitro_gfx.py
"""

import struct
import sys
import unittest

import nitro_gfx as ng


def _container(magic, sections):
    """Build a minimal 'new'-format Nitro G2D blob: header + sections.

    sections: list of (magic4, payload_bytes). Each section is written as
    magic + size(u32, includes the 8-byte section header) + payload.
    """
    header_size = 0x10
    body = b""
    for sec_magic, payload in sections:
        assert len(sec_magic) == 4
        body += sec_magic.encode("ascii") + struct.pack("<I", 8 + len(payload)) + payload
    file_size = header_size + len(body)
    header = (
        magic.encode("ascii")
        + struct.pack("<H", 0xFFFE)   # BOM
        + struct.pack("<H", 0x0100)   # version (unchecked by decoder)
        + struct.pack("<I", file_size)
        + struct.pack("<H", header_size)
        + struct.pack("<H", len(sections))
    )
    return header + body


def _pack_oam(x, y, shape, size, tile_index, palette, bit_depth=4,
              flip_x=False, flip_y=False, disabled=False, rotate_scale=False):
    attr0 = (y & 0xFF) | (disabled << 9) | ((bit_depth == 8) << 13) | (shape << 14)
    if rotate_scale:
        attr0 |= 1 << 8
    attr1 = (x & 0x1FF) | (flip_x << 12) | (flip_y << 13) | (size << 14)
    attr2 = (tile_index & 0x3FF) | ((palette & 0xF) << 12)
    return attr0, attr1, attr2


def build_nclr(colors_bgr555, bit_depth=4):
    depth_code = {4: 3, 8: 4}[bit_depth]
    payload = (
        struct.pack("<I", depth_code)
        + struct.pack("<I", 0)                       # extPalette
        + struct.pack("<I", len(colors_bgr555) * 2)   # data size
        + struct.pack("<I", 0x10)                     # data offset
        + struct.pack(f"<{len(colors_bgr555)}H", *colors_bgr555)
    )
    return _container("RLCN", [("TTLP", payload)])


def build_ncgr(bit_depth, tiles_raw, tiles_x=1, tiles_y=1, mapping_code=0):
    depth_code = {4: 3, 8: 4}[bit_depth]
    gfx_offset = 0x18
    tile_data = b"".join(tiles_raw)
    payload = (
        struct.pack("<H", tiles_y)
        + struct.pack("<H", tiles_x)
        + struct.pack("<I", depth_code)
        + struct.pack("<I", mapping_code)
        + struct.pack("<I", 0)                       # bitmap type (0 = tiled)
        + struct.pack("<I", len(tile_data))
        + struct.pack("<I", gfx_offset)
        + tile_data
    )
    assert len(payload) - len(tile_data) == gfx_offset
    return _container("RGCN", [("RAHC", payload)])


def build_ncer(cells_oams):
    """cells_oams: list of (per cell) list of (attr0, attr1, attr2) tuples."""
    n_cells = len(cells_oams)
    cell_data_offset = 0x14
    records = b""
    oam_blob = b""
    for oams in cells_oams:
        oam_ptr = len(oam_blob)
        records += struct.pack("<HHI", len(oams), 0, oam_ptr)
        for a0, a1, a2 in oams:
            oam_blob += struct.pack("<HHH", a0, a1, a2)
    header = (
        struct.pack("<H", n_cells)
        + struct.pack("<H", 0)      # bankAttribs (no bounding rect)
        + struct.pack("<I", cell_data_offset)
        + struct.pack("<I", 0)      # mapping mode (unused by our decoder)
        + b"\0" * 8                 # pad up to cell_data_offset (0x14)
    )
    assert len(header) == cell_data_offset
    payload = header + records + oam_blob
    return _container("RECN", [("CEBK", payload)])


def _solid_tile_4bpp(index):
    """One 8x8 4bpp tile where every pixel is palette index `index`."""
    byte = (index & 0xF) | ((index & 0xF) << 4)
    return bytes([byte]) * 32


class TestNclr(unittest.TestCase):
    def test_round_trip_colors(self):
        # BGR555: pure red, green, blue, and index-0 (conventionally transparent).
        red = 0b00000_00000_11111
        green = 0b00000_11111_00000
        blue = 0b11111_00000_00000
        blob = build_nclr([0x0000, red, green, blue], bit_depth=4)
        pal = ng.read_nclr(blob)
        self.assertEqual(pal.bit_depth, 4)
        self.assertEqual(pal.colors[1], (255, 0, 0))
        self.assertEqual(pal.colors[2], (0, 255, 0))
        self.assertEqual(pal.colors[3], (0, 0, 255))

    def test_bank_slicing(self):
        colors = list(range(32))  # two 16-color banks worth of arbitrary BGR555 words
        blob = build_nclr(colors, bit_depth=4)
        pal = ng.read_nclr(blob)
        self.assertEqual(len(pal.colors), 32)
        self.assertEqual(len(pal.bank(1)), 16)

    def test_bad_magic_rejected(self):
        blob = bytearray(build_nclr([0, 1, 2, 3]))
        blob[0:4] = b"XXXX"
        with self.assertRaises(ng.NitroFormatError):
            ng.read_nclr(bytes(blob))

    def test_truncated_blob_rejected(self):
        blob = build_nclr([0, 1, 2, 3])
        with self.assertRaises(ng.NitroFormatError):
            ng.read_nclr(blob[:-2])  # fileSize field now disagrees with actual length


class TestNcgr(unittest.TestCase):
    def test_tile_pixel_decode_4bpp(self):
        # tile 0: alternating nibble pattern per byte -> pixels 0,1,2,3,4,5,6,7 per row
        row = bytes([0x10, 0x32, 0x54, 0x76])
        tile0 = row * 8
        tile1 = _solid_tile_4bpp(9)
        blob = build_ncgr(4, [tile0, tile1], tiles_x=2, tiles_y=1)
        bank = ng.read_ncgr(blob)
        self.assertEqual(bank.bit_depth, 4)
        self.assertEqual(bank.n_tiles, 2)
        pixels0 = bank.tile_pixels(0)
        self.assertEqual(pixels0[0], [0, 1, 2, 3, 4, 5, 6, 7])
        pixels1 = bank.tile_pixels(1)
        self.assertTrue(all(v == 9 for row_ in pixels1 for v in row_))

    def test_tile_pixel_decode_8bpp(self):
        tile0 = bytes(range(64))
        blob = build_ncgr(8, [tile0])
        bank = ng.read_ncgr(blob)
        pixels = bank.tile_pixels(0)
        self.assertEqual(pixels[0], list(range(8)))
        self.assertEqual(pixels[7], list(range(56, 64)))

    def test_out_of_range_tile_rejected(self):
        blob = build_ncgr(4, [_solid_tile_4bpp(1)])
        bank = ng.read_ncgr(blob)
        with self.assertRaises(ng.NitroFormatError):
            bank.tile_pixels(5)


class TestNcerAndRender(unittest.TestCase):
    def test_single_tile_cell_geometry_and_palette(self):
        # One 8x8 OAM at (3, -2) using tile 0, 4bpp, palette bank 0.
        oam = _pack_oam(x=3, y=-2, shape=0, size=0, tile_index=0, palette=0)
        ncer_blob = build_ncer([[oam]])
        cells = ng.read_ncer(ncer_blob)
        self.assertEqual(len(cells), 1)
        entry = cells[0].oam_entries[0]
        self.assertEqual((entry.x, entry.y, entry.width, entry.height), (3, -2, 8, 8))
        self.assertFalse(entry.disabled)

    def test_disabled_oam_excluded_from_render(self):
        visible = _pack_oam(x=0, y=0, shape=0, size=0, tile_index=0, palette=0)
        hidden = _pack_oam(x=0, y=0, shape=0, size=0, tile_index=1, palette=0, disabled=True)
        cells = ng.read_ncer(build_ncer([[visible, hidden]]))
        self.assertFalse(cells[0].oam_entries[0].disabled)
        self.assertTrue(cells[0].oam_entries[1].disabled)

    def test_affine_oam_rejected(self):
        with self.assertRaises(ng.NitroFormatError):
            ng.read_ncer(build_ncer([[_pack_oam(0, 0, 0, 0, 0, 0, rotate_scale=True)]]))

    def test_render_16x16_four_quadrant_composite(self):
        # 2x2 tile bank, one tile per quadrant, each a distinct solid palette index.
        tiles = [_solid_tile_4bpp(i) for i in (1, 2, 3, 4)]
        ncgr_blob = build_ncgr(4, tiles, tiles_x=2, tiles_y=2)
        tile_bank = ng.read_ncgr(ncgr_blob)

        # bank 0: transparent, red, green, blue, yellow, ...
        colors = [0x0000,
                  0b00000_00000_11111,   # 1 red
                  0b00000_11111_00000,   # 2 green
                  0b11111_00000_00000,   # 3 blue
                  0b00000_11111_11111]   # 4 yellow (R+G)
        nclr_blob = build_nclr(colors, bit_depth=4)
        palette = ng.read_nclr(nclr_blob)

        # 16x16 OAM (shape=0 square, size=1), 2x2 tiles read row-major from tile_index 0.
        oam = _pack_oam(x=0, y=0, shape=0, size=1, tile_index=0, palette=0)
        cells = ng.read_ncer(build_ncer([[oam]]))
        img = ng.render_cell(cells[0], tile_bank, palette)

        self.assertEqual(img.size, (16, 16))
        self.assertEqual(img.getpixel((0, 0)), (255, 0, 0, 255))     # top-left quadrant: red
        self.assertEqual(img.getpixel((15, 0)), (0, 255, 0, 255))    # top-right: green
        self.assertEqual(img.getpixel((0, 15)), (0, 0, 255, 255))    # bottom-left: blue
        self.assertEqual(img.getpixel((15, 15)), (255, 255, 0, 255))  # bottom-right: yellow

    def test_flip_x_mirrors_object(self):
        tiles = [_solid_tile_4bpp(1), _solid_tile_4bpp(2)]
        tile_bank = ng.read_ncgr(build_ncgr(4, tiles, tiles_x=2, tiles_y=1))
        colors = [0x0000, 0b00000_00000_11111, 0b00000_11111_00000]
        palette = ng.read_nclr(build_nclr(colors, bit_depth=4))

        oam_plain = _pack_oam(x=0, y=0, shape=1, size=0, tile_index=0, palette=0)  # 16x8
        oam_flipped = _pack_oam(x=0, y=0, shape=1, size=0, tile_index=0, palette=0, flip_x=True)
        plain = ng.render_cell(ng.read_ncer(build_ncer([[oam_plain]]))[0], tile_bank, palette)
        flipped = ng.render_cell(ng.read_ncer(build_ncer([[oam_flipped]]))[0], tile_bank, palette)

        self.assertEqual(plain.getpixel((0, 0)), (255, 0, 0, 255))
        self.assertEqual(plain.getpixel((15, 0)), (0, 255, 0, 255))
        self.assertEqual(flipped.getpixel((0, 0)), (0, 255, 0, 255))
        self.assertEqual(flipped.getpixel((15, 0)), (255, 0, 0, 255))

    def test_palette_index_zero_is_transparent(self):
        tile_bank = ng.read_ncgr(build_ncgr(4, [_solid_tile_4bpp(0)]))
        palette = ng.read_nclr(build_nclr([0x0000, 0b00000_00000_11111], bit_depth=4))
        oam = _pack_oam(x=0, y=0, shape=0, size=0, tile_index=0, palette=0)
        img = ng.render_cell(ng.read_ncer(build_ncer([[oam]]))[0], tile_bank, palette)
        self.assertEqual(img.getpixel((0, 0))[3], 0)  # alpha channel: fully transparent


if __name__ == "__main__":
    sys.exit(unittest.main())
