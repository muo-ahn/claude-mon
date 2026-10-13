#!/usr/bin/env python3
"""Test background removal strategies on downloaded artwork samples."""

import os
from PIL import Image, ImageChops, ImageFilter
from collections import Counter

TEST_INPUT = "/tmp/artwork-test"
TEST_OUTPUT = "/tmp/artwork-background-test"

def flood_fill_alpha(img, tolerance=20):
    """Remove white background using flood fill from edges.
    Similar to fetch-wikimon-dots.py's vpet background removal."""
    img = img.convert('RGBA')
    w, h = img.size
    pixels = img.load()

    # Collect candidate backdrop colors from corners
    corners = [
        pixels[0, 0][:3],
        pixels[w-1, 0][:3],
        pixels[0, h-1][:3],
        pixels[w-1, h-1][:3]
    ]

    # Find most common corner color (likely background)
    counter = Counter(corners)
    if not counter:
        return img

    bg_color = counter.most_common(1)[0][0]

    # Flood fill from all edges
    def color_distance(c1, c2):
        return sum(abs(a - b) for a, b in zip(c1[:3], c2[:3]))

    def should_remove(px):
        return color_distance(px[:3], bg_color) <= tolerance

    # BFS from edges
    to_visit = set()
    # Add all edge pixels
    for x in range(w):
        to_visit.add((x, 0))
        to_visit.add((x, h-1))
    for y in range(h):
        to_visit.add((0, y))
        to_visit.add((w-1, y))

    removed = set()
    while to_visit:
        x, y = to_visit.pop()
        if (x, y) in removed:
            continue
        if x < 0 or y < 0 or x >= w or y >= h:
            continue

        px = pixels[x, y]
        if should_remove(px):
            pixels[x, y] = (px[0], px[1], px[2], 0)  # Make transparent
            removed.add((x, y))
            # Add neighbors
            for dx, dy in [(-1,0), (1,0), (0,-1), (0,1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in removed:
                    to_visit.add((nx, ny))

    return img

def compare_strategies(img_path, spec_id):
    """Compare three strategies: original, flood fill, white card."""
    img = Image.open(img_path).convert('RGB')

    # Strategy A: Flood fill alpha
    alpha_img = flood_fill_alpha(img, tolerance=30)

    # Strategy B: Keep white background (convert to RGBA but keep white)
    white_img = img.convert('RGBA')

    # Strategy C: Tight crop alpha (more aggressive)
    aggressive_img = flood_fill_alpha(img, tolerance=50)

    return {
        'original': img,
        'flood_fill': alpha_img,
        'white_bg': white_img,
        'aggressive': aggressive_img
    }

def main():
    os.makedirs(TEST_OUTPUT, exist_ok=True)

    samples = [f for f in os.listdir(TEST_INPUT) if f.endswith('.jpg') or f.endswith('.jpeg')]

    if not samples:
        print(f"No samples found in {TEST_INPUT}")
        return

    print(f"Processing {len(samples)} samples...")

    for sample in samples[:5]:  # Process first 5 for quick test
        spec_id = os.path.splitext(sample)[0]
        img_path = os.path.join(TEST_INPUT, sample)

        print(f"\nProcessing {spec_id}...")

        try:
            strategies = compare_strategies(img_path, spec_id)

            # Save each strategy
            for name, img in strategies.items():
                if name == 'original':
                    continue  # Skip original
                out_path = os.path.join(TEST_OUTPUT, f"{spec_id}_{name}.png")
                img.save(out_path)
                print(f"  Saved: {name:15s} -> {out_path}")

        except Exception as e:
            print(f"  ERROR: {e}")

    print(f"\n{'='*60}")
    print(f"Results saved to: {TEST_OUTPUT}")
    print("\nNext step: Manually inspect the PNGs to decide:")
    print("  1. flood_fill: Clean edges, may remove white details")
    print("  2. white_bg: Keep all details, white background visible")
    print("  3. aggressive: Most background removed, may be too aggressive")

if __name__ == "__main__":
    main()
