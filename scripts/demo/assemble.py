# The compositor/encoder for the demo GIF.
# Reads the capture (<dir>/beat-<n>.json + plan.json) and writes the GIF with
# the measured spec: 1552x992, base 100ms with the six measured holds,
# disposal=1, one shared 256-color palette, and no NETSCAPE block (single
# play). The screen content is the real renderer's captured cells; the
# wallpaper, window chrome, title, step counter, keystroke pill and block
# cursor are the compositor's treatment, per the measured tokens.

import json
import sys
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

WORK = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/opencode/demo-work')
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else 'assets/readme/demo.gif')

CANVAS = (1552, 992)
WIN_X0, WIN_Y0, WIN_X1, WIN_Y1 = 45, 30, 1502, 950  # w=1457, h=920
TITLE_END = 108
DOTS_Y = 75
DOTS_X0 = WIN_X0 + 34
DOT_R = 13

BG = (0, 43, 54)
GRAY = (147, 161, 161)
BODY = (232, 238, 240)
DIM = (66, 95, 102)
THOUGHT = (90, 117, 125)
RUNNING = (224, 151, 78)
RED = (200, 90, 84)
GREEN = (63, 163, 77)
CORAL = (230, 111, 77)
PROMPT = (138, 158, 164)
CURSOR = (131, 148, 155)
TITLE_COLOR = (245, 242, 245)
PILL_BG = (20, 24, 29)

FONT_DIR = '/usr/share/fonts/truetype/dejavu/'
COLS, ROWS = 76, 18
CELL_W, CELL_H = 18, 37
GLYPH = 30
PAD_X, PAD_Y = 40, 20

