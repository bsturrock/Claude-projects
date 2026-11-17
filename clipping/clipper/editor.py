"""Editorial pass: make each clip one complete, well-cut thought.

Moment-finding works from a coarse transcript and gets the general area right.
This pass gives Claude each clip again with context on both sides, split into
numbered sentence units, and asks it to edit: start where the idea starts,
keep the setup the viewer needs, end right after the payoff, and cut tangents
in the middle when that keeps the meaning. It answers with unit ranges, so the
cuts land exactly on word boundaries.
"""

from __future__ import annotations

from dataclasses import dataclass

from .llm import structured_call
from .selection import Clip
from .transcript import Transcript, Word

CONTEXT = 75.0   # seconds of transcript shown before and after each clip (long thoughts need room)
MAX_UNIT = 7.0   # long run-on sentences are split at commas / pauses beyond this
LEAD, TAIL = 0.12, 0.35


@dataclass
class Unit:
    first: int   # word indices into Transcript.words (inclusive)
    last: int
    start: float
    end: float
    text: str


def units_between(t: Transcript, a: float, b: float) -> list[Unit]:
    """Sentence units (split further at commas/pauses when very long) covering [a, b]."""
    W = t.words
    idx = [i for i, w in enumerate(W) if w.end > a and w.start < b]
    if not idx:
        return []
    # extend to whole sentences at both ends
    lo, hi = idx[0], idx[-1]
    while lo > 0 and W[lo - 1].text[-1:] not in ".?!" and W[lo].start - W[lo - 1].end < 1.0:
        lo -= 1
    while hi < len(W) - 1 and W[hi].text[-1:] not in ".?!" and W[hi + 1].start - W[hi].end < 1.0:
        hi += 1
    units: list[Unit] = []
    cur = lo
    for i in range(lo, hi + 1):
        w = W[i]
        nxt = W[i + 1] if i + 1 < len(W) else None
        end_sentence = w.text[-1:] in ".?!"
        gap = (nxt.start - w.end) if nxt else 9.0
        long_unit = w.end - W[cur].start > MAX_UNIT
        soft_break = long_unit and (w.text[-1:] in ",;:" or gap > 0.35)
        if i == hi or end_sentence or gap > 0.8 or soft_break:
            ws = W[cur:i + 1]
            units.append(Unit(cur, i, ws[0].start, ws[-1].end, " ".join(x.text for x in ws)))
            cur = i + 1
    return units


EDIT_SYSTEM = """\
You are the editor who makes the final cut of short-form clips (TikTok, Shorts, \
Reels) from long-form talk. Another editor already found each moment; your job \
is to make each one a complete, coherent thought that a viewer with no context \
can follow, and to cut it tightly.

A complete thought:
- Starts where the idea starts. Never open on a dangling connector ("and so", \
"but that's why", "which means") or a reference to something the viewer hasn't \
seen ("like I said", "that guy"). If the idea needs its setup, include the setup.
- Contains the setup the viewer needs, the point, and the payoff (the \
conclusion, punchline, verdict or answer).
- Ends immediately after the payoff. Do not let it run into the next point, a \
new topic, a recap, or "anyway...". Do not stop before the point has landed.

Editing:
- The transcript is split into numbered units (sentences, or clauses of very \
long sentences) with timestamps. Choose which units to keep, as ranges.
- One range is a normal clip. Use more ranges only to cut a tangent, a \
repetition or a false start in the middle, and only if what remains still \
says exactly what the speaker meant. Ranges in chronological order = \
"stitched".
- "cold_open": the first range is a short payoff line (under ~8 s) taken from \
the end of the thought, then the second range plays the thought from its \
start. Only when the payoff hooks on its own. Keep a cold open if one was \
requested and it still works; otherwise use single or stitched.
- Length: aim inside the given limits, but a complete thought beats the limit. \
Go up to about 35% over the maximum if that is what it takes; if the thought \
genuinely needs far more, cut it down with ranges rather than ending early.
- If the moment cannot be made into a complete thought, set "usable" to false.\
"""

