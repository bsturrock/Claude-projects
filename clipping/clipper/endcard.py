"""Channel brand kits and the animated end card (about 1.3 s, with a short sting).

Brand kits live in clipper/brands/<id>/ (logo.png + brand.json). Each card
slides the brand colour up over the last frame, then plays the brand's
animation:

  yap        the "yap" wordmark pops in, then the speech bubble drops from the
             top, lands on the text with a squash and bounces to rest
  framebite  the whole rounded rectangle pops in, then one big bite takes the
             corner out, with a jolt, a munch and crumbs flying
  (other)    the logo pops in with a small bounce

Sounds are synthesised here (whoosh, pops, a drop and thump, crunches), so
nothing needs licensing.
"""

from __future__ import annotations

import json
import wave
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

BRANDS_DIR = Path(__file__).parent / "brands"
CARD_SECONDS = 1.3
SR = 48000


@dataclass
class Brand:
    id: str
    name: str
    bg: str
    accent: str = "#111111"
    sting: str = "pop"
    anim: str = "pop"
    seconds: float = CARD_SECONDS
    description: str = ""
    defaults: dict = field(default_factory=dict)

    @property
    def logo_path(self) -> Path:
        return BRANDS_DIR / self.id / "logo.png"

    def bg_bgr(self) -> tuple[int, int, int]:
        h = self.bg.lstrip("#")
        return int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16)


def brands() -> dict[str, Brand]:
    out = {}
    if BRANDS_DIR.exists():
        for d in sorted(BRANDS_DIR.iterdir()):
            f = d / "brand.json"
            if f.exists() and (d / "logo.png").exists():
                data = json.loads(f.read_text())
                out[d.name] = Brand(id=d.name, **{k: v for k, v in data.items()
                                                  if k in Brand.__dataclass_fields__ and k != "id"})
    return out


def get_brand(bid: str) -> Brand | None:
    return brands().get(bid) if bid else None


def card_seconds(bid: str) -> float:
    b = get_brand(bid)
    return b.seconds if b else 0.0


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------

@dataclass
class Layer:
    rgb: np.ndarray    # float32 HxWx3
    alpha: np.ndarray  # float32 HxW, 0..1
    x: float           # top-left in output px (rest position)
    y: float

    @property
    def w(self) -> int:
        return self.rgb.shape[1]

    @property
    def h(self) -> int:
        return self.rgb.shape[0]


def _layer_from_mask(img: np.ndarray, alpha: np.ndarray, sel: np.ndarray, k: float, ox: float, oy: float,
                     bbox0: tuple[int, int]) -> Layer:
    ys, xs = np.where(sel > 0)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgb = img[y0:y1, x0:x1].astype(np.float32)
    a = (alpha * (sel > 0))[y0:y1, x0:x1].astype(np.float32)
    w, h = max(2, int((x1 - x0) * k)), max(2, int((y1 - y0) * k))
    return Layer(cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA),
                 cv2.resize(a, (w, h), interpolation=cv2.INTER_AREA),
                 ox + (x0 - bbox0[0]) * k, oy + (y0 - bbox0[1]) * k)


