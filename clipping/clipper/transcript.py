"""Transcript data model and transcription with word-level timestamps."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Segment:
    start: float
    end: float
    text: str
    first_word: int  # index into Transcript.words
    last_word: int   # inclusive


@dataclass
class Transcript:
    language: str
    words: list[Word]
    segments: list[Segment] = field(default_factory=list)

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=1))

    @classmethod
    def load(cls, path: Path) -> "Transcript":
        d = json.loads(path.read_text())
        return cls(
            language=d.get("language", "en"),
            words=[Word(**w) for w in d["words"]],
            segments=[Segment(**s) for s in d.get("segments", [])],
        )

    def words_between(self, start: float, end: float) -> list[Word]:
        return [w for w in self.words if w.end > start and w.start < end]

    def text_between(self, start: float, end: float) -> str:
        return " ".join(w.text for w in self.words_between(start, end)).strip()


MLX_MODELS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}


def mlx_available() -> bool:
    import platform
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return False
    try:
        import mlx_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def _read_wav(audio: Path):
    import wave

    import numpy as np
    # Read the 16 kHz mono WAV ourselves: avoids decoder differences across PyAV versions.
    with wave.open(str(audio), "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("transcribe() expects 16 kHz mono 16-bit WAV (see media.extract_audio)")
        return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0


def _vocab_prompt(vocabulary: list[str]) -> str | None:
    vocab = [v.strip() for v in vocabulary if v.strip()]
    return ("Names and terms: " + ", ".join(vocab) + ".") if vocab else None


def transcribe(audio: Path, model_size: str = "small", language: str | None = None,
               device: str = "auto", progress=None, vocabulary: list[str] | None = None,
               engine: str = "auto") -> Transcript:
    """Word-timestamped transcription.

    engine: auto (mlx-whisper on Apple Silicon when installed, else faster-whisper),
            mlx, or faster-whisper.
    vocabulary: names/brands/jargon to bias spelling towards.
    """
    pcm = _read_wav(audio)
    if engine == "mlx" or (engine == "auto" and mlx_available()):
        return _transcribe_mlx(pcm, model_size, language, progress, vocabulary or [])
    return _transcribe_fw(pcm, model_size, language, device, progress, vocabulary or [])


def _collect(raw_segments, progress, total: float) -> tuple[list[Word], list[Segment]]:
    words: list[Word] = []
    segments: list[Segment] = []
    for text, seg_end, seg_words in raw_segments:
        first = len(words)
        for w, ws, we in seg_words:
            t = w.strip()
            if t:
                words.append(Word(t, round(ws, 3), round(max(we, ws + 0.01), 3)))
        if len(words) > first:
            segments.append(Segment(start=words[first].start, end=words[-1].end, text=text.strip(),
                                    first_word=first, last_word=len(words) - 1))
        print(f"\r  transcribed {seg_end / 60:6.1f} min", end="", flush=True)
        if progress:
            progress(f"transcribing {seg_end / max(total, 1):.0%}")
    print()
    return words, segments


def _transcribe_fw(pcm, model_size, language, device, progress, vocabulary) -> Transcript:
    from faster_whisper import WhisperModel

    compute_type = "int8" if device in ("cpu", "auto") else "float16"
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    vp = _vocab_prompt(vocabulary)
    seg_iter, info = model.transcribe(
        pcm, language=language, word_timestamps=True, vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400}, condition_on_previous_text=False,
        initial_prompt=vp, hotwords=" ".join(v for v in vocabulary if v.strip()) or None,
    )
    raw = ((s.text, s.end, [(w.word, w.start, w.end) for w in (s.words or [])]) for s in seg_iter)
    words, segments = _collect(raw, progress, info.duration)
    return Transcript(language=info.language, words=words, segments=segments)


def _transcribe_mlx(pcm, model_size, language, progress, vocabulary) -> Transcript:
    import mlx_whisper

    if progress:
        progress("transcribing on the Apple GPU")
    repo = MLX_MODELS.get(model_size, model_size)
    res = mlx_whisper.transcribe(pcm, path_or_hf_repo=repo, word_timestamps=True, language=language,
                                 initial_prompt=_vocab_prompt(vocabulary),
                                 condition_on_previous_text=False, verbose=None)
    total = len(pcm) / 16000
    raw = ((s.get("text", ""), s.get("end", 0.0),
            [(w["word"], w["start"], w["end"]) for w in s.get("words", [])]) for s in res["segments"])
    words, segments = _collect(raw, progress, total)
    return Transcript(language=res.get("language", language or "en"), words=words, segments=segments)


def audio_cues(audio: Path, t: Transcript) -> dict[str, list[str]]:
    """Per transcript segment: LOUD / FAST / PAUSE hints for clip selection."""
    import numpy as np

    pcm = _read_wav(audio)
    if not len(pcm) or not t.segments:
        return {}
    win = 8000  # 0.5 s
    n = len(pcm) // win
    rms = np.sqrt(np.mean(pcm[: n * win].reshape(n, win) ** 2, axis=1) + 1e-10)
    db = 20 * np.log10(rms)
    voiced = db[db > np.percentile(db, 30)]
    loud_thr = np.percentile(voiced, 93) if len(voiced) else 0
    loud_ref = np.median(voiced) if len(voiced) else 0
    rates = []
    for s in t.segments:
        nw = s.last_word - s.first_word + 1
        dur = max(0.5, s.end - s.start)
        rates.append(nw / dur if dur >= 2 else np.nan)
    med_rate = np.nanmedian(rates) if np.isfinite(rates).any() else 0
    cues: dict[str, list[str]] = {}
    for i, s in enumerate(t.segments):
        tags = []
        a, b = int(s.start * 2), max(int(s.start * 2) + 1, int(s.end * 2))
        seg_db = db[a:b]
        if len(seg_db) and np.max(seg_db) >= loud_thr and np.max(seg_db) - loud_ref > 6:
            tags.append("LOUD")
        if med_rate and np.isfinite(rates[i]) and rates[i] > med_rate * 1.35:
            tags.append("FAST")
        if i > 0 and s.start - t.segments[i - 1].end > 1.5:
            tags.append("PAUSE")
        if tags:
            cues[str(i)] = tags
    return cues


def resegment(words: list[Word], max_gap: float = 0.8, max_len: float = 12.0) -> list[Segment]:
    """Build sentence-ish segments from words (used for imported transcripts)."""
    segs: list[Segment] = []
    start_i = 0
    for i, w in enumerate(words):
        nxt = words[i + 1] if i + 1 < len(words) else None
        ends_sentence = w.text[-1:] in ".?!"
        gap = (nxt.start - w.end) if nxt else 99
        too_long = w.end - words[start_i].start > max_len
        if nxt is None or gap > max_gap or ends_sentence or too_long:
            chunk = words[start_i:i + 1]
            segs.append(Segment(chunk[0].start, chunk[-1].end,
                                " ".join(x.text for x in chunk), start_i, i))
            start_i = i + 1
    return segs
