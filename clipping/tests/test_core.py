"""Fast tests that need no network, model downloads or API key."""

from clipper.captions import build_ass, build_srt, chunk_words, get_style
from clipper.selection import Clip, dedupe, refine
from clipper.transcript import Transcript, Word, resegment


def make_transcript(text: str, wpm_gap: float = 0.08) -> Transcript:
    words, t = [], 0.5
    for w in text.split():
        d = 0.15 + 0.03 * len(w)
        words.append(Word(w, round(t, 3), round(t + d, 3)))
        t += d + (0.7 if w[-1] in ".?!" else wpm_gap)
    return Transcript("en", words, resegment(words))


TEXT = " ".join(
    f"Sentence number {i} has a few words and then it ends here." for i in range(40)
)


def test_refine_snaps_to_sentence_boundaries():
    t = make_transcript(TEXT)
    seg = t.segments[3]
    c = refine(Clip(seg.start + 0.7, seg.start + 20.3, "x"), t, 15, 60)
    assert c is not None
    first = next(w for w in t.words if w.start >= c.start)
    last = [w for w in t.words if w.end <= c.end][-1]
    assert first.text == "Sentence"
    assert last.text.endswith(".")
    assert 15 <= c.duration <= 60.5


def test_refine_enforces_max_length():
    t = make_transcript(TEXT)
    c = refine(Clip(t.words[0].start, t.words[-1].end, "x"), t, 15, 30)
    assert c is not None and c.duration <= 30.5


def test_refine_extends_short_clip():
    t = make_transcript(TEXT)
    seg = t.segments[5]
    c = refine(Clip(seg.start, seg.end, "x"), t, 15, 60)
    assert c is not None and c.duration >= 15


def test_dedupe_keeps_higher_score():
    a = Clip(0, 30, "a", score=90)
    b = Clip(5, 35, "b", score=50)
    d = Clip(40, 60, "d", score=10)
    kept = dedupe([b, a, d])
    assert [k.title for k in kept] == ["a", "d"]


def test_chunking_respects_limits():
    style = get_style("bold")
    t = make_transcript(TEXT)
    for chunk in chunk_words(t.words, style):
        assert len(chunk) <= style.max_words


def test_ass_contains_highlight_and_hook():
    t = make_transcript("Hello world. This is a test of captions.")
    ass = build_ass(t.words, get_style("bold"), hook="Big hook", duration=10)
    assert "Big hook" in ass
    assert "\\1c&H0000E5FF" in ass  # yellow highlight in ASS BGR order
    assert ass.count("Dialogue: 0,") == len(t.words)


def test_ass_escapes_override_braces():
    words = [Word("{evil}\\N", 0.0, 0.5)]
    ass = build_ass(words, get_style("clean"), duration=1)
    assert "{evil}" not in ass and "\\N" not in ass.split("[Events]")[1].split("Cap,,0,0,0,,")[1]


def test_srt_format():
    t = make_transcript("One two three. Four five six.")
    srt = build_srt(t.words, get_style("bold"))
    assert srt.startswith("1\n00:00:00,500 --> ")