@lru_cache(maxsize=8)
def _layers(bid: str, W: int, H: int) -> dict[str, Layer]:
    """Split the brand logo into animatable layers, placed for a WxH frame."""
    b = get_brand(bid)
    img = cv2.imread(str(b.logo_path))
    bg = np.array(b.bg_bgr(), np.float32)
    dist = np.abs(img.astype(np.float32) - bg).sum(axis=2)
    alpha = np.clip((dist - 18) / 40, 0, 1)
    ys, xs = np.where(dist > 40)
    bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    k = W * 0.66 / (bx1 - bx0)
    ox = (W - (bx1 - bx0) * k) / 2
    oy = H * 0.46 - (by1 - by0) * k / 2
    whole = np.zeros(dist.shape, np.uint8)
    whole[by0:by1, bx0:bx1] = 1
    layers = {"logo": _layer_from_mask(img, alpha, whole, k, ox, oy, (bx0, by0))}

    solid = (dist > 120).astype(np.uint8)
    if b.anim == "yap_drop":
        n, lab, st, cen = cv2.connectedComponentsWithStats(solid, 8)
        comps = [i for i in range(1, n) if st[i, 4] > 2000]
        top = max(comps, key=lambda i: st[i, 4] if cen[i, 1] < (by0 + by1) / 2 else -1)
        bubble = cv2.dilate((lab == top).astype(np.uint8), np.ones((7, 7), np.uint8))
        text = np.zeros_like(solid)
        for i in comps:
            if i != top:
                text |= (lab == i).astype(np.uint8)
        text = cv2.dilate(text, np.ones((7, 7), np.uint8))
        layers["bubble"] = _layer_from_mask(img, alpha, bubble, k, ox, oy, (bx0, by0))
        layers["text"] = _layer_from_mask(img, alpha, text, k, ox, oy, (bx0, by0))
    elif b.anim == "framebite":
        acc = np.array([int(b.accent[5:7], 16), int(b.accent[3:5], 16), int(b.accent[1:3], 16)], np.float32)
        teal = (np.abs(img.astype(np.float32) - acc).sum(axis=2) < 90).astype(np.uint8)
        tys, txs = np.where(teal)
        rx0, ry0, rx1, ry1 = txs.min(), tys.min(), txs.max(), tys.max()
        r = int(0.185 * (rx1 - rx0))
        full = np.zeros_like(teal)
        cv2.rectangle(full, (rx0 + r, ry0), (rx1 - r, ry1), 1, -1)
        cv2.rectangle(full, (rx0, ry0 + r), (rx1, ry1 - r), 1, -1)
        for cx, cy in ((rx0 + r, ry0 + r), (rx1 - r, ry0 + r), (rx0 + r, ry1 - r), (rx1 - r, ry1 - r)):
            cv2.circle(full, (cx, cy), r, 1, -1, lineType=cv2.LINE_AA)
        yy, xx = np.mgrid[0:teal.shape[0], 0:teal.shape[1]]
        corner = (xx > rx0 + 0.6 * (rx1 - rx0)) & (yy < ry0 + 0.4 * (ry1 - ry0))
        bite = (full > 0) & (teal == 0) & corner
        bite = cv2.morphologyEx(bite.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        # unbitten rectangle = logo with the bite filled in
        filled = img.copy()
        filled[bite > 0] = acc.astype(np.uint8)
        fa = alpha.copy()
        fa[bite > 0] = 1.0
        rect_sel = np.zeros_like(teal)
        rect_sel[ry0:ry1 + 1, rx0:rx1 + 1] = 1
        layers["rect_full"] = _layer_from_mask(filled, fa, rect_sel, k, ox, oy, (bx0, by0))
        layers["rect"] = _layer_from_mask(img, alpha, rect_sel, k, ox, oy, (bx0, by0))
        text_sel = np.zeros_like(teal)
        text_sel[ry1 + 5:, :] = 1
        text_sel &= (dist > 40).astype(np.uint8)
        layers["text"] = _layer_from_mask(img, alpha, cv2.dilate(text_sel, np.ones((5, 5), np.uint8)),
                                          k, ox, oy, (bx0, by0))
        # the bite (one chunk), and where its crumbs fly from
        bys, bxs = np.where(bite > 0)
        m = np.zeros((ry1 - ry0 + 1, rx1 - rx0 + 1), np.float32)
        m[bys - ry0, bxs - rx0] = 1
        L = layers["rect_full"]
        m = cv2.resize(m, (L.w, L.h), interpolation=cv2.INTER_AREA)
        cxy = (ox + (bxs.mean() - bx0) * k, oy + (bys.mean() - by0) * k)
        layers["_chunks"] = [(m, cxy)]
        layers["_accent"] = acc
    return layers


def _paste(frame: np.ndarray, L: Layer, *, dx=0.0, dy=0.0, sx=1.0, sy=1.0, anchor=(0.5, 0.5),
           alpha=1.0, rgb: np.ndarray | None = None, a: np.ndarray | None = None) -> None:
    """Composite a layer with scale about an anchor (fractions of the layer box)."""
    if alpha <= 0.01 or sx <= 0.01 or sy <= 0.01:
        return
    rgb = L.rgb if rgb is None else rgb
    a = L.alpha if a is None else a
    w, h = max(2, int(L.w * sx)), max(2, int(L.h * sy))
    if (w, h) != (L.w, L.h):
        rgb = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_LINEAR)
        a = cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
    ax, ay = L.x + L.w * anchor[0], L.y + L.h * anchor[1]
    x0 = int(round(ax - w * anchor[0] + dx))
    y0 = int(round(ay - h * anchor[1] + dy))
    H, W = frame.shape[:2]
    sx0, sy0 = max(0, -x0), max(0, -y0)
    ex, ey = min(w, W - x0), min(h, H - y0)
    if ex <= sx0 or ey <= sy0:
        return
    aa = a[sy0:ey, sx0:ex, None] * alpha
    roi = frame[y0 + sy0:y0 + ey, x0 + sx0:x0 + ex].astype(np.float32)
    frame[y0 + sy0:y0 + ey, x0 + sx0:x0 + ex] = (rgb[sy0:ey, sx0:ex] * aa + roi * (1 - aa)).astype(np.uint8)


