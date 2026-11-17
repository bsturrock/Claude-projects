"""End-to-end orchestration."""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import media
from .captions import build_ass, build_srt, get_style
from .copywriter import format_post_md, write_copy
from .llm import DEFAULT_MODEL
from .reframe import Plan, Shot, analyze
from .render import render_clip, thumbnail
from .selection import Clip, dedupe, find_moments, load_manual, refine
from .transcript import Transcript, Word, resegment, transcribe


@dataclass
class Options:
    source: str
    out_dir: Path = Path("out")
    brief: str = ""
    tone: str = ""
    count: int = 5
    min_len: float = 15.0
    max_len: float = 60.0
    target_len: float | None = None
    style: str = "bold"
    style_overrides: dict = field(default_factory=dict)
    hook_mode: str = "intro"
    layout: str = "auto"  # auto | fit | center
    allow_stack: bool = True
    whisper_model: str = "small"
    language: str | None = None
    transcript_path: Path | None = None
    clips_path: Path | None = None
    write_post_copy: bool = True
    copy_extra: str = ""
    model: str = DEFAULT_MODEL
    effort: str = "high"
    crf: int = 19
    preset: str = "medium"
    loudnorm: bool = True
    select_only: bool = False


def log(msg: str) -> None:
    print(f"[clipper] {msg}", flush=True)


def _file_key(p: Path) -> str:
    st = p.stat()
    return hashlib.sha1(f"{p.resolve()}:{st.st_size}:{st.st_mtime}".encode()).hexdigest()[:12]


def load_any_transcript(path: Path) -> Transcript:
    d = json.loads(path.read_text())
    if "words" in d and isinstance(d["words"], list):
        t = Transcript.load(path)
    else:  # whisper / whisperX style: {"segments": [{"words": [{"word", "start", "end"}]}]}
        words = []
        for s in d.get("segments", []):
            for w in s.get("words", []):
                txt = (w.get("word") or w.get("text") or "").strip()
                if txt and "start" in w and "end" in w:
                    words.append(Word(txt, float(w["start"]), float(w["end"])))
        if not words:
            raise ValueError(f"No word-level timestamps found in {path}")
        t = Transcript(language=d.get("language", "en"), words=words)
    if not t.segments:
        t.segments = resegment(t.words)
    return t


