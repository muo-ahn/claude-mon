#!/usr/bin/env python3
"""Test script to download artwork samples and analyze background handling needs."""

import json
import os
import sys
import urllib.request
import urllib.parse
from PIL import Image
import io

WIKIMON_API = "https://wikimon.net/api.php"
USER_AGENT = "claudemon-artwork-test/1.0"
TEST_OUTPUT = "/tmp/artwork-test"

def api_query_artwork(title):
    """Query Wikimon for File:<title>.jpg"""
    filename = f"{title}.jpg"
    query = urllib.parse.urlencode({
        "action": "query",
        "titles": f"File:{filename}",
        "prop": "imageinfo",
        "iiprop": "url|size|mime",
        "format": "json",
        "formatversion": "2",
    })
    url = f"{WIKIMON_API}?{query}"

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)

    pages = data.get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing"):
        return None

    imageinfo = pages[0].get("imageinfo")
    return imageinfo[0] if imageinfo else None

def download_image(url):
    """Download image and return PIL Image"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return Image.open(io.BytesIO(resp.read()))

def analyze_background(img):
    """Analyze image background - check if it's mostly white"""
    if img.mode == 'RGBA':
        # Already has alpha
        return "RGBA", None

    # Sample corners to detect background color
    w, h = img.size
    corners = [
        img.getpixel((0, 0)),
        img.getpixel((w-1, 0)),
        img.getpixel((0, h-1)),
        img.getpixel((w-1, h-1))
    ]

    # Check if corners are white-ish
    white_corners = sum(1 for c in corners if all(v > 240 for v in c[:3]))

    return img.mode, {
        "corners": corners,
        "white_corners": white_corners,
        "size": img.size
    }

def main():
    with open("/tmp/artwork-samples.json") as f:
        samples = json.load(f)

    os.makedirs(TEST_OUTPUT, exist_ok=True)

    results = []
    for i, spec in enumerate(samples, 1):
        spec_id = spec["id"]
        title = spec["title"]

        print(f"\n{i:2d}. {spec_id:30s} {title}")

        info = api_query_artwork(title)
        if info is None:
            print(f"    [NOT FOUND] File:{title}.jpg")
            results.append({"id": spec_id, "title": title, "status": "not_found"})
            continue

        print(f"    Found: {info['width']}x{info['height']} {info['mime']}")

        try:
            img = download_image(info["url"])
            mode, bg_info = analyze_background(img)

            # Save test sample
            out_path = os.path.join(TEST_OUTPUT, f"{spec_id}.{info['mime'].split('/')[-1]}")
            img.save(out_path)

            print(f"    Mode: {mode}")
            if bg_info:
                print(f"    Background: {bg_info['white_corners']}/4 white corners")

            results.append({
                "id": spec_id,
                "title": title,
                "status": "ok",
                "size": (info['width'], info['height']),
                "mode": mode,
                "background": bg_info,
                "path": out_path
            })
        except Exception as e:
            print(f"    [ERROR] {e}")
            results.append({"id": spec_id, "title": title, "status": "error", "error": str(e)})

    # Summary
    print(f"\n{'='*60}")
    print(f"Downloaded: {sum(1 for r in results if r['status'] == 'ok')}/{len(samples)}")
    print(f"Not found: {sum(1 for r in results if r['status'] == 'not_found')}")
    print(f"Errors: {sum(1 for r in results if r['status'] == 'error')}")

    with_alpha = sum(1 for r in results if r.get('mode') == 'RGBA')
    white_bg = sum(1 for r in results if r.get('background', {}).get('white_corners', 0) >= 3)

    print(f"\nBackground analysis:")
    print(f"  Already RGBA: {with_alpha}")
    print(f"  White background: {white_bg}")
    print(f"\nTest images saved to: {TEST_OUTPUT}")

    with open(os.path.join(TEST_OUTPUT, "analysis.json"), 'w') as f:
        json.dump(results, f, indent=2)

if __name__ == "__main__":
    main()