# ---------------------------------------------------------------------------
# Easing
# ---------------------------------------------------------------------------

def _c(x):
    return min(1.0, max(0.0, x))


def _out3(x):
    return 1 - (1 - _c(x)) ** 3


def _pop(t, t0, dur=0.26, lo=0.6, over=1.08):
    """Scale that grows lo -> over -> 1 starting at t0. 0 before t0."""
    if t < t0:
        return 0.0
    u = (t - t0) / dur
    if u < 0.65:
        return lo + (over - lo) * _out3(u / 0.65)
    return over - (over - 1) * _out3((u - 0.65) / 0.35)


def _base(last: np.ndarray, bgc, t: float) -> np.ndarray:
    """Last frame blurring out while the brand colour slides up over it."""
    H = last.shape[0]
    under = (cv2.GaussianBlur(last, (0, 0), 8) * 0.6).astype(np.uint8)
    k = _out3(t / 0.18)
    frame = cv2.addWeighted(last, 1 - k, under, k, 0)
    off = int(H * (1 - _out3(t / 0.22)))
    frame[off:] = bgc
    return frame


# ---------------------------------------------------------------------------
# Animations
# ---------------------------------------------------------------------------

def _anim_pop(L, frame, t):
    s = _pop(t, 0.14)
    _paste(frame, L["logo"], sx=s, sy=s, alpha=_c((t - 0.14) / 0.06))


def _anim_yap(L, frame, t):
    text, bubble = L["text"], L["bubble"]
    st = _pop(t, 0.12, dur=0.24)
    T_FALL, T_HIT = 0.36, 0.52
    # text squash on impact
    sy = sx = st
    if t >= T_HIT:
        u = t - T_HIT
        squash = 0.18 * np.exp(-u / 0.06) * np.cos(u * 40)
        sy, sx = 1 - squash, 1 + squash * 0.6
    _paste(frame, text, sx=sx, sy=sy, anchor=(0.5, 1.0), alpha=_c((t - 0.12) / 0.05))
    if t < T_FALL:
        return
    if t < T_HIT:  # accelerate down from above the frame
        u = (t - T_FALL) / (T_HIT - T_FALL)
        dy = -(bubble.y + bubble.h + 40) * (1 - u * u)
        _paste(frame, bubble, dy=dy, sx=0.92, sy=1.1, anchor=(0.5, 1.0))
        return
    u = t - T_HIT
    # two bounces: up 7% of height, then 2%
    h = bubble.h
    if u < 0.20:
        dy = -0.07 * h * np.sin(np.pi * u / 0.20)
    elif u < 0.30:
        dy = -0.02 * h * np.sin(np.pi * (u - 0.20) / 0.10)
    else:
        dy = 0.0
    squash = 0.16 * np.exp(-u / 0.05) * np.cos(u * 45)
    _paste(frame, bubble, dy=dy, sx=1 + squash * 0.7, sy=1 - squash, anchor=(0.5, 1.0))


