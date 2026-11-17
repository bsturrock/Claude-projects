"""Word-by-word animated captions as ASS subtitles (burned in by ffmpeg/libass)."""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from .transcript import Word

FONTS_DIR = Path(__file__).parent / "fonts"


@dataclass
class CaptionStyle:
    font: str = "Poppins Black"
    size: int = 96
    color: str = "#FFFFFF"
    highlight: str = "#FFE500"
    outline_color: str = "#000000"
    outline: float = 7
    shadow: float = 3
    uppercase: bool = True
    max_words: int = 3
    max_chars: int = 16
    pop: bool = True
    y: float = 0.70  # vertical centre of the caption block, fraction of frame height
    letter_spacing: float = 0


PRESETS: dict[str, CaptionStyle] = {
    # Big, punchy, all caps, yellow active word. The default TikTok look.
    "bold": CaptionStyle(),
    # Mixed case, slightly smaller, green active word, more words per line.
    "clean": CaptionStyle(font="Poppins ExtraBold", size=70, highlight="#3DFF8B",
                          uppercase=False, max_words=4, max_chars=24, outline=6, shadow=2),
    # Tall condensed type, magazine style.
    "impact": CaptionStyle(font="Anton", size=104, highlight="#FF3B5C", max_words=3,
                           max_chars=16, outline=6, shadow=0, letter_spacing=1),
    # Subtle: white only, no highlight or pop, for serious/educational content.
    "minimal": CaptionStyle(font="Poppins ExtraBold", size=62, highlight="#FFFFFF",
                            uppercase=False, max_words=5, max_chars=30, outline=5,
                            shadow=0, pop=False, y=0.74),
}


def get_style(name: str, **overrides) -> CaptionStyle:
    if name not in PRESETS:
        raise ValueError(f"Unknown caption style {name!r}. Options: {', '.join(PRESETS)}")
    return replace(PRESETS[name], **{k: v for k, v in overrides.items() if v is not None})


def _ass_color(hex_color: str, alpha: int = 0) -> str:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"Bad colour {hex_color!r}; use #RRGGBB")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _ts(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _clean(text: str) -> str:
    return text.replace("\\", "/").replace("{", "(").replace("}", ")")


def chunk_words(words: list[Word], style: CaptionStyle) -> list[list[Word]]:
    chunks: list[list[Word]] = []
    cur: list[Word] = []
    for i, w in enumerate(words):
        if cur:
            chars = sum(len(x.text) + 1 for x in cur) + len(w.text)
            gap = w.start - cur[-1].end
            prev_punct = cur[-1].text[-1:] in ".?!" or (cur[-1].text[-1:] in ",;:" and len(cur) >= 2)
            if len(cur) >= style.max_words or chars > style.max_chars or gap > 0.5 or prev_punct:
                chunks.append(cur)
                cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return chunks


def build_ass(words: list[Word], style: CaptionStyle, *, hook: str = "",
              hook_mode: str = "intro", hook_secs: float = 3.5, duration: float = 0.0,
              y: float | None = None) -> str:
    """Words must already be relative to the clip start."""
    y_px = int(1920 * (y if y is not None else style.y))
    primary = _ass_color(style.color)
    hl = _ass_color(style.highlight)
    oc = _ass_color(style.outline_color)
    back = _ass_color("#000000", 0x80)

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{style.font},{style.size},{primary},{hl},{oc},{back},0,0,0,0,100,100,{style.letter_spacing},0,1,{style.outline},{style.shadow},5,70,70,0,1
Style: Hook,Poppins ExtraBold,68,&H00111111,&H00111111,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,18,0,5,90,90,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines: list[str] = []

    if hook and hook_mode != "off":
        end = duration if hook_mode == "full" else min(hook_secs, duration or hook_secs)
        fade = "" if hook_mode == "full" else r"\fad(150,250)"
        lines.append(
            f"Dialogue: 1,{_ts(0)},{_ts(end)},Hook,,0,0,0,,"
            f"{{\\pos(540,{int(1920 * 0.15)}){fade}}}{_clean(hook)}"
        )

    chunks = chunk_words(words, style)
    for ci, chunk in enumerate(chunks):
        nxt = chunks[ci + 1][0].start if ci + 1 < len(chunks) else None
        chunk_end = chunk[-1].end + 0.25
        if nxt is not None:
            chunk_end = nxt if nxt - chunk[-1].end < 0.6 else min(chunk_end, nxt)
        if duration:
            chunk_end = min(chunk_end, duration)
        texts = [_clean(w.text.upper() if style.uppercase else w.text) for w in chunk]
        for wi, w in enumerate(chunk):
            start = w.start if wi else chunk[0].start
            end = chunk[wi + 1].start if wi + 1 < len(chunk) else chunk_end
            if end <= start:
                continue
            parts = []
            for j, t in enumerate(texts):
                parts.append(f"{{\\1c{hl}}}{t}{{\\1c{primary}}}" if j == wi else t)
            tag = f"\\pos(540,{y_px})"
            if style.pop and wi == 0:
                tag += r"\fscx82\fscy82\t(0,110,\fscx100\fscy100)"
            lines.append(f"Dialogue: 0,{_ts(start)},{_ts(end)},Cap,,0,0,0,,{{{tag}}}" + " ".join(parts))

    return header + "\n".join(lines) + "\n"


def build_srt(words: list[Word], style: CaptionStyle) -> str:
    out = []
    for i, chunk in enumerate(chunk_words(words, replace(style, max_words=7, max_chars=42)), 1):
        def ts(t: float) -> str:
            ms = int(round(max(0, t) * 1000))
            h, ms = divmod(ms, 3600000)
            m, ms = divmod(ms, 60000)
            s, ms = divmod(ms, 1000)
            return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
        out.append(f"{i}\n{ts(chunk[0].start)} --> {ts(chunk[-1].end)}\n"
                   + " ".join(w.text for w in chunk) + "\n")
    return "\n".join(out)
