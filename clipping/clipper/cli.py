"""Command-line interface."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .captions import PRESETS
from .llm import DEFAULT_MODEL, LLMError
from .media import MediaError
from .pipeline import Options, run


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="clipper",
        description="Turn long-form video into captioned 9:16 clips with post copy.",
    )
    p.add_argument("source", help="Video file path or URL (YouTube, etc. via yt-dlp)")
    p.add_argument("-o", "--out", type=Path, default=Path("out"), help="Output root (default: out/)")

    g = p.add_argument_group("what to clip")
    g.add_argument("-b", "--brief", default="",
                   help="What you want: topic, audience, angle. e.g. 'Hot takes on AI startups for founders'")
    g.add_argument("-t", "--tone", default="", help="e.g. 'funny, irreverent' or 'calm, educational'")
    g.add_argument("-n", "--count", type=int, default=5, help="Number of clips (default 5)")
    g.add_argument("--min", dest="min_len", type=float, default=15, help="Min clip seconds (default 15)")
    g.add_argument("--max", dest="max_len", type=float, default=90,
                   help="Max clip seconds (default 90; clips still end on a sentence)")
    g.add_argument("--target", dest="target_len", type=float, help="Preferred clip length in seconds")
    g.add_argument("--clips", dest="clips_path", type=Path,
                   help="Skip AI selection: JSON list of {start, end, title, hook}")
    g.add_argument("--select-only", action="store_true",
                   help="Stop after selection and write clips.json")
    g.add_argument("-r", "--review", action="store_true",
                   help="Open the browser review UI after selection (trim, restyle, approve, render)")
    g.add_argument("--reselect", action="store_true",
                   help="With --review: ignore a saved clips.json and ask Claude again")
    g.add_argument("--port", type=int, default=8765, help="Review UI port (default 8765)")

    g = p.add_argument_group("look")
    g.add_argument("--style", choices=["auto", *PRESETS], default="auto",
                   help="Caption style. auto (default) lets Claude pick per clip: "
                        + "; ".join(f"{k} = {v.description.split('.')[0].lower()}" for k, v in PRESETS.items()))
    g.add_argument("--font", help="Override caption font family")
    g.add_argument("--font-size", type=int, help="Override caption font size (px at 1080x1920)")
    g.add_argument("--color", help="Caption colour, #RRGGBB")
    g.add_argument("--highlight", help="Active-word colour, #RRGGBB")
    g.add_argument("--caption-y", type=float, help="Caption vertical position, 0-1 (default 0.70)")
    g.add_argument("--words", type=int, help="Max words per caption chunk")
    g.add_argument("--hook-overlay", choices=["intro", "full", "off"], default="intro",
                   help="Show the hook headline at the top: first ~3.5s, whole clip, or never")
    g.add_argument("--layout", choices=["auto", "fit", "center"], default="auto",
                   help="auto = face tracking / split screen / fit per shot")
    g.add_argument("--two-shot", choices=["cut", "stack"], default="cut",
                   help="People too far apart for one crop: cut to whoever is speaking (default), "
                        "or permanent split screen")
    g.add_argument("--no-crosstalk-split", action="store_true",
                   help="Don't switch to split screen when people talk over each other")
    g.add_argument("--no-asd", action="store_true",
                   help="Disable active speaker detection (follow the largest face)")
    g.add_argument("--framing", choices=["auto", "tight", "medium", "wide"], default="auto",
                   help="How close to crop on the speaker; auto loosens it when faces are big")
    g.add_argument("--tighten", action="store_true",
                   help="Cut silences and filler words, with punch-in zooms on the cuts")
    g.add_argument("--clean-audio", action="store_true", help="Denoise, de-ess and compress voices")
    g.add_argument("--brand", default="", help="Channel brand for the end card (e.g. yap, framebite)")
    g.add_argument("--mask-profanity", action="store_true", help="Show f**k-style captions")

    g = p.add_argument_group("models")
    g.add_argument("--whisper-model", default="small",
                   help="faster-whisper size: tiny/base/small/medium/large-v3/large-v3-turbo")
    g.add_argument("--language", help="Force transcription language (e.g. en)")
    g.add_argument("--vocab", default="", help="Comma-separated names/terms to spell correctly")
    g.add_argument("--economy", action="store_true",
                   help="Use the Claude Batch API for selection and copy: half price, can be slower")
    g.add_argument("--transcript", dest="transcript_path", type=Path,
                   help="Use an existing word-timestamped transcript JSON instead of transcribing")
    g.add_argument("--model", default=DEFAULT_MODEL, help=f"Claude model (default {DEFAULT_MODEL})")
    g.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"], default="high",
                   help="Claude effort for moment selection")
    g.add_argument("--no-copy", action="store_true", help="Skip post copy generation")
    g.add_argument("--copy-notes", default="", help="Extra instructions for post copy (CTA, handles, links)")

    g = p.add_argument_group("encoding")
    g.add_argument("--crf", type=int, default=19, help="x264 quality (lower = better, default 19)")
    g.add_argument("--preset", default="medium", help="x264 preset (default medium)")
    g.add_argument("--no-loudnorm", action="store_true", help="Skip -14 LUFS loudness normalisation")
    g.add_argument("--encoder", choices=["auto", "videotoolbox", "x264"], default="auto",
                   help="auto uses the Mac hardware encoder when available")
    g.add_argument("--parallel", type=int, default=2, help="Clips rendered at once (default 2)")
    return p


def studio_main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="clipper studio",
                                description="Open Clip Studio, the local web workshop for projects and clips.")
    p.add_argument("--home", type=Path, default=Path("~/ClipStudio"),
                   help="Workspace folder for projects, sources and clips (default ~/ClipStudio)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-browser", action="store_true", help="Don't open a browser tab")
    p.add_argument("--parallel", type=int, default=2, help="Clips rendered at once (default 2)")
    a = p.parse_args(argv)
    from .studio import serve
    try:
        serve(a.home, port=a.port, open_browser=not a.no_browser, parallel=a.parallel)
    except MediaError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "studio":
        return studio_main(argv[1:])
    a = build_parser().parse_args(argv)
    if a.min_len >= a.max_len:
        print("--min must be less than --max", file=sys.stderr)
        return 2
    overrides = {"font": a.font, "size": a.font_size, "color": a.color,
                 "highlight": a.highlight, "y": a.caption_y, "max_words": a.words}
    opts = Options(
        source=a.source, out_dir=a.out, brief=a.brief, tone=a.tone, count=a.count,
        min_len=a.min_len, max_len=a.max_len, target_len=a.target_len,
        style=a.style, style_overrides=overrides, hook_mode=a.hook_overlay,
        layout=a.layout, two_shot=a.two_shot, crosstalk=not a.no_crosstalk_split,
        use_asd=not a.no_asd, whisper_model=a.whisper_model,
        language=a.language, transcript_path=a.transcript_path, clips_path=a.clips_path,
        write_post_copy=not a.no_copy, copy_extra=a.copy_notes, model=a.model,
        effort=a.effort, crf=a.crf, preset=a.preset, loudnorm=not a.no_loudnorm,
        select_only=a.select_only, review=a.review, reselect=a.reselect, port=a.port,
        tighten=a.tighten, audio_clean=a.clean_audio, brand=a.brand, mask_profanity=a.mask_profanity,
        vocabulary=[v.strip() for v in a.vocab.split(",") if v.strip()], economy=a.economy,
        encoder=a.encoder, parallel=a.parallel, framing=a.framing,
    )
    try:
        run(opts)
    except (LLMError, MediaError, FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