BITES = (0.58,)


def _anim_framebite(L, frame, t, state):
    full, rect, text = L["rect_full"], L["rect"], L["text"]
    s = _pop(t, 0.12, dur=0.26)
    jolt_x = jolt_y = 0.0
    for tb in BITES:
        if t >= tb:
            u = t - tb
            jolt = 24 * np.exp(-u / 0.06)
            jolt_x -= jolt * 0.7
            jolt_y += jolt * 0.7
    a_logo = _c((t - 0.12) / 0.05)
    # rectangle with bites applied progressively
    rgb, a = full.rgb, full.alpha.copy()
    for tb, (m, _) in zip(BITES, L["_chunks"]):
        if t >= tb:
            a = a * (1 - m)
    squeeze = 1 - 0.05 * sum(np.exp(-(t - tb) / 0.07) for tb in BITES if t >= tb)
    _paste(frame, full, sx=s * squeeze, sy=s * squeeze, dx=jolt_x, dy=jolt_y, alpha=a_logo, rgb=rgb, a=a)
    # wordmark rises in under the rectangle
    tu = _c((t - 0.2) / 0.2)
    _paste(frame, text, dy=30 * (1 - _out3(tu)), alpha=tu)
    # crumbs
    rng = state.setdefault("rng", np.random.default_rng(3))
    crumbs = state.setdefault("crumbs", [])
    for i, (tb, (_, (cx, cy))) in enumerate(zip(BITES, L["_chunks"])):
        if t >= tb and not state.get(f"spawned{i}"):
            state[f"spawned{i}"] = True
            for _ in range(20):
                ang = rng.uniform(-np.pi * 0.5, 0.0)  # up and to the right, away from the logo
                spd = rng.uniform(450, 1000)
                crumbs.append({"t0": tb, "x": cx, "y": cy, "vx": np.cos(ang) * spd, "vy": np.sin(ang) * spd,
                               "r": rng.uniform(8, 18), "sq": rng.random() < 0.5, "rot": rng.uniform(0, 90),
                               "spin": rng.uniform(-600, 600)})
    acc, bgc = L["_accent"], state["bg"]
    life = 0.45
    for c in crumbs:
        u = t - c["t0"]
        if u < 0 or u > life:
            continue
        x = c["x"] + c["vx"] * u
        y = c["y"] + c["vy"] * u + 0.5 * 1600 * u * u
        r = c["r"] * (1 - 0.4 * u / life)
        f = _c((u - life * 0.5) / (life * 0.5))  # fade into the background colour
        col = tuple(int(v) for v in acc * (1 - f) + bgc * f)
        if c["sq"]:
            box = cv2.boxPoints(((x, y), (2 * r, 1.6 * r), c["rot"] + c["spin"] * u)).astype(np.int32)
            cv2.fillConvexPoly(frame, box, col, lineType=cv2.LINE_AA)
        else:
            cv2.circle(frame, (int(x), int(y)), int(r), col, -1, lineType=cv2.LINE_AA)


