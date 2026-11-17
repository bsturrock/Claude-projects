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
    assert ass.count(",Cap,,") == len(t.words)  # one text event per spoken word


def test_ass_escapes_override_braces():
    words = [Word("{evil}\\N", 0.0, 0.5)]
    ass = build_ass(words, get_style("clean"), duration=1)
    assert "{evil}" not in ass and "\\N" not in ass.split("[Events]")[1].split("Cap,,0,0,0,,")[1]


def test_srt_format():
    t = make_transcript("One two three. Four five six.")
    srt = build_srt(t.words, get_style("bold"))
    assert srt.startswith("1\n00:00:00,500 --> ")


def test_all_presets_build():
    from clipper.captions import PRESETS
    t = make_transcript("Hello world. This is a test of captions, with commas.")
    for name in PRESETS:
        ass = build_ass(t.words, get_style(name), hook="Hook", duration=10)
        assert "Style: Cap," in ass
        if PRESETS[name].box:
            assert "CapBox" in ass.split("[Events]")[1]


def test_mfcc_shape():
    import numpy as np
    from clipper.speaker import mfcc
    sig = (np.sin(np.arange(16000) / 5) * 8000).astype(np.int16)
    m = mfcc(sig)
    assert m.shape == (99, 13) and np.isfinite(m).all()


def test_choose_focus_switches_with_hysteresis():
    import numpy as np
    from clipper.reframe import choose_focus
    from clipper.speaker import Track
    n = 200
    frames = np.arange(n)
    boxes = np.tile([0, 0, 50, 50], (n, 1)).astype(float)
    a = Track(frames, boxes, scores=np.where(frames < 100, 3.0, -2.0))
    b = Track(frames, boxes + [500, 0, 500, 0], scores=np.where(frames < 100, -2.0, 3.0))
    # a brief blip from b early on should not cause a cut
    b.scores[30:36] = 4.0
    focus, _ = choose_focus([a, b], 0, n)
    assert focus[0] == 0 and focus[40] == 0
    assert focus[-1] == 1
    assert np.sum(np.diff(focus) != 0) == 1
    assert 95 <= np.argmax(focus == 1) <= 106


def test_studio_workspace_projects_and_posts(tmp_path):
    from clipper.studio import Workspace
    ws = Workspace(tmp_path)
    p = ws.create_project({"name": "Show", "brief": "hot takes", "count": 3})
    assert ws.project(p.id).brief == "hot takes"
    p2 = ws.update_project(p.id, {"min_len": 40, "max_len": 30, "style": "nope"})
    assert p2.max_len > p2.min_len and p2.style == "auto"
    c = Clip(0, 20, "t")
    Workspace._update_post(c, {"platform": "tiktok", "url": "https://x"})
    assert c.posts["tiktok"]["url"] == "https://x" and c.posts["tiktok"]["posted_at"]
    Workspace._update_post(c, {"platform": "tiktok", "remove": True})
    assert c.posts == {}
    assert [s["name"] for s in ws.summary()] == ["Show"]


def test_refine_ends_on_sentence_even_past_max():
    # one long sentence that runs past max: the clip should finish it rather than cut mid-sentence
    words, t = [], 0.0
    for i in range(140):
        w = f"w{i}" + ("." if i in (30, 120) else "")
        words.append(Word(w, round(t, 3), round(t + 0.3, 3)))
        t += 0.4
    tr = Transcript("en", words, resegment(words))
    c = refine(Clip(0.0, 40.0, "x"), tr, 15, 40)
    last = [w for w in words if w.end <= c.end][-1]
    assert last.text.endswith(".")


def test_tighten_keeps_short_pauses_and_spaces_cuts():
    from clipper.edit import build_pieces
    words, t = [], 0.0
    for i in range(60):
        words.append(Word(f"w{i}", round(t, 3), round(t + 0.25, 3)))
        t += 0.25 + (0.5 if i % 3 else 0.2) + (1.5 if i % 10 == 9 else 0)  # 0.2-0.5 s gaps, 2 s pause every 10 words
    pieces = build_pieces([(0.0, t)], words, 30, tighten=True)
    assert all(p.dur >= 2.0 for p in pieces[:-1])
    assert all(p.zoom == 1.0 for p in pieces)
    # short (<0.8 s) pauses are never cut
    cut_gaps = [pieces[i + 1].src_start - pieces[i].src_end for i in range(len(pieces) - 1)]
    assert all(g > 0.3 for g in cut_gaps)


def test_edit_pass_applies_unit_ranges():
    from clipper import editor
    t = make_transcript(TEXT)
    c = Clip(t.segments[4].start + 1, t.segments[6].end - 1, "x")
    seen = {}

    def fake(**kw):
        seen["user"] = kw["user"]
        return {"clips": [{"clip": 0, "usable": True, "kind": "single",
                           "ranges": [{"first": 3, "last": 6}], "thought": "t"}]}

    editor.structured_call = fake
    kept = editor.edit_clips([c], t, brief="", tone="", min_len=5, max_len=60, model="x")
    assert kept == [c] and c.kind == "single"
    first = next(w for w in t.words if w.start >= c.start)
    last = [w for w in t.words if w.end <= c.end][-1]
    assert first.text == "Sentence" and last.text.endswith(".")

    def drop(**kw):
        return {"clips": [{"clip": 0, "usable": False, "kind": "single", "ranges": [], "thought": ""}]}

    editor.structured_call = drop
    assert editor.edit_clips([Clip(10, 30, "y")], t, brief="", tone="", min_len=5, max_len=60, model="x") == []