EDIT_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "clip": {"type": "integer"},
                    "usable": {"type": "boolean"},
                    "kind": {"type": "string", "enum": ["single", "cold_open", "stitched"]},
                    "ranges": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"first": {"type": "integer"}, "last": {"type": "integer"}},
                            "required": ["first", "last"], "additionalProperties": False,
                        },
                    },
                    "thought": {"type": "string", "description": "The complete thought in one sentence"},
                },
                "required": ["clip", "usable", "kind", "ranges", "thought"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["clips"],
    "additionalProperties": False,
}


def _block(n: int, c: Clip, units: list[Unit]) -> str:
    cur = ", ".join(f"{a:.1f}-{b:.1f}s" for a, b in c.parts())
    lines = [f'<clip n="{n}" title="{c.title}" current_kind="{c.kind}" current_spans="{cur}">']
    for k, u in enumerate(units):
        inside = any(u.end > a and u.start < b for a, b in c.parts())
        lines.append(f"U{k} [{u.start:.1f}-{u.end:.1f}]{' *' if inside else ''} {u.text}")
    lines.append("</clip>")
    return "\n".join(lines)


def _apply(c: Clip, units: list[Unit], t: Transcript, kind: str, ranges: list[dict],
           min_len: float, max_len: float) -> bool:
    W = t.words
    rs = []
    for r in ranges:
        a, b = int(r["first"]), int(r["last"])
        if not (0 <= a <= b < len(units)):
            return False
        rs.append((a, b))
    if not rs:
        return False
    if kind == "cold_open" and len(rs) >= 2 and rs[0][0] > rs[1][0]:
        pass  # payoff first, then the thought from its start
    else:
        rs.sort()
        merged = [rs[0]]
        for a, b in rs[1:]:
            if a <= merged[-1][1] + 1:  # touching ranges: one span
                merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
            else:
                merged.append((a, b))
        rs = merged
        kind = "single" if len(rs) == 1 else "stitched"
    parts = []
    for a, b in rs:
        fw, lw = units[a].first, units[b].last
        s = W[fw].start - LEAD
        if fw > 0:
            s = max(s, (W[fw - 1].end + W[fw].start) / 2)
        e = W[lw].end + TAIL
        if lw + 1 < len(W):
            e = min(e, max(W[lw].end + 0.05, W[lw + 1].start - 0.03))
        parts.append((max(0.0, s), e))
    total = sum(b - a for a, b in parts)
    if total < min_len * 0.6 or total > max_len * 1.45:
        return False
    c.set_parts(parts)
    c.kind = kind if len(parts) > 1 else "single"
    return True


def edit_clips(clips: list[Clip], t: Transcript, *, brief: str, tone: str, min_len: float,
               max_len: float, model: str, effort: str = "high", batch: bool = False) -> list[Clip]:
    """Re-cut clips as complete thoughts. Clips Claude marks unusable are dropped;
    clips it can't edit keep their current cut. Returns the clips to keep."""
    if not clips:
        return []
    unit_sets = []
    for c in clips:
        a = max(0.0, min(p[0] for p in c.parts()) - CONTEXT)
        b = max(p[1] for p in c.parts()) + CONTEXT
        unit_sets.append(units_between(t, a, b))
    user = "\n\n".join([
        f"<creator_brief>\n{brief or 'General audience.'}\n</creator_brief>\n<tone>{tone or 'Match the speaker.'}</tone>",
        f"Length limits: {min_len:.0f}-{max_len:.0f} s per clip (completeness first). Units marked * are in "
        f"the current cut. Return one entry per clip, using that clip's unit numbers.",
        *(_block(n, c, us) for n, (c, us) in enumerate(zip(clips, unit_sets))),
    ])
    data = structured_call(system=EDIT_SYSTEM, user=user, schema=EDIT_SCHEMA, model=model,
                           effort=effort, batch=batch)
    by_n = {e["clip"]: e for e in data["clips"]}
    keep = []
    for n, (c, us) in enumerate(zip(clips, unit_sets)):
        e = by_n.get(n)
        if e is None:
            keep.append(c)
            continue
        if not e["usable"]:
            continue
        if _apply(c, us, t, e["kind"], e["ranges"], min_len, max_len):
            c.rationale = (c.rationale + " | " if c.rationale else "") + e["thought"]
        keep.append(c)
    return keep
