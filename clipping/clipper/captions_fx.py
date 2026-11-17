"""Signature caption styles, drawn frame by frame with Pillow.

These go beyond what libass can do (shapes that hug the text, gliding
underlines, per-word reveal), so each channel has a look of its own instead of
the usual bold-yellow-word captions.

  yap        lowercase chunky type inside a yellow speech bubble with a thick
             black outline and a lightning-bolt tail pointing up at the
             speaker. Words fill in from faded to solid as they're spoken; key
             words flip into black pills. Each bubble pops in with a slight tilt.
  framebite  cinematic serif subtitles in cream with a soft shadow. A teal
             underline glides from word to word as they're spoken; upcoming
             words are dimmed; key words are teal. Lines rise in gently.
"""

from __future__ import annotations

import math
import random
import re
from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .captions import FONTS_DIR, emphasis_keys, mask_word
from .transcript import Word

FX_STYLES = {"yap", "framebite"}


def _rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _key(t: str) -> str:
    return re.sub(r"[^\w']", "", t.lower())


@dataclass
class FxSpec:
    font: str
    size: int
    max_words: int
    max_chars: int
    max_width: int
    lowercase: bool
    y: float


SPECS = {
    "yap": FxSpec("LilitaOne-Regular.ttf", 84, 5, 22, 820, True, 0.71),
    "framebite": FxSpec("DMSerifDisplay-Regular.ttf", 92, 6, 28, 940, False, 0.72),
}

YAP_YELLOW, YAP_BLACK = _rgb("#F9FC09"), (17, 17, 17)
FB_CREAM, FB_TEAL = _rgb("#FAF2E8"), _rgb("#1FB5AF")


@lru_cache(maxsize=8)
def _font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS_DIR / name), size)


