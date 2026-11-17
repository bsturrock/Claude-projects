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
from .captions import DEFAULT_STYLE, FX_STYLES, PRESETS, build_ass, build_srt, get_style
from .copywriter import format_post_md, write_copy
from .llm import DEFAULT_MODEL
from .reframe import Plan, Shot, analyze
from .edit import build_pieces, map_words, total_duration
from .render import render_clip, thumbnail
from .selection import Clip, clip_from_dict, dedupe, find_moments, load_manual, refine
from .transcript import Transcript, Word, audio_cues, resegment, transcribe


@dataclass
class Options:
    source: str
    out_dir: Path = Path("out")
    brief: str = ""
    tone: str = ""
    count: int = 5
    min_len: float = 15.0
    max_len: float = 90.0
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
    out_override: Path | None = None  # studio: exact output folder for this source
    vocabulary: list = field(default_factory=list)  # names/terms to spell right
    tighten: bool = False         # cut silences + filler words, punch-in on cuts
    audio_clean: bool = False     # denoise, de-ess, compress voices
    brand: str = ""               # channel brand id for the end card ("" = no end card)
    mask_profanity: bool = False
    economy: bool = False         # Claude Batch API: half price, slower
    encoder: str = "auto"         # auto | videotoolbox | x264
    parallel: int = 2             # clips rendered at once
    framing: str = "auto"         # auto | tight | medium | wide
    examples: list = field(default_factory=list)  # rated past clips fed to selection


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
        self.on_progress = None  # callable(str) for UIs

    def note(self, msg: str) -> None:
        log(msg)
        if self.on_progress:
            self.on_progress(msg)

    # -- 1. ingest + transcribe ---------------------------------------------
    def prepare(self) -> None:
        o = self.opts
        media.require_tools()
        if media.is_url(o.source):
            self.note("downloading")
            dl = (o.out_override or o.out_dir) / "_downloads"
            src = media.download(o.source, dl)
        else:
            src = Path(o.source).expanduser()
            if not src.exists():
                raise FileNotFoundError(src)
        self.src = src
        self.info = media.probe(src)
        name = re.sub(r"[^A-Za-z0-9_-]+", "-", src.stem).strip("-")[:60] or "video"
        self.out = o.out_override or (o.out_dir / name)
        self.work = self.out / ".work"
        self.work.mkdir(parents=True, exist_ok=True)
        w, h = self.info.display_size
        log(f"source {src.name}: {w}x{h} @ {self.info.fps:.2f}fps, {self.info.duration / 60:.1f} min")

        if o.transcript_path:
            self.transcript = load_any_transcript(o.transcript_path)
        else:
            vkey = hashlib.sha1("|".join(o.vocabulary).encode()).hexdigest()[:6] if o.vocabulary else "nv"
            cache = self.work / f"transcript-{_file_key(src)}-{o.whisper_model}-{vkey}.json"
            legacy = self.work / f"transcript-{_file_key(src)}-{o.whisper_model}.json"
            if not cache.exists() and legacy.exists() and not o.vocabulary:
                cache = legacy
            if cache.exists():
                log("using cached transcript")
                self.transcript = Transcript.load(cache)
            else:
                if not self.info.has_audio:
                    raise media.MediaError("Source has no audio track to transcribe.")
                self.note("extracting audio")
                wav = media.extract_audio(src, self.work / "audio.wav")
                self.note(f"transcribing ({o.whisper_model})")
                self.transcript = transcribe(wav, o.whisper_model, o.language,
                                             progress=self.on_progress, vocabulary=o.vocabulary)
                self.transcript.save(cache)
                self._cues(wav, cache)
                wav.unlink(missing_ok=True)
            self.cues = self._cues(None, cache)
        log(f"transcript: {len(self.transcript.words)} words, language={self.transcript.language}")

    def _cues(self, wav: Path | None, transcript_cache: Path) -> dict:
        """Audio energy / pace cues for selection, cached next to the transcript."""
        path = transcript_cache.with_name(transcript_cache.stem + "-cues.json")
        if path.exists():
            return json.loads(path.read_text())
        if not self.info.has_audio:
            return {}
        tmp = None
        if wav is None or not wav.exists():
            self.note("measuring audio cues")
            tmp = wav = media.extract_audio(self.src, self.work / "cues.wav")
        cues = audio_cues(wav, self.transcript)
        path.write_text(json.dumps(cues))
        if tmp:
            tmp.unlink(missing_ok=True)
        return cues

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
            self.note("finding clips with Claude")
            cands = self.find_candidates()
            clips = dedupe(cands)[: o.count]
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

    def find_candidates(self) -> list[Clip]:
        o = self.opts
        cands = find_moments(
            self.transcript, brief=o.brief, tone=o.tone, count=o.count,
            min_len=o.min_len, max_len=o.max_len, target_len=o.target_len,
            model=o.model, effort=o.effort, cues=getattr(self, "cues", {}),
            examples=o.examples, batch=o.economy,
        )
        return [r for c in cands if (r := refine(c, self.transcript, o.min_len, o.max_len))]

    def save(self) -> None:
        with self.lock:
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps([c.to_dict() for c in self.clips], indent=2, ensure_ascii=False))
            tmp.replace(self.state_path)

    def clip_text(self, c: Clip) -> str:
        return " ... ".join(self.transcript.text_between(a, b) for a, b in c.parts())

    # -- 3. copy ------------------------------------------------------------
    def copy_sig(self, c: Clip) -> str:
        return hashlib.sha1(f"{c.parts()}|{c.title}|{c.hook}".encode()).hexdigest()[:10]

    def ensure_copy(self, clips: list[Clip], force: bool = False) -> None:
        o = self.opts
        if not o.write_post_copy:
            return
        todo = [c for c in clips if force or not c.copy or c.copy_sig != self.copy_sig(c)]
        if not todo:
            return
        self.note(f"writing post copy for {len(todo)} clip(s)")
        write_copy(todo, self.transcript, brief=o.brief, tone=o.tone, model=o.model, extra=o.copy_extra,
                   batch=o.economy)
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
        key = (f"{c.parts()}|{c.style}|{c.hook}|{c.emphasis}|{o.hook_mode}|{o.layout}|{o.two_shot}|"
               f"{o.crosstalk}|{o.use_asd}|{sorted(o.style_overrides.items())}|{o.crf}|{o.tighten}|"
               f"{o.audio_clean}|{o.brand}|{o.mask_profanity}|{o.framing}")
        return hashlib.sha1(key.encode()).hexdigest()[:10]

    def plan_for(self, a: float, b: float) -> Plan:
        o = self.opts
        w, h = self.info.display_size
        if o.layout in ("fit", "center"):
            return Plan(w, h, [Shot(0, b - a, o.layout)])
        return analyze(str(self.src), a, b, (w, h), fallback="fit", two_shot=o.two_shot,
                       use_asd=o.use_asd, crosstalk=o.crosstalk, framing=o.framing)

    def render(self, c: Clip, progress=None) -> Path:
        o = self.opts
        parts = c.parts()
        log(f"rendering {c.slug} ({c.duration:.1f}s, {c.kind}, {c.style})")
        if progress:
            progress("analysing speakers")
        plans = [self.plan_for(a, b) for a, b in parts]
        c.layout = " | ".join(p.describe() for p in plans)
        log(f"  layout: {c.layout}")
        fps = min(round(self.info.fps), 60) or 30
        src_words = [w for a, b in parts for w in self.transcript.words_between(a, b)]
        pieces = build_pieces(parts, src_words, fps, tighten=o.tighten)
        content = total_duration(pieces)
        if o.tighten:
            log(f"  tightened {c.duration:.1f}s -> {content:.1f}s in {len(pieces)} pieces")
        span_words = self.transcript.words_between(min(a for a, _ in parts), max(b for _, b in parts))
        words = map_words(pieces, span_words, drop_fillers=o.tighten)
        style = get_style(c.style or DEFAULT_STYLE, **o.style_overrides)
        cap_y = 0.5 if all(p.dominant_layout == "stack" for p in plans) else style.y
        ass_path = self.work / f"{c.slug}.ass"
        # signature styles are drawn per frame by captions_fx; the ASS file then only carries the hook
        ass_path.write_text(build_ass([] if c.style in FX_STYLES else words, style, hook=c.hook, hook_mode=o.hook_mode,
                                      duration=content, y=cap_y, emphasis=c.emphasis,
                                      mask_profanity=o.mask_profanity))
        (self.out / f"{c.slug}.srt").write_text(build_srt(words, style, o.mask_profanity))
        if progress:
            progress("encoding")
        # remove an older render of this clip under a different title
        if c.file and c.file != f"{c.slug}.mp4":
            for ext in (".mp4", ".jpg", ".srt", ".post.json"):
                (self.out / (Path(c.file).stem + ext)).unlink(missing_ok=True)
        mp4 = self.out / f"{c.slug}.mp4"
        overlay = None
        if c.style in FX_STYLES:
            from .captions_fx import FxCaptions
            fx = FxCaptions(c.style, words, c.emphasis, o.mask_profanity, duration=content,
                            y=0.5 if cap_y == 0.5 else None)
            overlay = fx.draw
        total = render_clip(self.info, parts, pieces, plans, ass_path, mp4, crf=o.crf, preset=o.preset,
                            loudnorm=o.loudnorm, audio_clean=o.audio_clean, brand=o.brand,
                            encoder=o.encoder, progress=progress, overlay=overlay)
        thumbnail(mp4, min(1.0, content / 3), self.out / f"{c.slug}.jpg")
        with self.lock:
            c.file = mp4.name
            c.render_sig = self.render_sig(c)
            c.out_duration = round(total, 2)
        self.save()
        return mp4

    def render_many(self, clips: list[Clip], on_start=None, on_done=None) -> None:
        """Render several clips, `parallel` at a time."""
        from concurrent.futures import ThreadPoolExecutor

        def one(c: Clip):
            if on_start:
                on_start(c)
            err = None
            try:
                self.render(c)
            except Exception as e:  # keep going with the other clips
                err = e
                log(f"render failed for {c.slug}: {e}")
            if on_done:
                on_done(c, err)

        with ThreadPoolExecutor(max_workers=max(1, self.opts.parallel)) as ex:
            list(ex.map(one, clips))

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
    p.render_many(clips)
    p.write_summary()
    log(f"done: {len(clips)} clips in {p.out} ({time.time() - t0:.0f}s)")
    return clips