BAND_X0 = ((WIN_X0 + PAD_X) // CELL_W) * CELL_W
BAND_W = COLS * CELL_W
BAND_H = ROWS * CELL_H
BAND_Y0 = TITLE_END + ((WIN_Y1 - TITLE_END) - BAND_H) // 2

TITLE_LINE = 'PRRICODE — explain the failure in one line'


@lru_cache(maxsize=8)
def font(kind: str = 'regular', size: int = GLYPH):
    name = {'regular': 'DejaVuSansMono.ttf', 'bold': 'DejaVuSansMono-Bold.ttf',
            'italic': 'DejaVuSansMono-Oblique.ttf'}[kind]
    return ImageFont.truetype(FONT_DIR + name, size)


def wallpaper() -> Image.Image:
    """Oranges left to blues right, blurred — the measured bleed."""
    w, h = CANVAS
    small = Image.new('RGB', (w // 4, h // 4))
    stops = [(237, 178, 123), (243, 149, 94), (236, 140, 88),
             (8, 109, 194), (1, 59, 163), (1, 51, 157)]
    d = ImageDraw.Draw(small)
    sw = w // 4
    for x in range(sw):
        t = x / max(1, sw - 1) * 5
        i = min(int(t), 4)
        f = t - i
        col = tuple(int(stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f) for k in range(3))
        d.line([(x, 0), (x, h // 4)], fill=col)
    return small.resize(CANVAS).filter(ImageFilter.GaussianBlur(56))


CHROME_BASE = wallpaper()


def chrome(step: int, total: int, name: str) -> Image.Image:
    """Wallpaper + rounded window + title strip + dots + title + step label."""
    im = CHROME_BASE.copy()
    mask = Image.new('L', (WIN_X1 - WIN_X0, WIN_Y1 - WIN_Y0), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, WIN_X1 - WIN_X0 - 1, WIN_Y1 - WIN_Y0 - 1),
                                           radius=22, fill=255)
    im.paste(Image.new('RGB', (WIN_X1 - WIN_X0, WIN_Y1 - WIN_Y0), BG), (WIN_X0, WIN_Y0), mask)
    strip = im.crop((WIN_X0, WIN_Y0, WIN_X1, TITLE_END)).point(lambda p: int(p * 0.55))
    im.paste(strip, (WIN_X0, WIN_Y0))
    d = ImageDraw.Draw(im)
    for i, col in enumerate([(251, 96, 91), (254, 188, 47), (39, 200, 64)]):
        cx = DOTS_X0 + i * (DOT_R * 2 + 12)
        d.ellipse((cx - DOT_R, DOTS_Y - DOT_R, cx + DOT_R, DOTS_Y + DOT_R), fill=col)
    d.text((DOTS_X0 + 130, DOTS_Y - 23), TITLE_LINE, font=font('bold', 30), fill=TITLE_COLOR)
    label = f'#{step:02d}-#{total:02d} · {name}' if name else f'#{step:02d}-#{total:02d}'
    d.text((WIN_X1 - 34 - d.textlength(label, font=font('bold', 26)), DOTS_Y - 21), label,
           font=font('bold', 26), fill=TITLE_COLOR)
    return im


def row_color(text: str, dim: bool):
    low = text.lower()
    if text.startswith('❯'):
        return PROMPT
    if 'thinking' in low:
        return THOUGHT
    if ': running' in low:
        return RUNNING
    if 'error' in low or 'failed' in low or 'refused' in low:
        return RED
    if 'verified' in low or '✓' in text or 'passed' in low:
        return GREEN
    if text.lstrip()[:1] in ('*', '+', '!', '-'):
        return CORAL
    if dim or text.lstrip().startswith('#'):
        return DIM
    return GRAY


def draw_cells(im: Image.Image, beat: dict) -> None:
    d = ImageDraw.Draw(im)
    d.rectangle((BAND_X0, BAND_Y0, BAND_X0 + BAND_W, BAND_Y0 + BAND_H), fill=BG)
    rows = beat['cells'][-ROWS:]
    y = BAND_Y0
    for row in rows:
        text = ''.join((c.get('ch') or ' ') for c in row).rstrip()
        col = row_color(text, any(c.get('dim') for c in row))
        x = BAND_X0
        for c in row:
            ch = c.get('ch') or ' '
            if ch not in (' ', '\n', ''):
                d.text((x, y), ch, font=font('regular'), fill=col)
            x += CELL_W
        y += CELL_H


def main() -> None:
    plan = json.loads((WORK / 'plan.json').read_text())
    beats = {b['index']: b for b in plan['beats']}
    phases = plan['phases']
    total = len(plan['beats'])

    rgb: dict[int, Image.Image] = {}
    quant: dict[int, Image.Image] = {}
    for bidx in sorted(beats):
        b = beats[bidx]
        name = next((ph['name'] for ph in phases if ph['firstBeat'] <= bidx <= ph['lastBeat']), '')
        im = chrome(bidx + 1, total, name)
        cells = json.loads((WORK / b['file']).read_text())
        draw_cells(im, cells)
        # The static block cursor at the composer echo's end.
        rows = cells['cells'][-ROWS:]
        texts = [''.join((c.get('ch') or ' ') for c in row) for row in rows]
        hits = [(i, t.rstrip()) for i, t in enumerate(texts) if t.startswith('❯')]
        if b.get('caret') and hits:
            ridx, text = hits[0]
            col = 3 if len(text) < 4 else len(text) + 1
            d = ImageDraw.Draw(im)
            cy = BAND_Y0 + ridx * CELL_H + 3
            d.rectangle((BAND_X0 + col * CELL_W, cy, BAND_X0 + col * CELL_W + 19,
                         cy + CELL_H - 6), fill=CURSOR)
        # The transient keystroke pill, in the last 1-2 frames it is held for.
        if b.get('pill'):
            d = ImageDraw.Draw(im)
            d.rounded_rectangle((601, 740, 951, 900), radius=48, fill=PILL_BG)
            glyph = '->|' if b['pill'] == 'enter' else '<-'
            d.text((700, 790), glyph, font=font('bold', 64), fill=(255, 255, 255))
        rgb[bidx] = im

    frames = plan['frames']
    durations = [f['delay'] for f in frames]
    first_beat = frames[0]['beat']
    master = rgb[first_beat].quantize(256, dither=Image.Dither.NONE)
    for bidx in sorted(rgb):
        quant[bidx] = rgb[bidx].quantize(palette=master, dither=Image.Dither.NONE)

    def emit(i: int, f: dict) -> Image.Image:
        """One emitted frame of the GIF. When a beat's screen repeats across
        consecutive 100ms frames, the wallpaper corner's sampled pixel shifts by
        one step of its own hue-family, so Pillow does not merge identical
        consecutive frames and the measured cadence survives. The repeated
        screen is otherwise the same beat's picture."""
        b = f['beat']
        pq = quant[b]
        if i and frames[i - 1]['beat'] == b:
            pq = pq.copy()
            palette = pq.getpalette()[:]
            slot = 200 + (i % 30)
            palette[slot*3]     = 6 + (i % 4)
            palette[slot*3 + 1] = 43
            palette[slot*3 + 2] = 54 + (i % 6)
            pq.putpalette(palette)
            pq.putpixel((2, 2), slot)
        pq.info['duration'] = f['delay']
        return pq

    OUT.parent.mkdir(parents=True, exist_ok=True)
    first = next(emitted := (emit(i, f) for i, f in enumerate(frames)))
    first.save(OUT, save_all=True, append_images=emitted, duration=durations,
               disposal=1, loop=None)
    raw = OUT.read_bytes()
    if b'NETSCAPE' in raw:
        i = raw.index(b'NETSCAPE')
        raw = raw[:i - 13] + raw[i - 13 + 19:]
        OUT.write_bytes(raw)
    print('frames:', len(frames), 'size:', OUT.stat().st_size)


if __name__ == '__main__':
    main()
