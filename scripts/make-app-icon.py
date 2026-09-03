#!/usr/bin/env python3
"""Claudemon.app 아이콘(.icns) 생성기.

마스코트 스프라이트는 32x32 픽셀아트다. 앱 아이콘은 1024까지 필요하므로
업스케일은 반드시 NEAREST 로 한다 - 스무딩 보간을 쓰면 픽셀아트가 흐려지고
작은 크기에서 형체가 뭉개진다. 반대로 마스터(1024)에서 작은 크기로 줄일 때는
LANCZOS 를 쓴다. 16px 에서 NEAREST 로 줄이면 스프라이트 픽셀이 불규칙하게
버려져 실루엣이 깨지기 때문이다.

배경은 밝은 크림 그라디언트다. 스프라이트의 아웃라인이 거의 검정이라
어두운 배경에서는 실루엣이 배경에 묻힌다.

macOS 아이콘 관례에 따라 콘텐츠는 캔버스를 꽉 채우지 않고 여백을 둔다
(1024 기준 라운드렉트 824, 코너 반경 185).

사용: python3 scripts/make-app-icon.py [스프라이트경로] [출력.icns]
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

MASTER = 1024
PLATE = 824          # 라운드렉트 한 변
PLATE_RADIUS = 185
MASCOT_TARGET = 560  # 플레이트 안에서 마스코트가 차지할 크기
BG_TOP = (255, 247, 236, 255)
BG_BOTTOM = (255, 226, 197, 255)
# iconutil 이 요구하는 파일명 -> 픽셀 크기
ICONSET = {
    'icon_16x16.png': 16,
    'icon_16x16@2x.png': 32,
    'icon_32x32.png': 32,
    'icon_32x32@2x.png': 64,
    'icon_128x128.png': 128,
    'icon_128x128@2x.png': 256,
    'icon_256x256.png': 256,
    'icon_256x256@2x.png': 512,
    'icon_512x512.png': 512,
    'icon_512x512@2x.png': 1024,
}


def gradient_plate():
    """세로 그라디언트로 채운 라운드렉트를 알파 마스크와 함께 만든다."""
    grad = Image.new('RGBA', (PLATE, PLATE))
    draw = ImageDraw.Draw(grad)
    for y in range(PLATE):
        t = y / max(PLATE - 1, 1)
        px = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(4))
        draw.line([(0, y), (PLATE, y)], fill=px)

    mask = Image.new('L', (PLATE, PLATE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, PLATE - 1, PLATE - 1], radius=PLATE_RADIUS, fill=255)
    grad.putalpha(mask)
    return grad


def upscale_nearest(sprite, target):
    """정수배 NEAREST 확대. target 을 넘지 않는 최대 정수배를 쓴다."""
    scale = max(1, target // max(sprite.size))
    return sprite.resize((sprite.width * scale, sprite.height * scale), Image.NEAREST)


def compose_master(sprite_path):
    sprite = Image.open(sprite_path).convert('RGBA')
    canvas = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))

    plate = gradient_plate()
    inset = (MASTER - PLATE) // 2
    canvas.alpha_composite(plate, (inset, inset))

    mascot = upscale_nearest(sprite, MASCOT_TARGET)
    canvas.alpha_composite(mascot, ((MASTER - mascot.width) // 2, (MASTER - mascot.height) // 2))
    return canvas


def write_iconset(master, iconset_dir):
    os.makedirs(iconset_dir, exist_ok=True)
    for name, size in ICONSET.items():
        img = master if size == MASTER else master.resize((size, size), Image.LANCZOS)
        img.save(os.path.join(iconset_dir, name))


def main():
    sprite_path = sys.argv[1] if len(sys.argv) > 1 else 'sprites/packs/guilmon/idle-0.png'
    out_icns = sys.argv[2] if len(sys.argv) > 2 else 'menubar/Claudemon.icns'

    if not os.path.exists(sprite_path):
        sys.exit(f'스프라이트를 찾을 수 없다: {sprite_path}')

    master = compose_master(sprite_path)
    tmp = tempfile.mkdtemp(prefix='claudemon-icon-')
    try:
        iconset = os.path.join(tmp, 'Claudemon.iconset')
        write_iconset(master, iconset)
        os.makedirs(os.path.dirname(out_icns) or '.', exist_ok=True)
        subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', out_icns], check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    preview = os.path.splitext(out_icns)[0] + '-preview.png'
    master.resize((256, 256), Image.LANCZOS).save(preview)
    print(f'{out_icns} ({os.path.getsize(out_icns)} bytes)')
    print(f'{preview} (미리보기)')


if __name__ == '__main__':
    main()
