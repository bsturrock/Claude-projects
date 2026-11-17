"""End-to-end orchestration, split into resumable stages so the review UI can
re-run single steps (re-render one clip, regenerate copy, ...)."""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import media
from .captions import DEFAULT_STYLE, PRESETS, build_ass, build_srt, get_style
from .copywriter import format_post_md, write_copy
from .llm import DEFAULT_MODEL
from .reframe import Plan, Shot, analyze
from .render import render_clip, thumbnail
from .selection import Clip, clip_from_dict, dedupe, find_moments, load_manual, refine
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
    style: str = "auto"  # "auto" = Claude picks per clip, or a preset name to force
    style_overrides: dict = field(default_factory=dict)
    hook_mode: str = "intro"
    layout: str = "auto"  # auto | fit | center
    two_shot: str = "cut"  # cut | stack
    crosstalk: bool = True
    use_asd: bool = True
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
    review: bool = False
    reselect: bool = False
    port: int = 8765


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


class Project:
    def __init__(self, opts: Options):
        self.opts = opts
        self.clips: list[Clip] = []
        self.lock = threading.RLock()

    # -- 1. ingest + transcribe ---------------------------------------------
    def prepare(self) -> None:
        o = self.opts
        media.require_tools()
        if media.is_url(o.source):
            log(f"downloading {o.source}")
            src = media.download(o.source, o.out_dir / "_downloads")
        else:
            src = Path(o.source).expanduser()
            if not src.exists():
                raise FileNotFoundError(src)
        self.src = src
        self.info = media.probe(src)
        name = re.sub(r"[^A-Za-z0-9_-]+", "-", src.stem).strip("-")[:60] or "video"
        self.out = o.out_dir / name
        self.work = self.out / ".work"
        self.work.mkdir(parents=True, exist_ok=True)
        w, h = self.info.display_size
        log(f"source {src.name}: {w}x{h} @ {self.info.fps:.2f}fps, {self.info.duration / 60:.1f} min")

        if o.transcript_path:
            self.transcript = load_any_transcript(o.transcript_path)
        else:
            cache = self.work / f"transcript-{_file_key(src)}-{o.whisper_model}.json"
            if cache.exists():
                log("using cached transcript")
                self.transcript = Transcript.load(cache)
            else:
                if not self.info.has_audio:
                    raise media.MediaError("Source has no audio track to transcribe.")
                log(f"transcribing with faster-whisper ({o.whisper_model})")
                wav = media.extract_audio(src, self.work / "audio.wav")
                self.transcript = transcribe(wav, o.whisper_model, o.language)
                self.transcript.save(cache)
                wav.unlink(missing_ok=True)
        log(f"transcript: {len(self.transcript.words)} words, language={self.transcript.language}")

    # -- 2. select ----------------------------------------------------------
    @property
    def state_path(self) -> Path:
        return self.out / "clips.json"

    def select(self) -> list[Clip]:
        o = self.opts
        if o.clips_path:
            clips = [c for c in load_manual(o.clips_path) if c.end > c.start]
            log(f"loaded {len(clips)} clips from {o.clips_path}")
        elif o.review and self.state_path.exists() and not o.reselect:
            clips = [clip_from_dict(d) for d in json.loads(self.state_path.read_text())]
            log(f"resuming {len(clips)} clips from {self.state_path} (use --reselect to start over)")
        else:
            log(f"finding moments with {o.model}")
            cands = find_moments(
                self.transcript, brief=o.brief, tone=o.tone, count=o.count,
                min_len=o.min_len, max_len=o.max_len, target_len=o.target_len,
                model=o.model, effort=o.effort,
            )
            refined = [r for c in cands if (r := refine(c, self.transcript, o.min_len, o.max_len))]
            clips = dedupe(refined)[: o.count]
        if o.style != "auto":
            for c in clips:
                c.style = o.style
        for c in clips:
            if c.style not in PRESETS:
                c.style = DEFAULT_STYLE
        clips.sort(key=lambda c: c.start)
        for i, c in enumerate(clips, 1):
            c.index = i
        self.clips = clips
        self.save()
        for c in clips:
            log(f"  {c.index:02d} [{c.start:7.1f}-{c.end:7.1f}] {c.duration:4.1f}s  "
                f"score {c.score:3d}  {c.style:9s} {c.title}")
        return clips

    def save(self) -> None:
        with self.lock:
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps([c.to_dict() for c in self.clips], indent=2, ensure_ascii=False))
            tmp.replace(self.state_path)

    def clip_text(self, c: Clip) -> str:
        return self.transcript.text_between(c.start, c.end)

    # -- 3. copy ------------------------------------------------------------
    def copy_sig(self, c: Clip) -> str:
        return hashlib.sha1(f"{c.start:.2f}|{c.end:.2f}|{c.title}|{c.hook}".encode()).hexdigest()[:10]

    def ensure_copy(self, clips: list[Clip], force: bool = False) -> None:
        o = self.opts
        if not o.write_post_copy:
            return
        todo = [c for c in clips if force or not c.copy or c.copy_sig != self.copy_sig(c)]
        if not todo:
            return
        log(f"writing post copy for {len(todo)} clip(s)")
        write_copy(todo, self.transcript, brief=o.brief, tone=o.tone, model=o.model, extra=o.copy_extra)
        with self.lock:
            for c in todo:
                if c.copy:
                    c.copy_sig = self.copy_sig(c)
                    (self.out / f"{c.slug}.post.json").write_text(
                        json.dumps(c.copy, indent=2, ensure_ascii=False))
        self.save()

    # -- 4. render ----------------------------------------------------------
    def render_sig(self, c: Clip) -> str:
        o = self.opts
        key = (f"{c.start:.3f}|{c.end:.3f}|{c.style}|{c.hook}|{o.hook_mode}|{o.layout}|{o.two_shot}|"
               f"{o.crosstalk}|{o.use_asd}|{sorted(o.style_overrides.items())}|{o.crf}")
        return hashlib.sha1(key.encode()).hexdigest()[:10]

    def plan_for(self, c: Clip) -> Plan:
        o = self.opts
        w, h = self.info.display_size
        if o.layout in ("fit", "center"):
            return Plan(w, h, [Shot(0, c.duration, o.layout)])
        return analyze(str(self.src), c.start, c.end, (w, h), fallback="fit",
                       two_shot=o.two_shot, use_asd=o.use_asd, crosstalk=o.crosstalk)

    def render(self, c: Clip, progress=None) -> Path:
        o = self.opts
        log(f"rendering {c.slug} ({c.duration:.1f}s, {c.style})")
        if progress:
            progress("analysing speakers")
        plan = self.plan_for(c)
        c.layout = plan.describe()
        log(f"  layout: {c.layout}")
        style = get_style(c.style or DEFAULT_STYLE, **o.style_overrides)
        words = [Word(w.text, round(w.start - c.start, 3), round(w.end - c.start, 3))
                 for w in self.transcript.words_between(c.start, c.end)]
        words = [w for w in words if w.end > 0 and w.start < c.duration]
        cap_y = 0.5 if plan.dominant_layout == "stack" else style.y
        ass_path = self.work / f"{c.slug}.ass"
        ass_path.write_text(build_ass(words, style, hook=c.hook, hook_mode=o.hook_mode,
                                      duration=c.duration, y=cap_y))
        (self.out / f"{c.slug}.srt").write_text(build_srt(words, style))
        if progress:
            progress("encoding")
        # remove an older render of this clip under a different title
        if c.file and c.file != f"{c.slug}.mp4":
            for ext in (".mp4", ".jpg", ".srt", ".post.json"):
                (self.out / (Path(c.file).stem + ext)).unlink(missing_ok=True)
        mp4 = self.out / f"{c.slug}.mp4"
        render_clip(self.info, c.start, c.end, plan, ass_path, mp4,
                    crf=o.crf, preset=o.preset, loudnorm=o.loudnorm)
        thumbnail(mp4, min(1.0, c.duration / 3), self.out / f"{c.slug}.jpg")
        with self.lock:
            c.file = mp4.name
            c.render_sig = self.render_sig(c)
        self.save()
        return mp4

    # -- 5. summary ---------------------------------------------------------
    def write_summary(self) -> None:
        o = self.opts
        done = [c for c in self.clips if c.file and c.status != "rejected"]
        md = [f"# Clips from {self.src.name}\n",
              f"Brief: {o.brief or '(none)'}  \nTone: {o.tone or '(none)'}\n"]
        md += [format_post_md(c) for c in done]
        (self.out / "posts.md").write_text("\n".join(md))
        manifest = {
            "source": str(self.src), "brief": o.brief, "tone": o.tone, "model": o.model,
            "clips": [c.to_dict() for c in done],
        }
        (self.out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))


def run(opts: Options) -> list[Clip]:
    t0 = time.time()
    p = Project(opts)
    p.prepare()
    clips = p.select()
    if not clips:
        log("no clips found")
        return []
    if opts.review:
        from .review import serve
        serve(p, port=opts.port)
        return p.clips
    if opts.select_only:
        log(f"selection written to {p.state_path}; edit it and re-run with --clips, or use --review")
        return clips
    try:
        p.ensure_copy(clips)
    except Exception as e:  # copy failure should not lose the renders
        log(f"post copy failed: {e}")
    for c in clips:
        c.status = "approved"
        p.render(c)
    p.write_summary()
    log(f"done: {len(clips)} clips in {p.out} ({time.time() - t0:.0f}s)")
    return clips
