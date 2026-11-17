"""Render one clip: decode -> reframe (Python) -> encode with burned captions + audio."""

from __future__ import annotations

import subprocess
from pathlib import Path

from .captions import FONTS_DIR
from .media import MediaError, VideoInfo, escape_filter_path, run
from .reframe import OUT_H, OUT_W, Plan, Reframer
from .speaker import iter_frames


def render_clip(info: VideoInfo, start: float, end: float, plan: Plan, ass_path: Path,
                out_path: Path, *, crf: int = 19, preset: str = "medium",
                loudnorm: bool = True) -> Path:
    dur = end - start
    fps = min(round(info.fps), 60) or 30
    reframer = Reframer(plan)

    vf = f"ass={escape_filter_path(ass_path.name)}:fontsdir={escape_filter_path(FONTS_DIR)}"
    afilters = [f"afade=t=in:d=0.04", f"afade=t=out:st={max(0, dur - 0.08):.3f}:d=0.08"]
    if loudnorm:
        afilters.insert(0, "loudnorm=I=-14:TP=-1.5:LRA=11")

    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{OUT_W}x{OUT_H}", "-r", str(fps), "-i", "-",
    ]
    if info.has_audio:
        cmd += ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(info.path.resolve())]
    cmd += ["-map", "0:v"]
    if info.has_audio:
        cmd += ["-map", "1:a:0", "-af", ",".join(afilters),
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    cmd += [
        "-vf", vf,
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-profile:v", "high", "-pix_fmt", "yuv420p", "-colorspace", "bt709",
        "-color_primaries", "bt709", "-color_trc", "bt709",
        "-g", str(fps * 2), "-movflags", "+faststart", "-shortest",
        str(out_path.resolve()),
    ]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
                           cwd=ass_path.parent)
    n = 0
    try:
        for frame in iter_frames(str(info.path), start, dur, fps, None, info.display_size):
            enc.stdin.write(reframer.render(frame, n / fps).tobytes())
            n += 1
    except BrokenPipeError:
        pass
    finally:
        if enc.stdin:
            try:
                enc.stdin.close()
            except BrokenPipeError:
                pass
    err = enc.stderr.read().decode(errors="replace") if enc.stderr else ""
    if enc.wait() != 0 or n == 0:
        raise MediaError(f"Encoding failed for {out_path.name} ({n} frames)\n{err[-2000:]}")
    return out_path


def thumbnail(video: Path, at: float, out: Path) -> Path:
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{at:.2f}", "-i", str(video),
         "-frames:v", "1", "-q:v", "2", str(out)])
    return out
