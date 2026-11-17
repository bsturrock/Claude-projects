"""ffmpeg / ffprobe / yt-dlp helpers."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class MediaError(RuntimeError):
    pass


def require_tools() -> None:
    missing = [t for t in ("ffmpeg", "ffprobe") if shutil.which(t) is None]
    if missing:
        raise MediaError(
            f"Missing required tools: {', '.join(missing)}. "
            "Install ffmpeg (macOS: `brew install ffmpeg`)."
        )


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-25:])
        raise MediaError(f"Command failed: {' '.join(cmd[:6])} ...\n{tail}")
    return proc


@dataclass
class VideoInfo:
    path: Path
    width: int
    height: int
    fps: float
    duration: float
    has_audio: bool
    rotation: int = 0

    @property
    def display_size(self) -> tuple[int, int]:
        if self.rotation in (90, 270):
            return self.height, self.width
        return self.width, self.height


def probe(path: Path) -> VideoInfo:
    out = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(path),
    ]).stdout
    data = json.loads(out)
    vstreams = [s for s in data["streams"] if s.get("codec_type") == "video"]
    if not vstreams:
        raise MediaError(f"No video stream in {path}")
    v = vstreams[0]
    num, _, den = v.get("avg_frame_rate", "30/1").partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    if not fps or fps > 240:
        fps = 30.0
    rotation = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = abs(int(sd["rotation"])) % 360
    if "rotate" in (v.get("tags") or {}):
        rotation = abs(int(v["tags"]["rotate"])) % 360
    duration = float(data["format"].get("duration") or v.get("duration") or 0)
    return VideoInfo(
        path=path,
        width=int(v["width"]),
        height=int(v["height"]),
        fps=fps,
        duration=duration,
        has_audio=any(s.get("codec_type") == "audio" for s in data["streams"]),
        rotation=rotation,
    )


def is_url(s: str) -> bool:
    return bool(re.match(r"^https?://", s))


def download(url: str, dest_dir: Path) -> Path:
    """Download a video with yt-dlp (best <=1080p mp4)."""
    try:
        import yt_dlp
    except ImportError as e:  # pragma: no cover
        raise MediaError("yt-dlp is required for URL inputs") from e
    dest_dir.mkdir(parents=True, exist_ok=True)
    opts = {
        "format": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/bv*+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": str(dest_dir / "%(id)s.%(ext)s"),
        "quiet": True,
        "noprogress": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        path = Path(ydl.prepare_filename(info))
    if path.suffix != ".mp4" and path.with_suffix(".mp4").exists():
        path = path.with_suffix(".mp4")
    if not path.exists():
        raise MediaError(f"Download finished but file not found: {path}")
    return path


def extract_audio(src: Path, dest: Path) -> Path:
    """16 kHz mono WAV for transcription."""
    run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "1",
         "-ar", "16000", "-c:a", "pcm_s16le", str(dest)])
    return dest


def escape_filter_path(p: Path | str) -> str:
    """Escape a path for use inside an ffmpeg filter argument."""
    s = str(p).replace("\\", "/")
    for ch in (":", "'", ",", "[", "]", ";"):
        s = s.replace(ch, "\\" + ch)
    return s