def _ease_out(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def _chunks(words: list[Word], spec: FxSpec) -> list[list[int]]:
    out, cur = [], []
    for i, w in enumerate(words):
        if cur:
            chars = sum(len(words[j].text) + 1 for j in cur) + len(w.text)
            prev = words[cur[-1]]
            if (len(cur) >= spec.max_words or chars > spec.max_chars or w.start - prev.end > 0.5
                    or prev.text[-1:] in ".?!" or (prev.text[-1:] in ",;:" and len(cur) >= 3)):
                out.append(cur)
                cur = []
        cur.append(i)
    if cur:
        out.append(cur)
    return out


@dataclass
class _Layout:
    idx: list[int]                 # word indices
    texts: list[str]
    boxes: list[tuple[int, int, int, int]]  # x0, y0, x1, y1 within the text block
    w: int
    h: int
    start: float
    end: float


class FxCaptions:
    def __init__(self, style: str, words: list[Word], emphasis: list[str] | None = None,
                 mask_profanity: bool = False, y: float | None = None, duration: float = 0.0):
        self.style = style
        self.spec = SPECS[style]
        self.words = words
        self.emph = emphasis_keys(emphasis or [])
        self.font = _font(self.spec.font, self.spec.size)
        self.y = y if y is not None else self.spec.y
        rng = random.Random(len(words))
        self.layouts: list[_Layout] = []
        chunks = _chunks(words, self.spec)
        for ci, ch in enumerate(chunks):
            texts = []
            for i in ch:
                t = mask_word(words[i].text) if mask_profanity else words[i].text
                texts.append(t.lower() if self.spec.lowercase else t)
            nxt = words[chunks[ci + 1][0]].start if ci + 1 < len(chunks) else None
            end = words[ch[-1]].end + 0.3
            if nxt is not None:
                end = nxt if nxt - words[ch[-1]].end < 0.6 else min(end, nxt)
            if duration:
                end = min(end, duration)
            self.layouts.append(self._layout(ch, texts, words[ch[0]].start, end))
        self.tilts = [rng.uniform(-2.5, 2.5) for _ in self.layouts]
        self._cache: dict = {}

    # -- layout ---------------------------------------------------------------
    def _layout(self, idx, texts, start, end) -> _Layout:
        f = self.font
        space = f.getlength(" ") * (1.6 if self.style == "yap" else 1.0)
        asc, desc = f.getmetrics()
        line_h = int((asc + desc) * (1.02 if self.style == "yap" else 1.08))
        widths = [f.getlength(t) for t in texts]
        total = sum(widths) + space * (len(widths) - 1)
        lines = [list(range(len(texts)))]
        if total > self.spec.max_width and len(texts) > 1:
            # two balanced lines: pick the split that minimises the longer line
            best = None
            for cut in range(1, len(texts)):
                a = sum(widths[:cut]) + space * (cut - 1)
                b = sum(widths[cut:]) + space * (len(texts) - cut - 1)
                score = max(a, b)
                if best is None or score < best[0]:
                    best = (score, cut)
            lines = [list(range(best[1])), list(range(best[1], len(texts)))]
        block_w = int(max(sum(widths[k] for k in ln) + space * (len(ln) - 1) for ln in lines))
        boxes = [None] * len(texts)
        for li, ln in enumerate(lines):
            lw = sum(widths[k] for k in ln) + space * (len(ln) - 1)
            x = (block_w - lw) / 2
            for k in ln:
                boxes[k] = (int(x), li * line_h, int(x + widths[k]), li * line_h + line_h)
                x += widths[k] + space
        return _Layout(idx, texts, boxes, block_w, line_h * len(lines), start, end)

    # -- drawing --------------------------------------------------------------
    def draw(self, frame: np.ndarray, t: float) -> None:
        for li, L in enumerate(self.layouts):
            if L.start <= t < L.end:
                img = self._yap(L, li, t) if self.style == "yap" else self._framebite(L, li, t)
                self._blit(frame, img, t - L.start, li)
                return

    def _blit(self, frame, img: Image.Image, age: float, li: int) -> None:
        arr = np.asarray(img).astype(np.float32)  # RGBA
        H, W = frame.shape[:2]
        if self.style == "yap":
            u = age / 0.16
            s = 0.82 + 0.24 * _ease_out(u / 0.6) if u < 0.6 else 1.06 - 0.06 * _ease_out((u - 0.6) / 0.4)
            ang = self.tilts[li] + (1 - _ease_out(u)) * 4 * (1 if li % 2 else -1)
            h, w = arr.shape[:2]
            M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, min(s, 1.06))
            pad = int(0.12 * max(w, h))
            M[:, 2] += pad
            arr = cv2.warpAffine(arr, M, (w + 2 * pad, h + 2 * pad), flags=cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
            dy = 0
        else:
            u = _ease_out(age / 0.18)
            arr[..., 3] *= u
            dy = int(18 * (1 - u))
        h, w = arr.shape[:2]
        x0 = (W - w) // 2
        y0 = int(H * self.y - h / 2) + dy
        sx0, sy0 = max(0, -x0), max(0, -y0)
        ex, ey = min(w, W - x0), min(h, H - y0)
        if ex <= sx0 or ey <= sy0:
            return
        a = arr[sy0:ey, sx0:ex, 3:4] / 255.0
        rgb = arr[sy0:ey, sx0:ex, 2::-1]  # RGB -> BGR
        roi = frame[y0 + sy0:y0 + ey, x0 + sx0:x0 + ex].astype(np.float32)
        frame[y0 + sy0:y0 + ey, x0 + sx0:x0 + ex] = (rgb * a + roi * (1 - a)).astype(np.uint8)

    def _active(self, L: _Layout, t: float) -> int:
        k = -1
        for j, i in enumerate(L.idx):
            if self.words[i].start <= t:
                k = j
        return k

    # Yap: speech bubble -----------------------------------------------------
    def _yap(self, L: _Layout, li: int, t: float) -> Image.Image:
        k = self._active(L, t)
        key = ("yap", li, k)
        if key in self._cache:
            return self._cache[key]
        padx, pady, border, tail = 44, 30, 9, 78
        bw, bh = L.w + 2 * padx, L.h + 2 * pady
        img = Image.new("RGBA", (bw + 2 * border, bh + 2 * border + tail), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        top = tail
        # lightning-bolt tail on the top edge, pointing up at the speaker
        tx = border + int(bw * (0.3 if li % 2 == 0 else 0.62))
        # zig-zag bolt: wide at the bubble, kinked, sharp tip at the top
        bolt = [(tx - 40, top + border + 8), (tx - 2, top - 34), (tx - 14, top - 30),
                (tx + 18, top - tail), (tx + 20, top - 24), (tx + 34, top - 28), (tx + 16, top + border + 8)]
        d.polygon(bolt, fill=YAP_BLACK + (255,))
        d.rounded_rectangle((0, top, bw + 2 * border - 1, top + bh + 2 * border - 1), radius=40,
                            fill=YAP_BLACK + (255,))
        d.rounded_rectangle((border, top + border, border + bw - 1, top + border + bh - 1), radius=32,
                            fill=YAP_YELLOW + (255,))
        inner = [(tx - 24, top + border + 2), (tx + 3, top - 18), (tx - 6, top - 15),
                 (tx + 15, top - tail + 18), (tx + 13, top - 13), (tx + 20, top - 15), (tx + 6, top + border + 2)]
        d.polygon(inner, fill=YAP_YELLOW + (255,))
        ox, oy = border + padx, top + border + pady - 2
        # one pill per run of adjacent spoken key words on the same line ("def con 2")
        em_on = [(_key(t) in self.emph) and j <= k for j, t in enumerate(L.texts)]
        j = 0
        while j < len(L.texts):
            if em_on[j]:
                e = j
                while e + 1 < len(L.texts) and em_on[e + 1] and L.boxes[e + 1][1] == L.boxes[j][1]:
                    e += 1
                x0, y0 = L.boxes[j][0], L.boxes[j][1]
                x1, y1 = L.boxes[e][2], L.boxes[e][3]
                d.rounded_rectangle((ox + x0 - 10, oy + y0 + 8, ox + x1 + 10, oy + y1 - 2), radius=18,
                                    fill=YAP_BLACK + (255,))
                j = e + 1
            else:
                j += 1
        for j, (text, (x0, y0, x1, y1)) in enumerate(zip(L.texts, L.boxes)):
            spoken = j <= k
            if em_on[j]:
                d.text((ox + x0, oy + y0), text, font=self.font, fill=YAP_YELLOW + (255,))
            else:
                col = YAP_BLACK + ((255,) if spoken else (80,))
                d.text((ox + x0, oy + y0), text, font=self.font, fill=col)
        self._cache[key] = img
        return img

    # Framebite: serif with gliding underline -----------------------------------
    def _framebite(self, L: _Layout, li: int, t: float) -> Image.Image:
        k = self._active(L, t)
        pad = 30
        W, H = L.w + 2 * pad, L.h + 2 * pad + 10
        key = ("fb", li, k)
        if key not in self._cache:
            text_img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            dt, ds = ImageDraw.Draw(text_img), ImageDraw.Draw(shadow)
            for j, (text, (x0, y0, x1, y1)) in enumerate(zip(L.texts, L.boxes)):
                em = _key(text) in self.emph and j <= k
                col = FB_TEAL if em else FB_CREAM
                alpha = 255 if j <= k else 205
                dt.text((pad + x0, pad + y0), text, font=self.font, fill=col + (alpha,))
                ds.text((pad + x0, pad + y0 + 3), text, font=self.font, fill=(0, 0, 0, 255),
                        stroke_width=3, stroke_fill=(0, 0, 0, 255))
            soft = shadow.filter(ImageFilter.GaussianBlur(9))
            tight = shadow.filter(ImageFilter.GaussianBlur(2.5))
            tight.putalpha(tight.getchannel("A").point(lambda v: int(v * 0.55)))
            self._cache[key] = Image.alpha_composite(Image.alpha_composite(soft, tight), text_img)
        img = self._cache[key].copy()
        if k >= 0:
            # underline glides from the previous word to the current one
            cur = L.boxes[k]
            prev = L.boxes[k - 1] if k > 0 else cur
            u = _ease_out((t - self.words[L.idx[k]].start) / 0.09)
            if prev[1] != cur[1]:
                prev = cur  # new line: no slide across lines
            x0 = prev[0] + (cur[0] - prev[0]) * u
            x1 = prev[2] + (cur[2] - prev[2]) * u
            ybar = cur[3] - int(self.spec.size * 0.12)
            d = ImageDraw.Draw(img)
            d.rounded_rectangle((pad + x0 - 2, pad + ybar, pad + x1 + 2, pad + ybar + 9), radius=5,
                                fill=FB_TEAL + (255,))
        return img
