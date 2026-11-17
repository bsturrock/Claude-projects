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


def transcribe(audio: Path, model_size: str = "small", language: str | None = None,
               device: str = "auto") -> Transcript:
    """Run faster-whisper with word timestamps.

    model_size: tiny | base | small | medium | large-v3 | large-v3-turbo | distil-large-v3
    """
    from faster_whisper import WhisperModel

    import wave

    import numpy as np

    # Read the 16 kHz mono WAV ourselves: avoids faster-whisper's PyAV decoder,
    # which breaks across PyAV versions.
    with wave.open(str(audio), "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("transcribe() expects 16 kHz mono 16-bit WAV (see media.extract_audio)")
        pcm = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0

    compute_type = "int8" if device in ("cpu", "auto") else "float16"
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    seg_iter, info = model.transcribe(
        pcm,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        condition_on_previous_text=False,
    )
    words: list[Word] = []
    segments: list[Segment] = []
    for seg in seg_iter:
        first = len(words)
        for w in seg.words or []:
            t = w.word.strip()
            if not t:
                continue
            words.append(Word(t, round(w.start, 3), round(max(w.end, w.start + 0.01), 3)))
        if len(words) > first:
            segments.append(Segment(
                start=words[first].start, end=words[-1].end,
                text=seg.text.strip(), first_word=first, last_word=len(words) - 1,
            ))
        print(f"\r  transcribed {seg.end / 60:6.1f} min", end="", flush=True)
    print()
    return Transcript(language=info.language, words=words, segments=segments)


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
