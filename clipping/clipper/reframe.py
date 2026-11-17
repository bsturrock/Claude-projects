"""Speaker-aware 9:16 reframing.

For each clip we sample frames, detect faces and shot changes, and choose a
layout per shot:

  track  - follow the main face with a smoothed 9:16 crop (static when the
           subject barely moves, so it never looks like a jittery robot camera)
  stack  - two people far apart (two-shot podcast): split screen, one face per half
  fit    - no usable face (slides, screen recordings, b-roll): full frame over a
           blurred, darkened fill of itself
  center - plain center crop (optional fallback instead of fit)
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

OUT_W, OUT_H = 1080, 1920
ANALYSIS_FPS = 5
ANALYSIS_W = 640


@dataclass
class Shot:
    start: float  # seconds, relative to clip start
    end: float
    layout: str = "track"
    times: np.ndarray = field(default_factory=lambda: np.zeros(0))
    centers: np.ndarray = field(default_factory=lambda: np.zeros(0))  # crop center x, source px
    stack_centers: tuple = ()  # ((x, y), (x, y)) in source px
    stack_crop_h: float = 0.0


@dataclass
class Plan:
    src_w: int
    src_h: int
    shots: list[Shot]

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


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

MODEL_PATH = Path(__file__).parent / "models" / "face_detection_yunet_2023mar.onnx"


class FaceDetector:
    """YuNet (OpenCV DNN) face detector, with a Haar-cascade fallback."""

    def __init__(self):
        self.yunet = None
        if MODEL_PATH.exists() and hasattr(cv2, "FaceDetectorYN"):
            self.yunet = cv2.FaceDetectorYN.create(str(MODEL_PATH), "", (320, 320), 0.7, 0.3, 50)
            self._size = None
        else:
            base = cv2.data.haarcascades
            self.front = cv2.CascadeClassifier(base + "haarcascade_frontalface_default.xml")
            if self.front.empty():
                raise RuntimeError("No face detector available (YuNet model or Haar cascades)")

    def __call__(self, frame: np.ndarray) -> list[tuple[float, float, float, float]]:
        """Return faces as (cx, cy, w, h) in frame pixels."""
        h, w = frame.shape[:2]
        if self.yunet is not None:
            if self._size != (w, h):
                self.yunet.setInputSize((w, h))
                self._size = (w, h)
            _, faces = self.yunet.detect(frame)
            if faces is None:
                return []
            return [(float(x + fw / 2), float(y + fh / 2), float(fw), float(fh))
                    for x, y, fw, fh in faces[:, :4]]
        gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        side = max(24, h // 14)
        return [(x + fw / 2, y + fh / 2, fw, fh)
                for x, y, fw, fh in self.front.detectMultiScale(gray, 1.1, 5, minSize=(side, side))]


def _iter_frames(src: str, start: float, dur: float, fps: float, width: int | None,
                 size: tuple[int, int]):
    """Yield BGR frames from ffmpeg at a fixed fps (display orientation)."""
    sw, sh = size
    if width:
        ow = width
        oh = int(round(sh * width / sw / 2) * 2)
        vf = f"fps={fps},scale={ow}:{oh}"
    else:
        ow, oh = sw, sh
        vf = f"fps={fps}"
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", src, "-t", f"{dur:.3f}",
           "-vf", vf, "-an", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    nbytes = ow * oh * 3
    try:
        while True:
            buf = proc.stdout.read(nbytes)
            if len(buf) < nbytes:
                break
            yield np.frombuffer(buf, np.uint8).reshape(oh, ow, 3)
    finally:
        proc.stdout.close()
        proc.wait()


def _smooth(x: np.ndarray, k: int) -> np.ndarray:
    if len(x) < 3 or k < 2:
        return x
    # median (kills outliers) then moving average (eases motion)
    pad = k // 2
    xp = np.pad(x, pad, mode="edge")
    med = np.array([np.median(xp[i:i + k]) for i in range(len(x))])
    mp = np.pad(med, pad, mode="edge")
    return np.convolve(mp, np.ones(k) / k, mode="valid")[: len(x)]


def analyze(src: str, start: float, end: float, size: tuple[int, int],
            fallback: str = "fit", allow_stack: bool = True) -> Plan:
    sw, sh = size
    crop_w = sh * 9 / 16

    if sw / sh <= 9 / 16 + 0.02:
        # Already vertical: just fit.
        return Plan(sw, sh, [Shot(0, end - start, "fit")])

    detect = FaceDetector()
    scale = sw / ANALYSIS_W
    samples = []  # (t, faces_in_source_px, hist)
    for i, frame in enumerate(_iter_frames(src, start, end - start, ANALYSIS_FPS, ANALYSIS_W, size)):
        faces = [(cx * scale, cy * scale, fw * scale, fh * scale)
                 for cx, cy, fw, fh in detect(frame)]
        hsv = cv2.cvtColor(cv2.resize(frame, (160, 90)), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        samples.append((i / ANALYSIS_FPS, faces, hist))

    if not samples:
        return Plan(sw, sh, [Shot(0, end - start, fallback)])

    # Shot boundaries from histogram correlation drops.
    bounds = [0]
    for i in range(1, len(samples)):
        corr = cv2.compareHist(samples[i - 1][2], samples[i][2], cv2.HISTCMP_CORREL)
        if corr < 0.55 and i - bounds[-1] >= 2:
            bounds.append(i)
    bounds.append(len(samples))

    shots = []
    clip_dur = end - start
    for a, b in zip(bounds, bounds[1:]):
        seg = samples[a:b]
        t0 = seg[0][0]
        t1 = samples[b][0] if b < len(samples) else clip_dur
        shots.append(_plan_shot(seg, t0, t1, sw, sh, crop_w, fallback, allow_stack))
    return Plan(sw, sh, shots)


def _plan_shot(seg, t0, t1, sw, sh, crop_w, fallback, allow_stack) -> Shot:
    with_faces = [s for s in seg if s[1]]
    if len(with_faces) < max(1, 0.3 * len(seg)):
        return Shot(t0, t1, fallback)

    # Two-speaker split screen?
    if allow_stack:
        pairs = []
        for _, faces, _ in with_faces:
            big = sorted(faces, key=lambda f: -f[3])[:2]
            if len(big) == 2 and big[1][3] >= 0.55 * big[0][3] and abs(big[0][0] - big[1][0]) > crop_w * 0.9:
                left, right = sorted(big, key=lambda f: f[0])
                pairs.append((left, right))
        if len(pairs) >= 0.6 * len(seg):
            L = np.median([[p[0][0], p[0][1], p[0][3]] for p in pairs], axis=0)
            R = np.median([[p[1][0], p[1][1], p[1][3]] for p in pairs], axis=0)
            face_h = (L[2] + R[2]) / 2
            crop_h = float(np.clip(face_h * 3.2, sh * 0.45, sh))
            return Shot(t0, t1, "stack", stack_centers=((L[0], L[1]), (R[0], R[1])),
                        stack_crop_h=crop_h)

    # Track the main face, with continuity.
    times, xs = [], []
    prev = None
    for t, faces, _ in seg:
        if not faces:
            continue
        faces = sorted(faces, key=lambda f: -f[3])
        cands = [f for f in faces if f[3] >= 0.8 * faces[0][3]]
        pick = min(cands, key=lambda f: abs(f[0] - prev)) if prev is not None else cands[0]
        prev = pick[0]
        times.append(t)
        xs.append(pick[0])
    times = np.array(times)
    xs = np.array(xs, dtype=float)
    half = crop_w / 2
    if np.std(xs) < sw * 0.04 or len(xs) < 4:
        xs = np.full_like(xs, np.median(xs))
    else:
        xs = _smooth(xs, k=max(3, int(ANALYSIS_FPS * 1.2)))
    xs = np.clip(xs, half, sw - half)
    return Shot(t0, t1, "track", times=times, centers=xs)


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
        self.crop_w = plan.src_h * 9 / 16

    def render(self, frame: np.ndarray, t: float) -> np.ndarray:
        shot = self.plan.shot_at(t)
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
        if shot.layout == "stack":
            ch = shot.stack_crop_h
            cw = ch * OUT_W / (OUT_H / 2)
            panels = []
            for cx, cy in shot.stack_centers:
                box = _crop_box(frame, cx, cy + ch * 0.12, cw, ch)
                panels.append(_resize(box, OUT_W, OUT_H // 2))
            out = np.vstack(panels)
            out[OUT_H // 2 - 2:OUT_H // 2 + 2] = 0
            return out
        if shot.layout == "track" and len(shot.times):
            cx = float(np.interp(t, shot.times, shot.centers))
        else:
            cx = fw / 2
        box = _crop_box(frame, cx, fh / 2, self.crop_w, fh)
        return _resize(box, OUT_W, OUT_H)
