"""Edit decision list: which slices of the source make up a clip, in order.

A clip is one or more parts (single span, cold open, stitched). With
`tighten`, each part is further cut into pieces that skip dead air and filler
words; alternate pieces get a slight punch-in zoom so the jump cuts read as
intentional.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .transcript import Word

FILLER = {"um", "uh", "umm", "uhh", "erm", "er", "ah", "hmm", "mm", "mhm"}
MAX_GAP = 0.80     # only silences (incl. um/uh) longer than this get shortened
LEAD = 0.15        # keep this much before the next word
TAIL = 0.25        # and this much after the last one: a shortened pause stays ~0.4 s
PUNCH = 1.0        # punch-in zoom on cuts (1.0 = off; 1.04 is subtle)
PUNCH_MIN_CUT = 1.0  # only punch in when a cut removes at least this many seconds
MIN_PIECE = 2.0    # never cut more often than this (seconds between cuts)


@dataclass
class Piece:
    src_start: float
    src_end: float
    part: int          # index into the clip's parts
    zoom: float = 1.0
    out_start: float = 0.0

    @property
    def dur(self) -> float:
        return self.src_end - self.src_start


def _norm(t: str) -> str:
    return re.sub(r"[^\w']", "", t.lower())


def is_filler(w: Word) -> bool:
    return _norm(w.text) in FILLER


def build_pieces(parts: list[tuple[float, float]], words: list[Word], fps: float,
                 tighten: bool) -> list[Piece]:
    pieces: list[Piece] = []
    for pi, (a, b) in enumerate(parts):
        if not tighten:
            pieces.append(Piece(a, b, pi))
            continue
        ws = [w for w in words if w.end > a and w.start < b and not is_filler(w)]
        if not ws:
            pieces.append(Piece(a, b, pi))
            continue
        runs: list[list[float]] = []
        cur = [max(a, ws[0].start - LEAD), ws[0].end]
        for prev, w in zip(ws, ws[1:]):
            if w.start - prev.end > MAX_GAP:
                cur[1] = min(prev.end + TAIL, w.start)
                runs.append(cur)
                cur = [max(cur[1], w.start - LEAD), w.end]
            else:
                cur[1] = w.end
        cur[1] = min(b, cur[1] + TAIL + 0.15)
        runs.append(cur)
        if runs[0][0] - a < 0.25:
            runs[0][0] = a
        # merge slivers into neighbours: very short pieces look like glitches
        merged: list[list[float]] = []
        for r in runs:
            if merged and (merged[-1][1] - merged[-1][0] < MIN_PIECE or r[0] - merged[-1][1] < 0.25):
                merged[-1][1] = r[1]
            else:
                merged.append(r)
        if len(merged) > 1 and merged[-1][1] - merged[-1][0] < MIN_PIECE:
            merged[-2][1] = merged.pop()[1]
        zoom_in = False
        for k, (s, e) in enumerate(merged):
            if k > 0 and s - merged[k - 1][1] >= PUNCH_MIN_CUT:
                zoom_in = not zoom_in  # big cut: switch framing so the jump reads as intentional
            pieces.append(Piece(s, e, pi, PUNCH if zoom_in else 1.0))

    # snap to the output frame grid so audio and video stay in sync over many cuts
    t = 0.0
    out: list[Piece] = []
    for p in pieces:
        n = max(1, round(p.dur * fps))
        p.src_end = p.src_start + n / fps
        p.out_start = t
        t += n / fps
        out.append(p)
    return out


def total_duration(pieces: list[Piece]) -> float:
    return sum(p.dur for p in pieces)


def map_words(pieces: list[Piece], words: list[Word], drop_fillers: bool) -> list[Word]:
    """Source-time words -> output-time words (words cut out are dropped)."""
    out: list[Word] = []
    for p in pieces:
        for w in words:
            if drop_fillers and is_filler(w):
                continue
            mid = (w.start + w.end) / 2
            if p.src_start <= mid < p.src_end:
                s = p.out_start + max(0.0, w.start - p.src_start)
                e = p.out_start + min(p.dur, w.end - p.src_start)
                out.append(Word(w.text, round(s, 3), round(max(e, s + 0.05), 3)))
    return out
