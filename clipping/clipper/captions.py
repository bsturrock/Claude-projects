"""Word-by-word animated captions as ASS subtitles (burned in by ffmpeg/libass)."""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from pathlib import Path

from .transcript import Word

FONTS_DIR = Path(__file__).parent / "fonts"


@dataclass
class CaptionStyle:
    font: str = "Poppins Black"
    size: int = 128
    color: str = "#FFFFFF"
    highlight: str = "#FFE500"
    palette: tuple = ()          # if set, highlight colour rotates per caption chunk
    outline_color: str = "#000000"
    outline: float = 9
    shadow: float = 4
    blur: float = 0              # soft edge on outline/shadow
    uppercase: bool = True
    max_words: int = 5
    max_chars: int = 24
    pop: bool = True             # chunk scales in when it appears
    bounce: bool = False         # overshoot on the pop
    active_scale: int = 100      # % size of the word being spoken
    tilt: float = 0              # max random rotation per chunk, degrees
    fade_ms: int = 0             # fade-in per chunk (instead of pop)
    y: float = 0.70              # vertical centre of the caption block, fraction of frame height
    letter_spacing: float = 0
    box: bool = False            # translucent box behind the text instead of an outline
    box_alpha: int = 0x50        # 0 = opaque, 255 = invisible
    word_gap: int = 1            # extra hard spaces between words (tight display fonts)
    emph_color: str = "#3DFF8B"  # colour of emphasised key words when not being spoken
    emph_scale: int = 110        # % size of emphasised words
    description: str = ""


PRESETS: dict[str, CaptionStyle] = {
    "bold": CaptionStyle(
        word_gap=2,
        description="Big all-caps sans, yellow active word, pop-in. Hot takes, commentary, "
                    "podcasts, motivation, most viral talking-head content.",
    ),
    "playful": CaptionStyle(
        font="Lilita One", size=100, emph_color="#FFFFFF", emph_scale=118, palette=("#FFE500", "#3DF5FF", "#FF5FD8", "#8CFF4F"),
        outline=9, shadow=5, max_words=5, max_chars=24, bounce=True, word_gap=2, active_scale=114, tilt=4,
        description="Chunky rounded type, colour-cycling active word, bounce and tilt. Gaming, "
                    "streams, comedy, reactions, entertainment, lighthearted chaos.",
    ),
    "editorial": CaptionStyle(
        font="DM Serif Display", size=112, highlight="#F5C451", outline=4, shadow=3, blur=2,
        emph_color="#F5C451", emph_scale=100, uppercase=False, max_words=7, max_chars=36, pop=False,
        fade_ms=90, y=0.72,
        description="Elegant serif, sentence case, gold active word, soft shadow and fade. News, politics, "
                    "business, finance, history, documentary, serious or emotional moments.",
    ),
    "clean": CaptionStyle(
        font="Poppins ExtraBold", size=112, highlight="#3DFF8B", emph_color="#FFE500", outline=8, shadow=3, word_gap=2,
        uppercase=False, max_words=6, max_chars=32,
        description="Modern sans, sentence case, green active word. Education, how-to, tech, "
                    "science, interviews, calm explainers.",
    ),
}
# Signature channel styles, drawn by captions_fx (not libass). Listed here so
# they can be chosen like any other style.
PRESETS["yap"] = CaptionStyle(
    font="Lilita One",
    description="Yap signature: lowercase words in a yellow speech bubble with a lightning tail; "
                "words fill in as spoken, key words flip into black pills.")
PRESETS["framebite"] = CaptionStyle(
    font="DM Serif Display",
    description="Framebite signature: cinematic serif subtitles with a teal underline that glides "
                "word to word; key words turn teal.")
FX_STYLES = {"yap", "framebite"}
DEFAULT_STYLE = "bold"


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


PROFANITY = {
    "fuck", "fucking", "fucked", "fucker", "fuckin", "motherfucker", "motherfucking", "shit", "shitty",
    "bullshit", "bitch", "bitches", "cunt", "asshole", "dick", "dickhead", "pussy", "cock", "bastard",
    "whore", "slut", "nigga", "nigger", "faggot", "retard", "retarded",
}


def _key(t: str) -> str:
    return re.sub(r"[^\w']", "", t.lower())


def mask_word(text: str) -> str:
    """f**k-style masking that keeps punctuation: 'fucking,' -> 'f*****g,'."""
    m = re.match(r"^(\W*)(.*?)(\W*)$", text)
    pre, core, post = m.groups() if m else ("", text, "")
    if _key(core) not in PROFANITY or len(core) < 3:
        return text
    return pre + core[0] + "*" * (len(core) - 2) + core[-1] + post