def card_frames(bid: str, last: np.ndarray, fps: float, seconds: float | None = None):
    """Yield BGR frames (same size as `last`) of the end card."""
    b = get_brand(bid)
    H, W = last.shape[:2]
    seconds = seconds or b.seconds
    L = _layers(bid, W, H)
    bgc = np.array(b.bg_bgr(), np.uint8)
    state: dict = {"bg": bgc.astype(np.float32)}
    for i in range(max(1, round(seconds * fps))):
        t = i / fps
        frame = _base(last, bgc, t)
        if b.anim == "yap_drop":
            _anim_yap(L, frame, t)
            if t >= 0.52:  # small camera shake on impact
                u = t - 0.52
                dy = int(12 * np.exp(-u / 0.05) * np.sin(u * 70))
                frame = np.roll(frame, dy, axis=0)
        elif b.anim == "framebite":
            _anim_framebite(L, frame, t, state)
        else:
            _anim_pop(L, frame, t)
        yield frame


# ---------------------------------------------------------------------------
# Sound
# ---------------------------------------------------------------------------

def _whoosh(dur: float, rng: np.random.Generator) -> np.ndarray:
    n = int(SR * dur)
    noise = rng.standard_normal(n)
    out = np.empty(n)
    y = 0.0
    for i in range(n):  # one-pole low-pass sweeping upwards
        a = 0.02 + 0.25 * (i / n) ** 1.5
        y += a * (noise[i] - y)
        out[i] = y
    return out * np.sin(np.linspace(0, np.pi, n)) ** 2


def _tone(f0: float, f1: float, dur: float, decay: float, harm: float = 0.25) -> np.ndarray:
    n = int(SR * dur)
    t = np.arange(n) / SR
    phase = 2 * np.pi * np.cumsum(np.geomspace(f0, f1, n)) / SR
    env = np.exp(-t / decay) * np.minimum(1, t / 0.004)
    return (np.sin(phase) + harm * np.sin(2 * phase)) * env


def _crunch(rng: np.random.Generator, dur: float = 0.06) -> np.ndarray:
    n = int(SR * dur)
    x = rng.standard_normal(n)
    # crackle: sparse impulses through a short resonant smear
    x *= (rng.random(n) < 0.25)
    x = np.convolve(x, np.exp(-np.arange(80) / 12), mode="same")
    return x * np.exp(-np.arange(n) / (SR * 0.018))