def run(opts: Options) -> list[Clip]:
    media.require_tools()
    t0 = time.time()

    # 1. Ingest -------------------------------------------------------------
    if media.is_url(opts.source):
        log(f"downloading {opts.source}")
        src = media.download(opts.source, opts.out_dir / "_downloads")
    else:
        src = Path(opts.source).expanduser()
        if not src.exists():
            raise FileNotFoundError(src)
    info = media.probe(src)
    name = re.sub(r"[^A-Za-z0-9_-]+", "-", src.stem).strip("-")[:60] or "video"
    out = opts.out_dir / name
    work = out / ".work"
    work.mkdir(parents=True, exist_ok=True)
    log(f"source {src.name}: {info.display_size[0]}x{info.display_size[1]} "
        f"@ {info.fps:.2f}fps, {info.duration / 60:.1f} min")

    # 2. Transcribe ---------------------------------------------------------
    if opts.transcript_path:
        transcript = load_any_transcript(opts.transcript_path)
    else:
        cache = work / f"transcript-{_file_key(src)}-{opts.whisper_model}.json"
        if cache.exists():
            log("using cached transcript")
            transcript = Transcript.load(cache)
        else:
            if not info.has_audio:
                raise media.MediaError("Source has no audio track to transcribe.")
            log(f"transcribing with faster-whisper ({opts.whisper_model})")
            wav = media.extract_audio(src, work / "audio.wav")
            transcript = transcribe(wav, opts.whisper_model, opts.language)
            transcript.save(cache)
            wav.unlink(missing_ok=True)
    log(f"transcript: {len(transcript.words)} words, language={transcript.language}")

    # 3. Select moments -----------------------------------------------------
    if opts.clips_path:
        candidates = load_manual(opts.clips_path)
        log(f"loaded {len(candidates)} clips from {opts.clips_path}")
        refined = [c for c in candidates if c.end > c.start]  # trust manual timings
        clips = refined
    else:
        log(f"finding moments with {opts.model}")
        candidates = find_moments(
            transcript, brief=opts.brief, tone=opts.tone, count=opts.count,
            min_len=opts.min_len, max_len=opts.max_len, target_len=opts.target_len,
            model=opts.model, effort=opts.effort,
        )
        refined = [r for c in candidates if (r := refine(c, transcript, opts.min_len, opts.max_len))]
        clips = dedupe(refined)[: opts.count]
    clips.sort(key=lambda c: c.start)
    for i, c in enumerate(clips, 1):
        c.index = i
    (out / "clips.json").write_text(json.dumps([c.to_dict() for c in clips], indent=2))
    for c in clips:
        log(f"  {c.index:02d} [{c.start:7.1f}-{c.end:7.1f}] {c.duration:4.1f}s  "
            f"score {c.score:3d}  {c.title}")
    if not clips:
        log("no clips found")
        return []
    if opts.select_only:
        log(f"selection written to {out / 'clips.json'}; edit it and re-run with --clips")
        return clips

    # 4. Post copy ----------------------------------------------------------
    if opts.write_post_copy:
        log("writing post copy")
        try:
            write_copy(clips, transcript, brief=opts.brief, tone=opts.tone,
                       model=opts.model, extra=opts.copy_extra)
        except Exception as e:  # copy failure should not lose the renders
            log(f"post copy failed: {e}")

    # 5. Reframe + caption + render ----------------------------------------
    style = get_style(opts.style, **opts.style_overrides)
    for c in clips:
        log(f"rendering {c.slug} ({c.duration:.1f}s)")
        if opts.layout in ("fit", "center"):
            w, h = info.display_size
            plan = Plan(w, h, [Shot(0, c.duration, opts.layout)])
        else:
            plan = analyze(str(src), c.start, c.end, info.display_size,
                           fallback="fit", allow_stack=opts.allow_stack)
        layouts = ", ".join(f"{s.layout}@{s.start:.1f}s" for s in plan.shots)
        log(f"  layout: {layouts}")

        words = [Word(w.text, round(w.start - c.start, 3), round(w.end - c.start, 3))
                 for w in transcript.words_between(c.start, c.end)]
        words = [w for w in words if w.end > 0 and w.start < c.duration]
        cap_y = style.y
        if plan.dominant_layout == "stack":
            cap_y = 0.5
        ass = build_ass(words, style, hook=c.hook, hook_mode=opts.hook_mode,
                        duration=c.duration, y=cap_y)
        ass_path = work / f"{c.slug}.ass"
        ass_path.write_text(ass)
        (out / f"{c.slug}.srt").write_text(build_srt(words, style))

        mp4 = out / f"{c.slug}.mp4"
        render_clip(info, c.start, c.end, plan, ass_path, mp4,
                    crf=opts.crf, preset=opts.preset, loudnorm=opts.loudnorm)
        thumbnail(mp4, min(1.0, c.duration / 3), out / f"{c.slug}.jpg")
        if c.copy:
            (out / f"{c.slug}.post.json").write_text(json.dumps(c.copy, indent=2, ensure_ascii=False))

    # 6. Summary ------------------------------------------------------------
    md = [f"# Clips from {src.name}\n",
          f"Brief: {opts.brief or '(none)'}  \nTone: {opts.tone or '(none)'}\n"]
    md += [format_post_md(c) for c in clips]
    (out / "posts.md").write_text("\n".join(md))
    manifest = {
        "source": str(src), "brief": opts.brief, "tone": opts.tone,
        "style": opts.style, "model": opts.model,
        "clips": [c.to_dict() | {"file": f"{c.slug}.mp4"} for c in clips],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    log(f"done: {len(clips)} clips in {out} ({time.time() - t0:.0f}s)")
    return clips