def emphasis_keys(phrases: list[str]) -> set[str]:
    stop = {"the", "a", "an", "and", "or", "to", "of", "in", "on", "is", "it", "that", "this", "i",
            "you", "we", "they", "he", "she", "be", "are", "was", "for", "with", "at", "as", "so"}
    out = set()
    for p in phrases or []:
        for t in p.split():
            k = _key(t)
            if k and k not in stop:
                out.add(k)
    return out


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
              y: float | None = None, emphasis: list[str] | None = None,
              mask_profanity: bool = False) -> str:
    """Words must already be relative to the clip start (output timeline)."""
    emph = emphasis_keys(emphasis or [])
    em_c = _ass_color(style.emph_color)
    y_px = int(1920 * (y if y is not None else style.y))
    primary = _ass_color(style.color)
    hl = _ass_color(style.highlight)
    oc = _ass_color(style.outline_color)
    box_c = _ass_color(style.outline_color, style.box_alpha)
    # With a box, the text layer has no border and a separate layer draws one
    # box per line (per-run boxes would overlap and leave seams).
    text_outline = 0 if style.box else style.outline
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
Style: Cap,{style.font},{style.size},{primary},{hl},{oc},{back},0,0,0,0,100,100,{style.letter_spacing},0,1,{text_outline},{style.shadow},5,70,70,0,1
Style: CapBox,{style.font},{style.size},&HFF000000,&HFF000000,{box_c},&HFF000000,0,0,0,0,100,100,{style.letter_spacing},0,3,{style.outline},0,5,70,70,0,1
Style: Hook,Poppins ExtraBold,104,&H00111111,&H00111111,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,18,0,5,90,90,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines: list[str] = []

    if hook and hook_mode != "off":
        end = duration if hook_mode == "full" else min(hook_secs, duration or hook_secs)
        fade = "" if hook_mode == "full" else r"\fad(150,250)"
        lines.append(
            f"Dialogue: 1,{_ts(0)},{_ts(end)},Hook,,0,0,0,,"
            f"{{\\pos(540,{int(1920 * 0.14)}){fade}}}{_clean(hook)}"
        )

    import random
    rng = random.Random(len(words))  # deterministic per clip
    chunks = chunk_words(words, style)
    for ci, chunk in enumerate(chunks):
        nxt = chunks[ci + 1][0].start if ci + 1 < len(chunks) else None
        chunk_end = chunk[-1].end + 0.25
        if nxt is not None:
            chunk_end = nxt if nxt - chunk[-1].end < 0.6 else min(chunk_end, nxt)
        if duration:
            chunk_end = min(chunk_end, duration)
        texts = [_clean((mask_word(w.text) if mask_profanity else w.text).upper() if style.uppercase
                        else (mask_word(w.text) if mask_profanity else w.text)) for w in chunk]
        is_em = [_key(w.text) in emph for w in chunk]
        hl_c = _ass_color(style.palette[ci % len(style.palette)]) if style.palette else hl
        tilt = round(rng.uniform(-style.tilt, style.tilt), 1) if style.tilt else 0
        for wi, w in enumerate(chunk):
            start = w.start if wi else chunk[0].start
            end = chunk[wi + 1].start if wi + 1 < len(chunk) else chunk_end
            if end <= start:
                continue
            parts = []
            for j, t in enumerate(texts):
                if j == wi:
                    # skip the active-word scale on a chunk's first event so its
                    # inline reset doesn't cancel the whole-line pop animation
                    animated = wi == 0 and (style.bounce or style.pop)
                    sc = (f"\\fscx{style.active_scale}\\fscy{style.active_scale}"
                          if style.active_scale != 100 and not animated else "")
                    if is_em[j] and not sc and style.emph_scale != 100 and not animated:
                        sc = f"\\fscx{style.emph_scale}\\fscy{style.emph_scale}"
                    reset = "\\fscx100\\fscy100" if sc else ""
                    parts.append(f"{{\\1c{hl_c}{sc}}}{t}{{\\1c{primary}{reset}}}")
                elif is_em[j]:
                    animated = wi == 0 and (style.bounce or style.pop)
                    sc = (f"\\fscx{style.emph_scale}\\fscy{style.emph_scale}"
                          if style.emph_scale != 100 and not animated else "")
                    reset = "\\fscx100\\fscy100" if sc else ""
                    parts.append(f"{{\\1c{em_c}{sc}}}{t}{{\\1c{primary}{reset}}}")
                else:
                    parts.append(t)
            tag = f"\\pos(540,{y_px})"
            if tilt:
                tag += f"\\frz{tilt}"
            if style.blur:
                tag += f"\\blur{style.blur}"
            if wi == 0:
                if style.bounce:
                    tag += r"\fscx70\fscy70\t(0,90,\fscx112\fscy112)\t(90,170,\fscx100\fscy100)"
                elif style.pop:
                    tag += r"\fscx82\fscy82\t(0,110,\fscx100\fscy100)"
                elif style.fade_ms:
                    tag += f"\\fad({style.fade_ms},0)"
            sep = " " + "\\h" * (style.word_gap - 1) if style.word_gap > 1 else " "
            if style.box:
                lines.append(f"Dialogue: 0,{_ts(start)},{_ts(end)},CapBox,,0,0,0,,{{{tag}}}" + sep.join(texts))
            lines.append(f"Dialogue: 1,{_ts(start)},{_ts(end)},Cap,,0,0,0,,{{{tag}}}" + sep.join(parts))

    return header + "\n".join(lines) + "\n"


def build_srt(words: list[Word], style: CaptionStyle, mask_profanity: bool = False) -> str:
    if mask_profanity:
        words = [Word(mask_word(w.text), w.start, w.end) for w in words]
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