def _munch(rng: np.random.Generator, dur: float = 0.14) -> np.ndarray:
    """A bite: low jaw thump + a burst of dry crackles (crispy food) + a short chew tail."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    out = np.zeros(n)
    # body: lowpassed noise with a fast attack, like teeth closing
    body = rng.standard_normal(n)
    body = np.convolve(body, np.ones(60) / 60, mode="same")
    out += 2.2 * body * np.exp(-t / 0.035)
    # crackles: many tiny clicks spread over ~90 ms, getting sparser
    for _ in range(int(rng.integers(26, 36))):
        at = int(abs(rng.normal(0, 0.03)) * SR)
        ln = int(rng.integers(60, 220))
        if at + ln < n:
            click = rng.standard_normal(ln) * np.exp(-np.arange(ln) / (ln / 5))
            out[at:at + ln] += rng.uniform(0.3, 1.0) * click
    # thump
    out += 0.8 * _tone(170, 80, dur, 0.03, 0.4)[:n]
    return out


def sting(kind: str, seconds: float = CARD_SECONDS) -> np.ndarray:
    """Stereo float32, peak about -12 dBFS."""
    rng = np.random.default_rng(7)
    n = int(SR * seconds)
    mono = np.zeros(n)

    def add(sig, at, gain):
        i = int(at * SR)
        j = min(n, i + len(sig))
        if j > i:
            mono[i:j] += gain * sig[: j - i]

    add(_whoosh(0.28, rng), 0.0, 0.45)
    if kind == "yap":
        add(_tone(900, 420, 0.10, 0.03), 0.16, 0.7)          # text pops in
        add(_tone(1800, 600, 0.16, 0.2, 0.1), 0.36, 0.22)    # falling whistle
        add(_tone(150, 55, 0.25, 0.08, 0.5), 0.52, 1.0)      # thump on landing
        add(_crunch(rng, 0.03), 0.52, 0.5)
        add(_tone(700, 980, 0.08, 0.03), 0.70, 0.35)         # little bounce
    elif kind == "framebite":
        add(_tone(800, 520, 0.10, 0.035), 0.16, 0.45)        # rectangle pops in
        for tb in BITES:                                      # one big munch
            add(_munch(rng, 0.2), tb - 0.01, 1.0)
    elif kind == "chime":
        add(_tone(659.3, 659.3, 0.6, 0.18), 0.30, 0.45)
        add(_tone(987.8, 987.8, 0.7, 0.22), 0.44, 0.40)
    else:
        add(_tone(950, 420, 0.12, 0.035), 0.20, 0.9)
    fl = int(0.15 * SR)
    mono[-fl:] *= np.linspace(1, 0, fl)
    mono = mono / (np.max(np.abs(mono)) or 1) * 10 ** (-12 / 20)
    return np.stack([mono, mono], axis=1).astype(np.float32)


def write_sting(kind: str, path: Path, seconds: float = CARD_SECONDS) -> Path:
    data = (sting(kind, seconds) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    return path


# ---------------------------------------------------------------------------
# Cold-open transition: "rewind" wipe between the payoff and the start
# ---------------------------------------------------------------------------

TRANSITION_SECONDS = 0.6
TRANSITIONS = {"swipe": 0.45, "panel": 0.6, "none": 0.0}  # cold-open transition styles and lengths
_TRANS = {
    "yap": {"bg": (9, 252, 249), "fg": (17, 17, 17), "font": "LilitaOne-Regular.ttf", "text": "rewind", "size": 170},
    "framebite": {"bg": (155, 160, 6), "fg": (232, 242, 250), "font": "DMSerifDisplay-Regular.ttf", "text": "Earlier",
                  "size": 170},
}
_TRANS_DEFAULT = {"bg": (24, 24, 28), "fg": (255, 255, 255), "font": "Poppins-ExtraBold.ttf", "text": "rewind", "size": 150}


@lru_cache(maxsize=4)
def _trans_label(bid: str) -> np.ndarray:
    """BGRA image: rewind icon (two left-pointing triangles) + word."""
    from PIL import Image, ImageDraw, ImageFont

    from .captions import FONTS_DIR
    spec = _TRANS.get(bid, _TRANS_DEFAULT)
    font = ImageFont.truetype(str(FONTS_DIR / spec["font"]), spec["size"])
    word = spec["text"]
    tw = int(font.getlength(word))
    asc, desc = font.getmetrics()
    icon = int(spec["size"] * 0.8)
    w, h = int(icon * 0.62 * 2) + 44 + tw, asc + desc + 20
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fg = tuple(reversed(spec["fg"])) + (255,)  # stored BGR -> RGB
    cy = h // 2 + 4
    tri = icon * 0.62  # two triangles, the second's tip touching the first's base: the rewind symbol
    for k in range(2):
        x = k * tri
        d.polygon([(x, cy), (x + tri, cy - icon / 2), (x + tri, cy + icon / 2)], fill=fg)
    d.text((int(tri * 2) + 34, 4), word, font=font, fill=fg)
    arr = np.asarray(img).astype(np.float32)
    return arr[..., [2, 1, 0, 3]]  # RGBA -> BGRA


def swipe_frames(last: np.ndarray, nxt: np.ndarray, fps: float, seconds: float = TRANSITIONS["swipe"]):
    """Whip pan using the real frames: the payoff frame flies out to the left and the
    first frame of the setup follows it in from the right, motion-blurred at speed."""
    H, W = last.shape[:2]
    n = max(2, round(seconds * fps))
    strip = np.concatenate([last, nxt], axis=1)  # [payoff | setup], 2W wide
    prev_x = 0.0
    for i in range(n):
        u = i / (n - 1)
        e = u * u * (3 - 2 * u)  # smoothstep: accelerate, then settle
        x = e * W
        speed = abs(x - prev_x)
        prev_x = x
        k = int(min(121, 1 + speed * 0.6)) | 1  # blur length follows the pan speed
        view = strip[:, int(x):int(x) + W]
        if view.shape[1] < W:
            view = strip[:, -W:]
        yield cv2.blur(view, (k, 1)) if k > 1 else view.copy()


def transition_frames(bid: str, last: np.ndarray, nxt: np.ndarray, fps: float,
                      seconds: float = TRANSITION_SECONDS, style: str = "panel"):
    """Cold-open transition. style "swipe" pans between the real frames; "panel" sweeps a
    branded panel with a rewind label across, then reveals the next frame."""
    if style == "swipe":
        yield from swipe_frames(last, nxt, fps, seconds)
        return
    spec = _TRANS.get(bid, _TRANS_DEFAULT)
    H, W = last.shape[:2]
    label = _trans_label(bid)
    n = max(2, round(seconds * fps))
    panel = np.empty_like(last)
    panel[:] = spec["bg"]
    for i in range(n):
        u = i / (n - 1)
        if u < 0.45:  # panel enters from the right; video under it streaks backwards
            k = _out3(u / 0.45)
            under = last
            blur = int(1 + 60 * k) | 1
            under = cv2.blur(under, (blur, 1))
            under = np.roll(under, int(80 * k), axis=1)
            x = int(W * (1 - k))
            frame = under.copy()
            frame[:, x:] = panel[:, : W - x]
        else:  # panel exits to the left, next frame revealed behind it
            k = _out3((u - 0.55) / 0.45) if u > 0.55 else 0.0
            x = int(W * (1 - k))
            frame = nxt.copy()
            frame[:, :x] = panel[:, W - x:]
        # label rides on the panel, centred while the panel is full-screen
        if 0.25 < u < 0.85:
            lu = (u - 0.25) / 0.6
            s = 0.8 + 0.2 * _out3(lu / 0.4)
            lab = cv2.resize(label, (int(label.shape[1] * s), int(label.shape[0] * s)))
            lh, lw = lab.shape[:2]
            px = 0 if u < 0.45 else -int(W * (_out3((u - 0.55) / 0.45) if u > 0.55 else 0))
            if u < 0.45:
                px = int(W * (1 - _out3(u / 0.45)))
            x0, y0 = (W - lw) // 2 + px, int(H * 0.45 - lh / 2)
            sx0, ex = max(0, -x0), min(lw, W - x0)
            if ex > sx0:
                a = lab[:, sx0:ex, 3:4] / 255.0
                roi = frame[y0:y0 + lh, x0 + sx0:x0 + ex].astype(np.float32)
                frame[y0:y0 + lh, x0 + sx0:x0 + ex] = (lab[:, sx0:ex, :3] * a + roi * (1 - a)).astype(np.uint8)
        yield frame


def write_transition_sound(path: Path, seconds: float = TRANSITION_SECONDS) -> Path:
    """Tape-rewind zip: a fast warbling down-sweep with a little noise, then a click."""
    rng = np.random.default_rng(11)
    n = int(SR * seconds)
    t = np.arange(n) / SR
    sweep_n = int(SR * 0.38)
    ts = t[:sweep_n]
    f = 2200 * np.exp(-ts * 5.5) + 260
    phase = 2 * np.pi * np.cumsum(f * (1 + 0.25 * np.sin(2 * np.pi * 38 * ts))) / SR
    zip_ = np.sin(phase) * 0.6 + 0.25 * rng.standard_normal(sweep_n)
    zip_ *= np.sin(np.linspace(0, np.pi, sweep_n)) ** 0.7
    mono = np.zeros(n)
    mono[:sweep_n] += zip_
    click = _tone(1400, 900, 0.04, 0.008)
    i = int(0.4 * SR)
    mono[i:i + len(click)] += 0.8 * click[: n - i]
    mono = mono / (np.max(np.abs(mono)) or 1) * 10 ** (-14 / 20)
    data = (np.stack([mono, mono], axis=1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    return path
