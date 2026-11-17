"""Find clippable moments with Claude and snap them to clean boundaries."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .captions import FX_STYLES, PRESETS

GENERIC_STYLES = [k for k in PRESETS if k not in FX_STYLES]  # channel signature styles are set per project
from .llm import structured_call
from .transcript import Transcript, Word


@dataclass
class Clip:
    start: float              # earliest source time used (for sorting / display)
    end: float                # latest source time used
    title: str
    hook: str = ""
    rationale: str = ""
    score: int = 50
    style: str = ""  # caption preset; "" means default
    index: int = 0
    copy: dict = field(default_factory=dict)
    status: str = "pending"   # pending | approved | rejected (review UI)
    file: str = ""            # rendered mp4 name, relative to the output dir
    render_sig: str = ""      # settings the current file was rendered with
    copy_sig: str = ""        # clip text the current copy was written for
    layout: str = ""          # human-readable reframing summary
    posts: dict = field(default_factory=dict)  # platform -> {url, posted_at}
    # Source intervals in playback order. Empty = the single span start..end.
    # A cold open plays the payoff first; a stitched clip joins 2-3 parts.
    segments: list = field(default_factory=list)
    kind: str = "single"      # single | cold_open | stitched
    emphasis: list = field(default_factory=list)   # key words to emphasise in captions
    alt_hooks: list = field(default_factory=list)  # alternative hooks for variants
    variant_of: int = 0       # index of the clip this is a variant of
    rating: str = ""          # "" | top | flop  (feeds back into selection)
    rated_text: str = ""      # transcript snapshot taken when rated
    out_duration: float = 0.0  # rendered length after tightening + end card

    def parts(self) -> list[tuple[float, float]]:
        if self.segments and len(self.segments) > 1:
            return [(float(a), float(b)) for a, b in self.segments]
        return [(self.start, self.end)]

    def set_parts(self, parts: list[tuple[float, float]]) -> None:
        parts = [(round(a, 3), round(b, 3)) for a, b in parts if b - a > 0.2]
        if not parts:
            return
        self.segments = [list(p) for p in parts] if len(parts) > 1 else []
        self.start = min(a for a, _ in parts)
        self.end = max(b for _, b in parts)
        if len(parts) == 1:
            self.kind = "single"

    @property
    def duration(self) -> float:
        return sum(b - a for a, b in self.parts())

    @property
    def slug(self) -> str:
        s = re.sub(r"[^a-z0-9]+", "-", self.title.lower()).strip("-")
        return f"clip{self.index:02d}-{s[:40].rstrip('-') or 'untitled'}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["duration"] = round(self.duration, 2)
        d["slug"] = self.slug
        d["parts"] = [list(p) for p in self.parts()]
        return d


SELECTION_SYSTEM = """\
You are a senior short-form video editor who finds the moments in long-form \
content that perform on TikTok, YouTube Shorts, Instagram Reels and X.

What makes a clip work:
- The first 1-3 seconds hook the viewer: a bold claim, a question, a surprising \
fact, tension, or an emotional beat. Never start on filler ("so", "um", "yeah, \
and", "like I said").
- It is self-contained: a viewer with zero context understands it. No dangling \
references to "that thing earlier" or setup that happens outside the clip.
- It has a payoff: a punchline, insight, reveal, strong opinion, or story \
resolution, and it ends on that beat rather than trailing into the next topic.
- It starts at the beginning of a sentence and ends at the end of one.
- It matches the creator's brief (topic, tone, audience) given below. A moment \
that is great in general but off-brief should score lower than an on-brief one.
- Controversial, provocative, heated, emotional or profane moments are fair game \
and are often the strongest clips: hot takes, arguments, people pushing back on \
each other, blunt opinions. Do not avoid or soften them. The one limit is \
honesty: the clip must not misrepresent what the speaker meant, so include \
enough of the exchange that the point survives being cut out of context.

Transcript format: each line is "[start-end] text" in seconds. Some lines carry \
audio cues measured from the recording: LOUD (noticeably louder than usual: \
shouting, laughing, crowd reaction), FAST (talking much faster than usual: \
excitement, heated exchange), PAUSE (a long silence before the line: tension, \
a reaction, a beat before a punchline). Treat these as hints about energy, not as proof of quality.

