#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
优化静态收藏表情：裁掉四周留白 + 缩放到 200x200 以内 + 压体积。
只读 state/stickers.json 和远程图片，输出到 state/sticker-optimized/。
**不修改原表情库、不改 QQ 账号上的收藏表情** —— 想启用是下一步的事。

用法:
  python scripts/optimize-stickers.py            # 只处理静态图（JPEG/PNG），跳过动图
  python scripts/optimize-stickers.py --all      # 连 GIF 一起处理（会把动图压成静态，慎用）
  python scripts/optimize-stickers.py --dry      # 只看会做什么，不写文件
"""
import io
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, 'state', 'stickers.json')
OUT_DIR = os.path.join(ROOT, 'state', 'sticker-optimized')
REPORT = os.path.join(OUT_DIR, 'report.json')

TARGET = 200          # 最长边缩到不超过这个值
PNG_OPTIMIZE = True

def load_store():
    with open(STORE, 'r', encoding='utf-8-sig') as f:
        data = json.load(f)
    return data if isinstance(data, list) else data.get('entries', [])

def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def sniff(b):
    if b[:6] in (b'GIF87a', b'GIF89a'):
        return 'GIF'
    if b[:8] == b'\x89PNG\r\n\x1a\n':
        return 'PNG'
    if b[:3] == b'\xff\xd8\xff':
        return 'JPEG'
    if b[:4] == b'RIFF' and b[8:12] == b'WEBP':
        return 'WEBP'
    return 'OTHER'

def trim_border(img):
    """裁掉与边缘同色的边框（JPEG 常见白底；PNG 可能是透明）。"""
    from PIL import Image, ImageChops
    rgba = img.convert('RGBA')
    w, h = rgba.size

    # 先看四角像素是否一致；不一致就不裁（避免把有内容的图裁坏）
    corners = [rgba.getpixel((0, 0)), rgba.getpixel((w - 1, 0)),
               rgba.getpixel((0, h - 1)), rgba.getpixel((w - 1, h - 1))]
    if len(set(corners)) != 1:
        return img
    bg = corners[0]

    # 全透明背景：直接按 alpha 通道裁
    if bg[3] == 0:
        bbox = rgba.getbbox()
        if bbox:
            return img.crop(bbox)
        return img

    # 同色背景：用差值法求边界
    solid = Image.new('RGBA', rgba.size, bg)
    diff = ImageChops.difference(rgba, solid).convert('L')
    # 容差：把接近背景的像素压成 0
    mask = diff.point(lambda p: 255 if p > 12 else 0)
    bbox = mask.getbbox()
    if not bbox:
        return img
    return img.crop(bbox)

def process_one(entry, do_gif=False):
    from PIL import Image
    url = entry.get('url') or ''
    sid = entry.get('id') or ''
    if not url:
        return {'id': sid, 'skip': 'no url'}
    try:
        raw = fetch(url)
        fmt = sniff(raw)
        if fmt == 'GIF' and not do_gif:
            return {'id': sid, 'skip': 'GIF(动图)', 'reason': '动图跳过'}
        img = Image.open(io.BytesIO(raw))
        ow, oh = img.size
        trimmed = trim_border(img)
        tw, th = trimmed.size
        # 等比缩放到 TARGET 以内（只缩不放）
        scale = min(1.0, TARGET / max(tw, th))
        nw, nh = max(1, round(tw * scale)), max(1, round(th * scale))
        if scale < 1.0:
            trimmed = trimmed.resize((nw, nh), Image.LANCZOS)
        else:
            nw, nh = tw, th
        os.makedirs(OUT_DIR, exist_ok=True)
        # 保持原格式：JPEG 源存 JPEG（PNG 存照片类小图反而更大），有透明通道才用 PNG。
        has_alpha = trimmed.mode in ('RGBA', 'LA', 'P') and 'transparency' in trimmed.info
        if has_alpha:
            rgba = trimmed.convert('RGBA')
            canvas = Image.new('RGBA', rgba.size, (255, 255, 255, 0))
            canvas.alpha_composite(rgba)
            out_path = os.path.join(OUT_DIR, f'{sid}.png')
            canvas.save(out_path, 'PNG', optimize=PNG_OPTIMIZE)
        elif fmt == 'PNG':
            out_path = os.path.join(OUT_DIR, f'{sid}.png')
            trimmed.convert('RGB').save(out_path, 'PNG', optimize=PNG_OPTIMIZE)
        else:
            out_path = os.path.join(OUT_DIR, f'{sid}.jpg')
            trimmed.convert('RGB').save(out_path, 'JPEG', quality=88, optimize=True, progressive=True)
        new_size = os.path.getsize(out_path)
        return {
            'id': sid,
            'desc': (entry.get('desc') or '')[:20],
            'fmt': fmt,
            'orig': f'{ow}x{oh}',
            'trimmed': f'{tw}x{th}',
            'final': f'{nw}x{nh}',
            'bytesBefore': len(raw),
            'bytesAfter': new_size,
            'file': out_path,
        }
    except Exception as e:
        return {'id': sid, 'error': str(e)}

def main():
    do_all = '--all' in sys.argv
    dry = '--dry' in sys.argv
    entries = load_store()
    print(f'表情库: {len(entries)} 条   目标最长边: {TARGET}px   动图: {"一起处理" if do_all else "跳过"}')
    if dry:
        print('(--dry 模式，不写文件)')
    todo = entries
    results = []
    if dry:
        from PIL import Image
        for e in todo[:5]:
            try:
                raw = fetch(e['url'])
                fmt = sniff(raw)
                img = Image.open(io.BytesIO(raw))
                print(f"  {e.get('id','')[:28]}  {fmt:5} {img.size[0]}x{img.size[1]}  {len(raw)}B  desc={e.get('desc','')[:12]}")
            except Exception as ex:
                print(f"  {e.get('id','')[:28]}  失败: {ex}")
        print('... 仅预览前 5 条')
        return

    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(lambda e: process_one(e, do_all), todo))

    ok = [r for r in results if 'file' in r]
    skipped = [r for r in results if 'skip' in r]
    failed = [r for r in results if 'error' in r]

    total_before = sum(r['bytesBefore'] for r in ok)
    total_after = sum(r['bytesAfter'] for r in ok)
    print(f'\n处理成功 {len(ok)}  跳过 {len(skipped)}  失败 {len(failed)}')
    if ok:
        print(f'总体积: {total_before/1024:.0f}KB -> {total_after/1024:.0f}KB '
              f'({(1 - total_after/max(1,total_before))*100:.0f}% 减少)')
        shrunk = [r for r in ok if r['orig'] != r['final']]
        print(f'尺寸有变化的: {len(shrunk)}/{len(ok)}')
        print('\n变化最大的 8 个:')
        for r in sorted(ok, key=lambda x: x['bytesBefore'] - x['bytesAfter'], reverse=True)[:8]:
            print(f"  {r['orig']:>9} -> {r['final']:<9} {r['bytesBefore']/1024:7.0f}KB -> {r['bytesAfter']/1024:6.0f}KB  desc={r['desc']}")
    if skipped:
        print(f"\n跳过 {len(skipped)} 个（主要是动图）")
    if failed:
        print(f'\n失败 {len(failed)} 个:')
        for r in failed[:6]:
            print(f"  {r['id'][:30]}: {r['error'][:90]}")

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(REPORT, 'w', encoding='utf-8') as f:
        json.dump({'target': TARGET, 'results': results}, f, ensure_ascii=False, indent=2)
    print(f'\n报告: {REPORT}')
    print(f'输出目录: {OUT_DIR}')

if __name__ == '__main__':
    main()
