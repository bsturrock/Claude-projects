"""Find clippable moments with Claude and snap them to clean boundaries."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .captions import PRESETS
from .llm import structured_call
from .transcript import Transcript, Word


@dataclass
class Clip:
    start: float
    end: float
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

    @property
    def duration(self) -> float:
        return self.end - self.start

    @property
    def slug(self) -> str:
        s = re.sub(r"[^a-z0-9]+", "-", self.title.lower()).strip("-")
        return f"clip{self.index:02d}-{s[:40].rstrip('-') or 'untitled'}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["duration"] = round(self.duration, 2)
        d["slug"] = self.slug
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

Timestamps in the transcript are in seconds. Use them exactly; choose start and \
end values from the timestamps shown. Score each candidate 1-100 for how likely \
it is to perform AND fit the brief. Return candidates sorted best first. Prefer \
variety: do not return several clips that make the same point.

For each clip also choose the caption style that best fits its content:
{styles}\
"""

SELECTION_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number", "description": "Clip start, seconds"},
                    "end": {"type": "number", "description": "Clip end, seconds"},
                    "title": {"type": "string", "description": "Internal working title, <= 8 words"},
                    "hook": {"type": "string", "description": "On-screen hook headline, <= 8 words, no hashtags"},
                    "rationale": {"type": "string", "description": "One sentence: why this works and fits the brief"},
                    "score": {"type": "integer", "description": "1-100"},
                    "style": {"type": "string", "enum": list(PRESETS)},
                },
                "required": ["start", "end", "title", "hook", "rationale", "score", "style"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["clips"],
    "additionalProperties": False,
}


def render_transcript(t: Transcript) -> str:
    return "\n".join(f"[{s.start:.1f}-{s.end:.1f}] {s.text}" for s in t.segments)


def find_moments(t: Transcript, *, brief: str, tone: str, count: int,
                 min_len: float, max_len: float, target_len: float | None,
                 model: str, effort: str) -> list[Clip]:
    target = f"Aim for about {target_len:.0f}s per clip. " if target_len else ""
    user = (
        f"<creator_brief>\n{brief or 'Find the most engaging, shareable moments.'}\n</creator_brief>\n"
        f"<tone>{tone or 'Match the speaker.'}</tone>\n\n"
        f"Return the best {count * 2} candidate clips (I will keep the top {count}). "
        f"Each clip must be between {min_len:.0f} and {max_len:.0f} seconds long. {target}\n\n"
        f"<transcript>\n{render_transcript(t)}\n</transcript>"
    )
    styles = "\n".join(f"- {k}: {v.description}" for k, v in PRESETS.items())
    data = structured_call(system=SELECTION_SYSTEM.format(styles=styles), user=user,
                           schema=SELECTION_SCHEMA, model=model, effort=effort)
    return [Clip(**c) for c in data["clips"]]


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

    near = [i for i in ends if i > si and abs(W[i].end - clip.end) <= 3.0]
    if near:
        ei = min(near, key=lambda i: abs(W[i].end - clip.end))
    else:
        cands = [i for i in range(si, len(W)) if W[i].end <= clip.end + 0.25]
        ei = cands[-1] if cands else si

    if dur(ei) > max_len:
        fit = [i for i in ends if si < i and min_len <= dur(i) <= max_len]
        ei = max(fit) if fit else max(i for i in range(si, len(W)) if dur(i) <= max_len)
    if dur(ei) < min_len:
        fit = sorted(i for i in ends if i > ei and min_len <= dur(i) <= max_len)
        if fit:
            ei = fit[0]
        else:
            longer = [i for i in range(ei, len(W)) if dur(i) <= max_len]
            ei = longer[-1]
    if dur(ei) < min_len * 0.75:
        return None  # source too short around this moment

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
        ok = True
        for k in kept:
            inter = min(c.end, k.end) - max(c.start, k.start)
            if inter > 0 and inter / min(c.duration, k.duration) > max_overlap:
                ok = False
                break
        if ok:
            kept.append(c)
    return kept


def clip_from_dict(d: dict) -> Clip:
    known = {f for f in Clip.__dataclass_fields__}
    return Clip(**{k: v for k, v in d.items() if k in known})


def load_manual(path: Path) -> list[Clip]:
    """Load clips from JSON: a list of {start, end, title?, hook?} objects."""
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
    return out