Clip structures (field "kind"):
- single: one continuous span. Most clips should be this.
- cold_open: the payoff line first (3-8 s), then cut back to the setup that \
leads up to it. Segment 1 is the payoff, segment 2 the setup. Only when the \
payoff is strong and understandable on its own before the setup.
- stitched: 2-3 non-contiguous parts of the same discussion, in chronological \
order, that together make one coherent point while skipping a tangent or a dull \
stretch. Each part at least 3 s. Never stitch in a way that changes what was \
meant.
Segment times must come from the transcript timestamps. The total length (sum \
of segments) must respect the length limits given.

For each clip also give:
- emphasis: 2-6 words or short phrases from the clip that carry the punch (the \
words a viewer should notice in the captions). Copy them exactly as spoken.
- alt_hooks: two alternative on-screen hooks with a different angle, for A/B \
variants.
- style: the caption style that best fits the content:
{styles}

Score each candidate 1-100 for how likely it is to perform AND fit the brief. \
Return candidates sorted best first. Prefer variety: do not return several \
clips that make the same point.\
"""

SELECTION_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["single", "cold_open", "stitched"]},
                    "segments": {
                        "type": "array",
                        "description": "Source spans in playback order (1 for single, 2-3 otherwise)",
                        "items": {
                            "type": "object",
                            "properties": {"start": {"type": "number"}, "end": {"type": "number"}},
                            "required": ["start", "end"], "additionalProperties": False,
                        },
                    },
                    "title": {"type": "string", "description": "Internal working title, <= 8 words"},
                    "hook": {"type": "string", "description": "On-screen hook headline, <= 8 words, no hashtags"},
                    "alt_hooks": {"type": "array", "items": {"type": "string"}},
                    "emphasis": {"type": "array", "items": {"type": "string"}},
                    "rationale": {"type": "string", "description": "One sentence: why this works and fits the brief"},
                    "score": {"type": "integer", "description": "1-100"},
                    "style": {"type": "string", "enum": GENERIC_STYLES},
                },
                "required": ["kind", "segments", "title", "hook", "alt_hooks", "emphasis",
                             "rationale", "score", "style"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["clips"],
    "additionalProperties": False,
}


def render_transcript(t: Transcript, cues: dict | None = None) -> str:
    cues = cues or {}
    lines = []
    for i, s in enumerate(t.segments):
        tags = cues.get(str(i)) or cues.get(i) or []
        tag = f" {{{','.join(tags)}}}" if tags else ""
        lines.append(f"[{s.start:.1f}-{s.end:.1f}]{tag} {s.text}")
    return "\n".join(lines)


def examples_block(examples: list[dict]) -> str:
    """Past clips the creator marked as top performers or flops."""
    if not examples:
        return ""
    tops = [e for e in examples if e["rating"] == "top"][:8]
    flops = [e for e in examples if e["rating"] == "flop"][:5]
    out = ["<past_results>",
           "The creator marked these earlier clips from this project. Learn what this audience "
           "responds to (topics, energy, structure, length, hook style) and favour similar "
           "moments; avoid what the flops have in common. Do not re-use these exact moments."]
    for tag, group in (("top_performer", tops), ("flop", flops)):
        for e in group:
            out.append(f'<{tag} kind="{e["kind"]}" length="{e["duration"]:.0f}s" style="{e["style"]}">\n'
                       f"hook: {e['hook']}\ntranscript: {e['text'][:1200]}\n</{tag}>")
    out.append("</past_results>")
    return "\n".join(out)


def find_moments(t: Transcript, *, brief: str, tone: str, count: int,
                 min_len: float, max_len: float, target_len: float | None,
                 model: str, effort: str, cues: dict | None = None,
                 examples: list[dict] | None = None, batch: bool = False) -> list[Clip]:
    target = f"Aim for about {target_len:.0f}s per clip. " if target_len else ""
    # The transcript goes first and is cached, so "find again" and repeat runs
    # on the same source only pay full price for the short instructions after it.
    transcript_block = f"<transcript>\n{render_transcript(t, cues)}\n</transcript>"
    instructions = "\n\n".join(x for x in (
        f"<creator_brief>\n{brief or 'Find the most engaging, shareable moments.'}\n</creator_brief>\n"
        f"<tone>{tone or 'Match the speaker.'}</tone>",
        examples_block(examples or []),
        f"Return the best {count * 2} candidate clips from the transcript above (I will keep the "
        f"top {count}). Each clip's total length should be between {min_len:.0f} and {max_len:.0f} "
        f"seconds. Most good clips land around 20-60 s, but let a clip run longer when the moment "
        f"needs it to land. Every clip must end at the end of a sentence, on the payoff, never "
        f"mid-thought. {target}",
    ) if x)
    content = [
        {"type": "text", "text": transcript_block, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": instructions},
    ]
    styles = "\n".join(f"- {k}: {PRESETS[k].description}" for k in GENERIC_STYLES)
    data = structured_call(system=SELECTION_SYSTEM.format(styles=styles), user=content,
                           schema=SELECTION_SCHEMA, model=model, effort=effort, batch=batch)
    out = []
    for c in data["clips"]:
        segs = [(float(s["start"]), float(s["end"])) for s in c["segments"] if s["end"] > s["start"]]
        if not segs:
            continue
        clip = Clip(start=min(a for a, _ in segs), end=max(b for _, b in segs), title=c["title"],
                    hook=c["hook"], rationale=c["rationale"], score=int(c["score"]), style=c["style"],
                    kind=c["kind"] if len(segs) > 1 else "single",
                    emphasis=[e for e in c["emphasis"] if e.strip()][:8],
                    alt_hooks=[h for h in c["alt_hooks"] if h.strip()][:3])
        clip.set_parts(segs)
        out.append(clip)
    return out


# ---------------------------------------------------------------------------
# Boundary refinement
# ---------------------------------------------------------------------------

PAUSE = 0.6
FILLERS = {"um", "uh", "erm", "hmm", "so", "and", "like", "yeah", "okay", "ok", "but"}


def _norm(w: Word) -> str:
    return re.sub(r"[^\w']", "", w.text.lower())


def _sentence_starts(words: list[Word]) -> set[int]:
    out = {0}
    for i in range(1, len(words)):
        if words[i - 1].text[-1:] in ".?!" or words[i].start - words[i - 1].end > PAUSE:
            out.add(i)
    return out


def _sentence_ends(words: list[Word]) -> set[int]:
    out = {len(words) - 1}
    for i in range(len(words) - 1):
        if words[i].text[-1:] in ".?!" or words[i + 1].start - words[i].end > PAUSE:
            out.add(i)
    return out


def refine(clip: Clip, t: Transcript, min_len: float, max_len: float) -> Clip | None:
    parts = clip.parts()
    if len(parts) == 1:
        return _refine_span(clip, t, min_len, max_len)
    # Multi-part: snap each part to sentence boundaries without changing its length much.
    snapped = []
    for a, b in parts:
        tmp = Clip(start=a, end=b, title="")
        r = _refine_span(tmp, t, max(1.5, (b - a) * 0.6), max((b - a) * 1.4, b - a + 3))
        if r is None:
            return None
        snapped.append((r.start, r.end))
    if clip.kind == "stitched":
        snapped.sort()
        merged = [snapped[0]]
        for a, b in snapped[1:]:
            if a <= merged[-1][1] + 0.3:  # overlapping/adjacent parts: just one span
                merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
            else:
                merged.append((a, b))
        snapped = merged
    total = sum(b - a for a, b in snapped)
    if total > max_len * 1.1 or total < min_len * 0.75:
        return None
    clip.set_parts(snapped)
    if len(clip.parts()) == 1:
        clip.kind = "single"
    return clip


def _refine_span(clip: Clip, t: Transcript, min_len: float, max_len: float) -> Clip | None:
    W = t.words
    if not W:
        return None
    starts, ends = _sentence_starts(W), _sentence_ends(W)

    # Start: nearest sentence start within 2.5s, else first word at/after start.
    near = [i for i in starts if abs(W[i].start - clip.start) <= 2.5]
    if near:
        si = min(near, key=lambda i: abs(W[i].start - clip.start))
    else:
        si = next((i for i, w in enumerate(W) if w.start >= clip.start - 0.25), None)
        if si is None:
            return None
    # Drop a leading filler word ("So, ...") if the next word follows closely.
    if _norm(W[si]) in FILLERS and si + 1 < len(W) and W[si + 1].start - W[si].end < 0.3:
        if W[min(si + 6, len(W) - 1)].end - W[si + 1].start > 2:
            si += 1

    def dur(ei: int) -> float:
        return W[ei].end - W[si].start

    # Endings: always on a full sentence. Strong ends are . ? ! ; weak ends are
    # long pauses (used only when the transcript has no punctuation nearby).
    strong = sorted(i for i in range(si, len(W)) if W[i].text[-1:] in ".?!")
    weak = sorted(i for i in ends if i >= si)
    hard_max = max_len * 1.35  # finishing the thought beats hitting the limit

    def nearest(cands, target, lo=-4.0, hi=8.0):
        near = [i for i in cands if lo <= W[i].end - target <= hi]
        return min(near, key=lambda i: abs(W[i].end - target)) if near else None

    ei = nearest(strong, clip.end)
    if ei is None:
        ei = nearest(weak, clip.end)
    if ei is None:
        after = [i for i in strong if W[i].end >= clip.end]
        ei = after[0] if after else max(i for i in range(si, len(W)) if W[i].end <= clip.end + 0.25)
    if dur(ei) > max_len:
        fit = [i for i in strong if min_len <= dur(i) <= max_len]
        over = [i for i in strong if max_len < dur(i) <= hard_max]
        if fit:
            ei = max(fit)
        elif over:
            ei = min(over)
        else:
            fitw = [i for i in weak if min_len <= dur(i) <= max_len]
            if fitw:
                ei = max(fitw)
    if dur(ei) < min_len:
        longer = [i for i in strong if min_len <= dur(i) <= hard_max] or \
                 [i for i in weak if min_len <= dur(i) <= hard_max]
        if longer:
            ei = min(longer)
    if dur(ei) < min_len * 0.75 or dur(ei) > hard_max + 5:
        return None

    start = W[si].start - 0.12
    if si > 0:
        start = max(start, (W[si - 1].end + W[si].start) / 2)
    end = W[ei].end + 0.4
    if ei + 1 < len(W):
        end = min(end, max(W[ei].end + 0.05, W[ei + 1].start - 0.03))
    clip.start, clip.end = round(max(0.0, start), 3), round(end, 3)
    return clip


def dedupe(clips: list[Clip], max_overlap: float = 0.25) -> list[Clip]:
    kept: list[Clip] = []
    for c in sorted(clips, key=lambda c: -c.score):
        if all(overlap(c, k) <= max_overlap for k in kept):
            kept.append(c)
    return kept


def overlap(a: Clip, b: Clip) -> float:
    """Shared source time as a fraction of the shorter clip."""
    inter = sum(max(0.0, min(e1, e2) - max(s1, s2)) for s1, e1 in a.parts() for s2, e2 in b.parts())
    return inter / max(0.1, min(a.duration, b.duration))


def clip_from_dict(d: dict) -> Clip:
    known = {f for f in Clip.__dataclass_fields__}
    c = Clip(**{k: v for k, v in d.items() if k in known})
    if c.posts:  # older files stored manual stats; keep only the posted marks
        c.posts = {k: {x: v[x] for x in ("url", "posted_at") if x in v} for k, v in c.posts.items()}
    return c


def load_manual(path: Path) -> list[Clip]:
    """Load clips from JSON: a list of {start, end, title?, hook?, style?, segments?} objects."""
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        data = data.get("clips", [])
    out = []
    for i, c in enumerate(data, 1):
        out.append(Clip(
            start=float(c["start"]), end=float(c["end"]),
            title=c.get("title") or f"Clip {i}", hook=c.get("hook", ""),
            rationale=c.get("rationale", "manual"), score=int(c.get("score", 100 - i)),
            style=c.get("style", "") if c.get("style", "") in PRESETS else "",
        ))
        if c.get("segments"):
            out[-1].set_parts([(float(a), float(b)) for a, b in c["segments"]])
            out[-1].kind = c.get("kind", "stitched")
    return out
