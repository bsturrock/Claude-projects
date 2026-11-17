"""Render one clip from an edit decision list.

Video: each piece is decoded from the source, reframed (and punched in when
asked) in Python, then piped to one encoder with the captions burned in.
Audio: each part is extracted once, pieces are trimmed and concatenated with
micro-fades, optionally cleaned up, loudness-normalised, and followed by the
end-card sting.
"""

from __future__ import annotations

import functools
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

from . import endcard
from .captions import FONTS_DIR
from .edit import Piece
from .media import MediaError, VideoInfo, escape_filter_path, run
from .reframe import OUT_H, OUT_W, Plan, Reframer
from .speaker import iter_frames

CLEANUP = ("highpass=f=80,afftdn=nf=-28:nr=10,deesser=i=0.35,"
           "acompressor=threshold=-21dB:ratio=3:attack=5:release=150:makeup=2")


@functools.lru_cache(maxsize=1)
def has_videotoolbox() -> bool:
    if platform.system() != "Darwin" or not shutil.which("ffmpeg"):
        return False
    out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return "h264_videotoolbox" in out


def video_codec_args(encoder: str, crf: int, preset: str, fps: int) -> list[str]:
    use_vt = encoder == "videotoolbox" or (encoder == "auto" and has_videotoolbox())
    if use_vt:
        # Apple hardware encoder: several times faster than x264 on a Mac.
        return ["-c:v", "h264_videotoolbox", "-b:v", "12M", "-maxrate", "18M", "-bufsize", "24M",
                "-profile:v", "high", "-allow_sw", "1", "-pix_fmt", "yuv420p", "-g", str(fps * 2)]
    return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high",
            "-pix_fmt", "yuv420p", "-g", str(fps * 2)]


def _punch(frame: np.ndarray, zoom: float) -> np.ndarray:
    if zoom <= 1.001:
        return frame
    h, w = frame.shape[:2]
    cw, ch = int(w / zoom), int(h / zoom)
    x0 = (w - cw) // 2
    y0 = int(np.clip(h * 0.42 - ch / 2, 0, h - ch))  # bias towards faces, upper part of frame
    return cv2.resize(frame[y0:y0 + ch, x0:x0 + cw], (w, h), interpolation=cv2.INTER_LINEAR)


def render_clip(info: VideoInfo, parts: list[tuple[float, float]], pieces: list[Piece],
                plans: list[Plan], ass_path: Path, out_path: Path, *, crf: int = 19,
                preset: str = "medium", loudnorm: bool = True, audio_clean: bool = False,
                brand: str = "", encoder: str = "auto", progress=None, overlay=None) -> float:
    """`overlay(frame, t)` draws on each output frame (signature captions)."""
    """Returns the output duration in seconds."""
    fps = min(round(info.fps), 60) or 30
    content = sum(p.dur for p in pieces)
    card = endcard.card_seconds(brand) if brand else 0.0
    total = content + card
    reframers = [Reframer(p) for p in plans]
    src = str(info.path.resolve())

    with tempfile.TemporaryDirectory(prefix="clipper-") as tmp:
        tmp = Path(tmp)
        inputs: list[str] = []
        filt: list[str] = []
        if info.has_audio:
            # one audio file per part, then trim pieces out of it
            for k, (a, b) in enumerate(parts):
                wav = tmp / f"part{k}.wav"
                run(["ffmpeg", "-y", "-v", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", src,
                     "-vn", "-ac", "2", "-ar", "48000", str(wav)])
                inputs += ["-i", str(wav)]
            labels = []
            uses: dict[int, int] = {}
            for p in pieces:
                uses[p.part] = uses.get(p.part, 0) + 1
            split_out: dict[int, list[str]] = {}
            for k, n in uses.items():
                outs = [f"[s{k}_{j}]" for j in range(n)]
                filt.append(f"[{k + 1}:a]asplit={n}{''.join(outs)}" if n > 1 else f"[{k + 1}:a]anull{outs[0]}")
                split_out[k] = outs
            for j, p in enumerate(pieces):
                a = parts[p.part][0]
                s, e = p.src_start - a, p.src_end - a
                fo = max(0.0, p.dur - 0.012)
                filt.append(f"{split_out[p.part].pop(0)}atrim=start={s:.4f}:end={e:.4f},asetpts=PTS-STARTPTS,"
                            f"afade=t=in:d=0.008,afade=t=out:st={fo:.4f}:d=0.012[p{j}]")
                labels.append(f"[p{j}]")
            chain = []
            if audio_clean:
                chain.append(CLEANUP)
            if loudnorm:
                chain.append("loudnorm=I=-14:TP=-1.5:LRA=11")
            chain.append("aresample=48000")
            chain.append(f"afade=t=out:st={max(0.0, content - 0.08):.3f}:d=0.08")
            filt.append(f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1,{','.join(chain)}[body]")
            if card:
                sting = endcard.write_sting(endcard.get_brand(brand).sting, tmp / "sting.wav", card)
                inputs += ["-i", str(sting)]
                filt.append(f"[{len(parts) + 1}:a]anull[sting]")
                filt.append("[body][sting]concat=n=2:v=0:a=1[aout]")
            else:
                filt.append("[body]anull[aout]")
        vlabel = f"ass={escape_filter_path(ass_path.name)}:fontsdir={escape_filter_path(FONTS_DIR)}"
        filt.append(f"[0:v]{vlabel}[vout]")

        cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
               "-s", f"{OUT_W}x{OUT_H}", "-r", str(fps), "-i", "-", *inputs,
               "-filter_complex", ";".join(filt), "-map", "[vout]"]
        if info.has_audio:
            cmd += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
        cmd += [*video_codec_args(encoder, crf, preset, fps),
                "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                "-movflags", "+faststart", "-t", f"{total:.3f}", str(out_path.resolve())]
        enc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ass_path.parent)
        written = 0
        last = None
        try:
            for j, p in enumerate(pieces):
                if progress and len(pieces) > 1:
                    progress(f"encoding {j + 1}/{len(pieces)}")
                want = round(p.dur * fps)
                part_a = parts[p.part][0]
                got = 0
                for frame in iter_frames(src, p.src_start, p.dur + 1 / fps, fps, None, info.display_size):
                    if got >= want:
                        break
                    t = (p.src_start - part_a) + got / fps
                    out = _punch(reframers[p.part].render(frame, t), p.zoom)
                    if overlay is not None:
                        if not out.flags.writeable:
                            out = out.copy()
                        overlay(out, p.out_start + got / fps)
                    enc.stdin.write(out.tobytes())
                    last = out
                    got += 1
                while got < want and last is not None:  # source ran short: hold the last frame
                    enc.stdin.write(last.tobytes())
                    got += 1
                written += got
            if card and last is not None:
                if progress:
                    progress("end card")
                for frame in endcard.card_frames(brand, last, fps, card):
                    enc.stdin.write(frame.tobytes())
                    written += 1
        except BrokenPipeError:
            pass
        finally:
            try:
                enc.stdin.close()
            except BrokenPipeError:
                pass
        err = enc.stderr.read().decode(errors="replace")
        if enc.wait() != 0 or written == 0:
            raise MediaError(f"Encoding failed for {out_path.name} ({written} frames)\n{err[-2000:]}")
    return total


def thumbnail(video: Path, at: float, out: Path) -> Path:
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{at:.2f}", "-i", str(video),
         "-frames:v", "1", "-q:v", "2", str(out)])
    return out
