"""Face tracking + audio-visual active speaker detection.

Faces are detected with YuNet at 25 fps and linked into tracks. Each track's
face crops plus the clip's audio are scored by Light-ASD (Liao et al., CVPR
2023, MIT licence), exported to ONNX and run with onnxruntime. A score above
zero means "this face is speaking in this frame".

The crop geometry and audio features replicate the reference implementation
(Columbia_test.py / python_speech_features) so the pretrained weights behave as
published.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

ASD_FPS = 25
MODELS = Path(__file__).parent / "models"
ASD_MODEL = MODELS / "light_asd.onnx"
DETECT_W = 640
CROP_MAX_W = 1280


@dataclass
class Track:
    frames: np.ndarray  # consecutive frame indices (25 fps, clip-relative)
    boxes: np.ndarray   # (N, 4) x1, y1, x2, y2 in source display px
    scores: np.ndarray = field(default_factory=lambda: np.zeros(0))  # (N,) ASD score

    @property
    def first(self) -> int:
        return int(self.frames[0])

    @property
    def last(self) -> int:
        return int(self.frames[-1])

    def covers(self, f: int) -> bool:
        return self.first <= f <= self.last

    def box(self, f: int) -> np.ndarray:
        return self.boxes[f - self.first]

    def score(self, f: int) -> float:
        return float(self.scores[f - self.first]) if len(self.scores) else 0.0

    @property
    def cx(self) -> np.ndarray:
        return (self.boxes[:, 0] + self.boxes[:, 2]) / 2

    @property
    def height(self) -> float:
        return float(np.median(self.boxes[:, 3] - self.boxes[:, 1]))


# ---------------------------------------------------------------------------
# Frame decoding
# ---------------------------------------------------------------------------

def iter_frames(src: str, start: float, dur: float, fps: float, out_w: int | None,
                size: tuple[int, int]):
    sw, sh = size
    if out_w and out_w < sw:
        ow, oh = out_w, int(round(sh * out_w / sw / 2) * 2)
        vf = f"fps={fps},scale={ow}:{oh}"
    else:
        ow, oh, vf = sw, sh, f"fps={fps}"
    # -v fatal: we often stop reading early on purpose, which ffmpeg reports as a broken pipe
    cmd = ["ffmpeg", "-v", "fatal", "-ss", f"{start:.3f}", "-i", src, "-t", f"{dur:.3f}",
           "-vf", vf, "-an", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = ow * oh * 3
    try:
        while True:
            buf = proc.stdout.read(n)
            if len(buf) < n:
                break
            yield np.frombuffer(buf, np.uint8).reshape(oh, ow, 3)
    finally:
        proc.stdout.close()
        proc.wait()


# ---------------------------------------------------------------------------
# Detection and tracking
# ---------------------------------------------------------------------------

class FaceDetector:
    """YuNet face detector (OpenCV DNN), Haar fallback."""

    def __init__(self, score_threshold: float = 0.6):
        self.yunet = None
        path = MODELS / "face_detection_yunet_2023mar.onnx"
        if path.exists() and hasattr(cv2, "FaceDetectorYN"):
            self.yunet = cv2.FaceDetectorYN.create(str(path), "", (320, 320), score_threshold, 0.3, 50)
            self._size = None
        else:
            self.haar = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
            if self.haar.empty():
                raise RuntimeError("No face detector available")

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        """Return (N, 4) boxes x1, y1, x2, y2 in frame px."""
        h, w = frame.shape[:2]
        if self.yunet is not None:
            if self._size != (w, h):
                self.yunet.setInputSize((w, h))
                self._size = (w, h)
            _, faces = self.yunet.detect(frame)
            if faces is None:
                return np.zeros((0, 4))
            b = faces[:, :4].astype(float)
        else:
            gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
            side = max(24, h // 14)
            b = np.array(self.haar.detectMultiScale(gray, 1.1, 5, minSize=(side, side)), float).reshape(-1, 4)
        b[:, 2] += b[:, 0]
        b[:, 3] += b[:, 1]
        return b


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def detect_and_track(src: str, start: float, dur: float, size: tuple[int, int],
                     min_track: int = 10, max_gap: int = 10, stride: int = 2
                     ):
    """Return (tracks, n_frames, shot_cut_frames, content_box)."""
    sw, _ = size
    scale = sw / min(DETECT_W, sw)
    detect = FaceDetector()
    raw: list[dict] = []   # {"f": [...], "b": [...]} per track
    active: list[dict] = []
    cuts = [0]
    prev_hist = None
    n = 0
    samples = []
    for f, frame in enumerate(iter_frames(src, start, dur, ASD_FPS, DETECT_W, size)):
        n = f + 1
        if f % 5 == 0 and len(samples) < 400:
            samples.append(cv2.cvtColor(cv2.resize(frame, (320, int(320 * frame.shape[0] / frame.shape[1]))),
                                        cv2.COLOR_BGR2GRAY))
        hsv = cv2.cvtColor(cv2.resize(frame, (160, 90)), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        if prev_hist is not None and f - cuts[-1] >= 8:
            if cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL) < 0.55:
                cuts.append(f)
                active = []
        prev_hist = hist

        if f % stride and f - cuts[-1] > 0:
            continue  # detect every `stride` frames; tracks are interpolated
        dets = detect(frame) * scale
        active = [t for t in active if f - t["f"][-1] <= max_gap]
        used = set()
        for t in active:
            best, best_iou = None, 0.3
            for i, d in enumerate(dets):
                if i in used:
                    continue
                v = _iou(t["b"][-1], d)
                if v > best_iou:
                    best, best_iou = i, v
            if best is not None:
                used.add(best)
                t["f"].append(f)
                t["b"].append(dets[best])
        for i, d in enumerate(dets):
            if i not in used:
                t = {"f": [f], "b": [d]}
                raw.append(t)
                active.append(t)

    tracks = []
    for t in raw:
        if len(t["f"]) < min_track:
            continue
        fr = np.array(t["f"])
        bx = np.array(t["b"])
        full = np.arange(fr[0], fr[-1] + 1)
        boxes = np.stack([np.interp(full, fr, bx[:, k]) for k in range(4)], axis=1)
        tracks.append(Track(full, boxes))
    content = content_box(samples, tracks, size)
    return tracks, n, cuts, content


def content_box(samples: list, tracks: list[Track], size: tuple[int, int]) -> tuple[int, int, int, int]:
    """Find the live picture inside static graphics (branded borders, logo bars, letterbox).

    A band at the frame edge is trimmed only if it is static for the whole clip,
    ends at a sharp boundary, and keeps clear of every tracked face.
    """
    sw, sh = size
    full = (0, 0, sw, sh)
    if len(samples) < 30:  # under ~6 s of footage, a still shot looks like a static border everywhere
        return full
    stack = np.stack(samples).astype(np.float32)
    std = stack.std(axis=0)
    mean = stack.mean(axis=0)
    h, w = std.shape
    k = sw / w

    def edge_strength(axis: int, pos: int) -> float:
        g = np.abs(np.diff(mean, axis=axis))
        lo, hi = max(0, pos - 4), min(g.shape[axis], pos + 4)
        win = g[lo:hi, :] if axis == 0 else g[:, lo:hi]
        return float(np.median(win.max(axis=axis)))

    def band(profile: np.ndarray, from_end: bool, axis: int) -> int:
        idx = range(len(profile) - 1, -1, -1) if from_end else range(len(profile))
        count = 0
        for i in idx:
            if profile[i] < 3.0:
                count += 1
            else:
                break
        if count < 0.05 * len(profile) or count > 0.45 * len(profile):
            return 0
        pos = len(profile) - count if from_end else count
        return count if edge_strength(axis, pos) > 14 else 0

    rows = np.percentile(std, 90, axis=1)
    cols = np.percentile(std, 90, axis=0)
    top, bottom = band(rows, False, 0), band(rows, True, 0)
    left, right = band(cols, False, 1), band(cols, True, 1)
    # trim a little past each detected border so no edge sliver survives
    pad = 0.015 * sh
    x0 = left * k + (pad if left else 0)
    y0 = top * k + (pad if top else 0)
    x1 = sw - right * k - (pad if right else 0)
    y1 = sh - bottom * k - (pad if bottom else 0)
    # safety net: never cut into a face (robust percentiles ignore stray detections)
    for t in tracks:
        if len(t.frames) < 25:
            continue
        fh = t.height
        cx = (t.boxes[:, 0] + t.boxes[:, 2]) / 2
        cy = (t.boxes[:, 1] + t.boxes[:, 3]) / 2
        x0 = min(x0, float(np.percentile(cx, 5)) - 0.5 * fh)
        x1 = max(x1, float(np.percentile(cx, 95)) + 0.5 * fh)
        y0 = min(y0, float(np.percentile(cy, 5)) - 0.7 * fh)
        y1 = max(y1, float(np.percentile(cy, 95)) + 0.5 * fh)
    x0, y0 = max(0, int(x0)), max(0, int(y0))
    x1, y1 = min(sw, int(x1)), min(sh, int(y1))
    if (x1 - x0) * (y1 - y0) > 0.97 * sw * sh:
        return full
    return (x0, y0, x1, y1)


# ---------------------------------------------------------------------------
# Light-ASD inputs
# ---------------------------------------------------------------------------

def _medfilt(x: np.ndarray, k: int = 13) -> np.ndarray:
    if len(x) < 3:
        return x
    k = min(k, len(x) if len(x) % 2 else len(x) - 1)
    p = k // 2
    xp = np.pad(x, p, mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(xp, k)
    return np.median(win, axis=1)


def face_crops(src: str, start: float, dur: float, size: tuple[int, int],
               tracks: list[Track], crop_scale: float = 0.40) -> list[np.ndarray]:
    """112x112 grayscale face crops per track, as in Light-ASD's Columbia_test."""
    sw, _ = size
    ow = min(CROP_MAX_W, sw)
    k = ow / sw
    geo = []
    for t in tracks:
        b = t.boxes * k
        s = _medfilt(np.maximum(b[:, 3] - b[:, 1], b[:, 2] - b[:, 0]) / 2)
        y = _medfilt((b[:, 1] + b[:, 3]) / 2)
        x = _medfilt((b[:, 0] + b[:, 2]) / 2)
        geo.append((s, x, y))
    out = [np.zeros((len(t.frames), 112, 112), np.uint8) for t in tracks]
    for f, frame in enumerate(iter_frames(src, start, dur, ASD_FPS, ow, size)):
        for ti, t in enumerate(tracks):
            if not t.covers(f):
                continue
            i = f - t.first
            s, x, y = (g[i] for g in geo[ti])
            # grey (110) padding outside the frame, like the reference implementation
            x0, x1 = int(x - s * (1 + crop_scale)), int(x + s * (1 + crop_scale))
            y0, y1 = int(y - s), int(y + s * (1 + 2 * crop_scale))
            fh, fw = frame.shape[:2]
            canvas = np.full((y1 - y0, x1 - x0, 3), 110, np.uint8)
            sx0, sy0 = max(0, x0), max(0, y0)
            sx1, sy1 = min(fw, x1), min(fh, y1)
            if sx1 > sx0 and sy1 > sy0:
                canvas[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = frame[sy0:sy1, sx0:sx1]
            face = cv2.resize(canvas, (224, 224))
            gray = cv2.cvtColor(face, cv2.COLOR_BGR2GRAY)
            out[ti][i] = gray[56:168, 56:168]
    return out


def _hz2mel(hz):
    return 2595 * np.log10(1 + hz / 700.0)


def _mel2hz(mel):
    return 700 * (10 ** (mel / 2595.0) - 1)


def mfcc(signal: np.ndarray, sr: int = 16000, winlen: float = 0.025, winstep: float = 0.01,
         numcep: int = 13, nfilt: int = 26, nfft: int = 512, preemph: float = 0.97,
         ceplifter: int = 22) -> np.ndarray:
    """Numpy port of python_speech_features.mfcc (same defaults and maths)."""
    sig = np.asarray(signal, dtype=np.float64)
    sig = np.append(sig[0], sig[1:] - preemph * sig[:-1])
    flen, fstep = int(round(winlen * sr)), int(round(winstep * sr))
    slen = len(sig)
    nframes = 1 if slen <= flen else 1 + int(np.ceil((slen - flen) / fstep))
    padlen = (nframes - 1) * fstep + flen
    sig = np.concatenate([sig, np.zeros(padlen - slen)])
    idx = np.arange(flen)[None, :] + np.arange(nframes)[:, None] * fstep
    frames = sig[idx]
    pspec = (1.0 / nfft) * np.square(np.abs(np.fft.rfft(frames, nfft)))
    energy = pspec.sum(1)
    energy = np.where(energy == 0, np.finfo(float).eps, energy)

    melpts = np.linspace(_hz2mel(0), _hz2mel(sr / 2), nfilt + 2)
    bins = np.floor((nfft + 1) * _mel2hz(melpts) / sr)
    fb = np.zeros((nfilt, nfft // 2 + 1))
    for j in range(nfilt):
        for i in range(int(bins[j]), int(bins[j + 1])):
            fb[j, i] = (i - bins[j]) / (bins[j + 1] - bins[j])
        for i in range(int(bins[j + 1]), int(bins[j + 2])):
            fb[j, i] = (bins[j + 2] - i) / (bins[j + 2] - bins[j + 1])
    feat = pspec @ fb.T
    feat = np.log(np.where(feat == 0, np.finfo(float).eps, feat))

    n = nfilt
    k = np.arange(n)[:, None]
    basis = np.cos(np.pi * k * (2 * np.arange(n)[None, :] + 1) / (2 * n))
    basis *= np.sqrt(2.0 / n)
    basis[0] /= np.sqrt(2.0)
    feat = (feat @ basis.T)[:, :numcep]
    lift = 1 + (ceplifter / 2.0) * np.sin(np.pi * np.arange(numcep) / ceplifter)
    feat *= lift
    feat[:, 0] = np.log(energy)
    return feat


def load_audio(src: str, start: float, dur: float) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", src, "-t", f"{dur:.3f}",
           "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16)


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

_session = None


def _get_session():
    global _session
    if _session is None:
        import onnxruntime as ort
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        _session = ort.InferenceSession(str(ASD_MODEL), opts, providers=["CPUExecutionProvider"])
    return _session


def asd_available() -> bool:
    if not ASD_MODEL.exists():
        return False
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return False
    return True


def score_track(feats: np.ndarray, crops: np.ndarray,
                durations=(1, 2, 4, 6)) -> np.ndarray:
    """Per-frame speaking score for one track, averaged over several window lengths
    (the reference demo repeats some lengths; repeats are deterministic, so this
    reduced set gives ~0.997 correlation at a third of the cost)."""
    sess = _get_session()
    T = min(len(crops), len(feats) // 4)
    if T == 0:
        return np.full(len(crops), -5.0)
    a = feats[: T * 4].astype(np.float32)
    v = crops[:T].astype(np.float32)
    runs = []
    for d in durations:
        out = []
        for i in range(0, T, d * ASD_FPS):
            va = v[i:i + d * ASD_FPS]
            aa = a[i * 4:(i + len(va)) * 4]
            res = sess.run(None, {"audio": aa[None], "video": va[None]})[0]
            out.append(res.reshape(-1))
        runs.append(np.concatenate(out)[:T])
    s = np.mean(runs, axis=0)
    if T < len(crops):
        s = np.concatenate([s, np.full(len(crops) - T, s[-1])])
    return s


def analyze_speakers(src: str, start: float, dur: float, size: tuple[int, int],
                     use_asd: bool = True):
    """Return (tracks, n_frames, shot_cut_frames, content_box)."""
    tracks, n, cuts, content = detect_and_track(src, start, dur, size)
    if tracks and use_asd and asd_available():
        crops = face_crops(src, start, dur, size, tracks)
        feats = mfcc(load_audio(src, start, dur))
        for t, c in zip(tracks, crops):
            seg = feats[t.first * 4:(t.last + 1) * 4]
            t.scores = score_track(seg, c)
    return tracks, n, cuts, content
