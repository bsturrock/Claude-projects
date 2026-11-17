"""Speaker-aware 9:16 reframing.

Per clip: track faces at 25 fps, split into shots, score who is speaking
(see speaker.py), then pick a layout per shot:

  track  - keep the active speaker framed. One person: a locked or gently
           eased crop. Several people too far apart for one crop: hard-cut to
           whoever is talking (with hysteresis so crosstalk doesn't strobe).
           Several people close together: one static crop holding the group.
  stack  - (opt-in for two-person shots) split screen, one face per half
  fit    - no usable face (slides, screen shares, b-roll): full frame over a
           blurred, darkened fill of itself
  center - plain center crop
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .speaker import ASD_FPS, Track, analyze_speakers

OUT_W, OUT_H = 1080, 1920

# crosstalk: both people speaking this long -> temporary split screen
CROSSTALK_MIN = 38    # frames (~1.5 s)

# speaker switching
SWITCH_CONFIRM = 12   # frames (~0.5 s) a new speaker must lead before we cut
MIN_HOLD = 30         # frames (~1.2 s) minimum time on one speaker
SWITCH_MARGIN = 0.5   # score margin over the current speaker


@dataclass
class Shot:
    start: float  # seconds, relative to clip start
    end: float
    layout: str = "track"
    f0: int = 0                                  # first 25 fps frame of the shot
    xs: np.ndarray = field(default_factory=lambda: np.zeros(0))  # crop centre per frame
    focus: np.ndarray = field(default_factory=lambda: np.zeros(0, int))  # track idx per frame
    both: np.ndarray = field(default_factory=lambda: np.zeros(0, bool))  # crosstalk split-screen frames
    stack_centers: tuple = ()
    stack_crop_h: float = 0.0


@dataclass
class Plan:
    src_w: int
    src_h: int
    shots: list[Shot]
    content: tuple = ()  # (x0, y0, x1, y1) live picture inside static graphics, source px

    def shot_at(self, t: float) -> Shot:
        for s in self.shots:
            if t < s.end:
                return s
        return self.shots[-1]

    @property
    def dominant_layout(self) -> str:
        dur: dict[str, float] = {}
        for s in self.shots:
            dur[s.layout] = dur.get(s.layout, 0) + (s.end - s.start)
        return max(dur, key=dur.get) if dur else "track"

    def describe(self) -> str:
        parts = []
        for s in self.shots:
            extra = ""
            if s.layout == "track" and len(s.focus):
                subj = len(np.unique(s.focus))
                cuts = int(np.sum(np.diff(s.focus) != 0))
                extra = f" ({subj} subject{'s' if subj > 1 else ''}, {cuts} speaker cuts)" if subj > 1 else ""
            if len(s.both) and s.both.any():
                extra += f" [split screen {s.both.mean() * (s.end - s.start):.1f}s crosstalk]"
            parts.append(f"{s.layout}@{s.start:.1f}s{extra}")
        out = ", ".join(parts)
        if self.content and tuple(self.content) != (0, 0, self.src_w, self.src_h):
            x0, y0, x1, y1 = self.content
            out += f"; cropped static borders to {x1 - x0}x{y1 - y0}"
        return out


def _smooth(x: np.ndarray, k: int) -> np.ndarray:
    if len(x) < 3 or k < 2:
        return x
    k = min(k, len(x))
    p = k // 2
    xp = np.pad(x, p, mode="edge")
    med = np.median(np.lib.stride_tricks.sliding_window_view(xp, k)[: len(x)], axis=1)
    mp = np.pad(med, p, mode="edge")
    return np.convolve(mp, np.ones(k) / k, mode="valid")[: len(x)]


def choose_focus(tracks: list[Track], a: int, b: int) -> tuple[np.ndarray, np.ndarray]:
    """Index into `tracks` of the subject to show for each frame in [a, b),
    plus the smoothed per-track speaking scores (n_tracks, b - a)."""
    T = b - a
    n = len(tracks)
    S = np.full((n, T), -np.inf)
    for i, t in enumerate(tracks):
        lo, hi = max(a, t.first), min(b, t.last + 1)
        if hi <= lo:
            continue
        sc = t.scores[lo - t.first:hi - t.first] if len(t.scores) else np.zeros(hi - lo)
        S[i, lo - a:hi - a] = sc
    present = np.isfinite(S)
    filled = np.where(present, S, -5.0)
    k = 9
    sm = np.stack([np.convolve(np.pad(r, k // 2, mode="edge"), np.ones(k) / k, "valid")[:T]
                   for r in filled])
    sm = np.where(present, sm, -np.inf)

    has_scores = any(len(t.scores) for t in tracks)
    heights = np.array([t.height for t in tracks])
    head = sm[:, : min(T, ASD_FPS)]
    if has_scores and np.isfinite(head).any():
        cur = int(np.argmax(np.where(np.isfinite(head), head, -9).mean(axis=1)))
    else:
        cur = int(np.argmax(heights * present[:, 0]))
    focus = np.zeros(T, int)
    last_switch, lead_start, challenger = 0, None, None
    for f in range(T):
        if not present[cur, f]:
            avail = np.where(present[:, f])[0]
            if len(avail):
                cur = int(avail[np.argmax(sm[avail, f] if has_scores else heights[avail])])
                last_switch = f
            lead_start = challenger = None
        elif has_scores:
            best = int(np.argmax(sm[:, f]))
            if best != cur and sm[best, f] > 0 and sm[best, f] > sm[cur, f] + SWITCH_MARGIN:
                if challenger != best:
                    challenger, lead_start = best, f
                if f - lead_start + 1 >= SWITCH_CONFIRM and f - last_switch >= MIN_HOLD:
                    # back-date the cut to when they started leading
                    at = max(lead_start, last_switch + MIN_HOLD)
                    focus[at:f] = best
                    cur, last_switch = best, at
                    challenger = lead_start = None
            else:
                challenger = lead_start = None
        focus[f] = cur
    return focus, sm


def _path_for(tracks: list[Track], focus: np.ndarray, a: int, sw: int, half: float) -> np.ndarray:
    xs = np.zeros(len(focus))
    last = sw / 2
    for f, ti in enumerate(focus):
        t = tracks[ti]
        if t.covers(a + f):
            bx = t.box(a + f)
            last = (bx[0] + bx[2]) / 2
        xs[f] = last
    # smooth within each run of the same subject; hard cuts between runs
    out = xs.copy()
    edges = np.flatnonzero(np.diff(focus)) + 1
    for lo, hi in zip(np.r_[0, edges], np.r_[edges, len(focus)]):
        seg = xs[lo:hi]
        if len(seg) < 8 or np.std(seg) < sw * 0.035:
            out[lo:hi] = np.median(seg)
        else:
            out[lo:hi] = _smooth(seg, k=int(ASD_FPS * 1.2))
    return np.clip(out, half, sw - half)


def analyze(src: str, start: float, end: float, size: tuple[int, int],
            fallback: str = "fit", two_shot: str = "cut", use_asd: bool = True,
            crosstalk: bool = True) -> Plan:
    sw, sh = size
    dur = end - start
    if sw / sh <= 9 / 16 + 0.02:
        return Plan(sw, sh, [Shot(0, dur, "fit")])

    tracks, n, cuts, content = analyze_speakers(src, start, dur, size, use_asd=use_asd)
    if n == 0:
        return Plan(sw, sh, [Shot(0, dur, fallback)])
    cx0, cy0, cx1, cy1 = content
    ch = cy1 - cy0
    crop_w = min(ch * 9 / 16, cx1 - cx0)
    half = crop_w / 2
    bounds = cuts + [n]
    shots = []
    for a, b in zip(bounds, bounds[1:]):
        t0, t1 = a / ASD_FPS, (b / ASD_FPS if b < n else dur)
        shot = _plan_shot(tracks, a, b, t0, t1, sw, ch, crop_w, half, fallback, two_shot, crosstalk)
        if len(shot.xs):
            shot.xs = np.clip(shot.xs, cx0 + half, cx1 - half)
        shots.append(shot)
    return Plan(sw, sh, shots, content=content)


def _plan_shot(tracks, a, b, t0, t1, sw, sh, crop_w, half, fallback, two_shot,
               crosstalk=True) -> Shot:
    L = b - a
    st = [t for t in tracks if t.first < b and t.last >= a]
    covered = np.zeros(L, bool)
    for t in st:
        covered[max(a, t.first) - a:min(b, t.last + 1) - a] = True
    if not st or covered.mean() < 0.3:
        return Shot(t0, t1, fallback, f0=a)

    max_h = max(t.height for t in st)
    main = [t for t in st if len(t.frames) >= max(10, 0.2 * L) and t.height >= 0.45 * max_h]
    if not main:
        main = [max(st, key=lambda t: len(t.frames) * t.height)]

    if len(main) >= 2:
        centers = [float(np.median(t.cx)) for t in main]
        widths = [float(np.median(t.boxes[:, 2] - t.boxes[:, 0])) for t in main]
        span = (max(c + w / 2 for c, w in zip(centers, widths))
                - min(c - w / 2 for c, w in zip(centers, widths)))
        if span <= crop_w * 0.92:
            mid = (max(centers) + min(centers)) / 2
            xs = np.full(L, np.clip(mid, half, sw - half))
            return Shot(t0, t1, "track", f0=a, xs=xs, focus=np.zeros(L, int))
        if two_shot == "stack":
            two = sorted(sorted(main, key=lambda t: -len(t.frames) * t.height)[:2],
                         key=lambda t: float(np.median(t.cx)))
            pts = [(float(np.median(t.cx)), float(np.median((t.boxes[:, 1] + t.boxes[:, 3]) / 2)))
                   for t in two]
            face_h = float(np.mean([t.height for t in two]))
            crop_h = float(np.clip(face_h * 3.2, sh * 0.45, sh))
            return Shot(t0, t1, "stack", f0=a, stack_centers=tuple(pts), stack_crop_h=crop_h)

    focus, sm = choose_focus(main, a, b)
    xs = _path_for(main, focus, a, sw, half)
    shot = Shot(t0, t1, "track", f0=a, xs=xs, focus=focus)
    if len(main) >= 2 and crosstalk and any(len(t.scores) for t in main):
        _add_crosstalk(shot, main, sm, a, sh)
    return shot


def _runs(mask: np.ndarray):
    edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(int), 0]))
    return list(zip(edges[::2], edges[1::2]))


def _add_crosstalk(shot: Shot, main: list[Track], sm: np.ndarray, a: int, sh: int) -> None:
    """Mark stretches where the two most active speakers talk over each other."""
    act = np.where(np.isfinite(sm), sm, -9)
    top = np.argsort(-(act > 0).sum(axis=1))[:2]
    i, j = (int(top[0]), int(top[1]))
    raw = (act[i] > 0.3) & (act[j] > 0.3)
    # close small gaps, then keep only long runs
    both = np.zeros(len(raw), bool)
    for lo, hi in _runs(raw):
        both[lo:hi] = True
    for lo, hi in _runs(~both):
        if hi - lo < 12 and lo > 0 and hi < len(both):
            both[lo:hi] = True
    keep = np.zeros(len(raw), bool)
    for lo, hi in _runs(both):
        if hi - lo >= CROSSTALK_MIN:
            keep[lo:hi] = True
    if not keep.any():
        return
    ti, tj = sorted((main[i], main[j]), key=lambda t: float(np.median(t.cx)))
    pts = [(float(np.median(t.cx)), float(np.median((t.boxes[:, 1] + t.boxes[:, 3]) / 2))) for t in (ti, tj)]
    face_h = float(np.mean([t.height for t in (ti, tj)]))
    shot.both = keep
    shot.stack_centers = tuple(pts)
    shot.stack_crop_h = float(np.clip(face_h * 3.2, sh * 0.45, sh))


# ---------------------------------------------------------------------------
# Per-frame rendering
# ---------------------------------------------------------------------------

def _cover(img: np.ndarray, w: int, h: int) -> np.ndarray:
    ih, iw = img.shape[:2]
    s = max(w / iw, h / ih)
    r = cv2.resize(img, (int(np.ceil(iw * s)), int(np.ceil(ih * s))), interpolation=cv2.INTER_LINEAR)
    y0 = (r.shape[0] - h) // 2
    x0 = (r.shape[1] - w) // 2
    return r[y0:y0 + h, x0:x0 + w]


def _resize(img: np.ndarray, w: int, h: int) -> np.ndarray:
    interp = cv2.INTER_AREA if img.shape[1] > w else cv2.INTER_CUBIC
    return cv2.resize(img, (w, h), interpolation=interp)


def _crop_box(frame: np.ndarray, cx: float, cy: float, cw: float, ch: float) -> np.ndarray:
    fh, fw = frame.shape[:2]
    cw, ch = min(cw, fw), min(ch, fh)
    x0 = int(round(np.clip(cx - cw / 2, 0, fw - cw)))
    y0 = int(round(np.clip(cy - ch / 2, 0, fh - ch)))
    return frame[y0:y0 + int(ch), x0:x0 + int(cw)]


class Reframer:
    def __init__(self, plan: Plan):
        self.plan = plan

    def render(self, frame: np.ndarray, t: float) -> np.ndarray:
        shot = self.plan.shot_at(t)
        k = frame.shape[1] / self.plan.src_w  # frame may be decoded at a different size than the plan
        ox = oy = 0
        if self.plan.content:
            x0, y0, x1, y1 = (int(round(v * k)) for v in self.plan.content)
            frame = frame[y0:y1, x0:x1]
            ox, oy = x0, y0
        fh, fw = frame.shape[:2]
        if shot.layout == "fit":
            bg = _cover(frame, OUT_W // 8, OUT_H // 8)
            bg = cv2.GaussianBlur(bg, (0, 0), 6)
            bg = cv2.resize(bg, (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR)
            bg = (bg * 0.55).astype(np.uint8)
            fg_h = int(round(fh * OUT_W / fw / 2) * 2)
            if fg_h > OUT_H:
                return _cover(frame, OUT_W, OUT_H)
            fg = _resize(frame, OUT_W, fg_h)
            y0 = (OUT_H - fg_h) // 2 - OUT_H // 20
            bg[y0:y0 + fg_h] = fg
            return bg
        fi = int(t * ASD_FPS + 1e-6) - shot.f0
        crosstalk = len(shot.both) and shot.both[int(np.clip(fi, 0, len(shot.both) - 1))]
        if shot.layout == "stack" or crosstalk:
            ch = shot.stack_crop_h * k
            cw = ch * OUT_W / (OUT_H / 2)
            panels = []
            for cx, cy in shot.stack_centers:
                box = _crop_box(frame, cx * k - ox, (cy + shot.stack_crop_h * 0.12) * k - oy, cw, ch)
                panels.append(_resize(box, OUT_W, OUT_H // 2))
            out = np.vstack(panels)
            out[OUT_H // 2 - 2:OUT_H // 2 + 2] = 0
            return out
        if shot.layout == "track" and len(shot.xs):
            i = int(np.clip(fi, 0, len(shot.xs) - 1))
            cx = float(shot.xs[i]) * k - ox
        else:
            cx = fw / 2
        box = _crop_box(frame, cx, fh / 2, fh * 9 / 16, fh)
        return _resize(box, OUT_W, OUT_H)
