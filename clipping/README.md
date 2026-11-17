# clipper

Turn long-form video (podcasts, interviews, talks, streams) into vertical 9:16 clips with burned-in animated captions and ready-to-post copy for TikTok, YouTube Shorts, Instagram Reels and X.

```
source video / URL
  -> transcribe (faster-whisper, word timestamps, cached)
  -> find moments that fit your brief (Claude)
  -> snap to clean sentence boundaries, enforce 15-60s
  -> reframe to 1080x1920 per shot (face tracking / split screen / blurred fit)
  -> word-by-word captions + hook headline (ASS via libass)
  -> encode H.264 + AAC, -14 LUFS, faststart
  -> post copy per platform (Claude)
```

## Setup (macOS)

```bash
brew install ffmpeg            # needs libass, which Homebrew's ffmpeg includes
cd clipping
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
export ANTHROPIC_API_KEY=...   # or: ant auth login
```

The first run downloads the Whisper model (`small` is about 500 MB). Clipping a 1-hour source on an M-series Mac takes roughly 5-10 minutes to transcribe with `small`. The transcript is cached, so later runs on the same file skip that step.

## Usage

```bash
clipper podcast.mp4 \
  --brief "Contrarian takes on hiring for early-stage founders" \
  --tone "direct, a little funny" \
  -n 6 --min 20 --max 55

clipper "https://www.youtube.com/watch?v=..." -b "the best stories" --style impact
```

Output goes to `out/<source-name>/`:

| File | What it is |
| --- | --- |
| `clipNN-<title>.mp4` | 1080x1920 clip, captions burned in |
| `clipNN-<title>.srt` | Plain captions, for platforms that accept caption uploads (YouTube) |
| `clipNN-<title>.jpg` | Cover frame |
| `clipNN-<title>.post.json` | Post copy for that clip |
| `posts.md` | All clips with copy for every platform, ready to paste |
| `clips.json` | Chosen timings, titles, hooks, scores and reasoning |
| `manifest.json` | Everything above in one machine-readable file |

### Review before rendering

```bash
clipper talk.mp4 -b "..." --select-only        # writes out/talk/clips.json, no rendering
# edit start/end/title/hook in clips.json, delete clips you don't want
clipper talk.mp4 --clips out/talk/clips.json   # renders exactly those
```

`--clips` also accepts your own hand-picked list: `[{"start": 61.2, "end": 104.0, "title": "...", "hook": "..."}]`.

## Options worth knowing

| Flag | Default | Notes |
| --- | --- | --- |
| `-b/--brief` | | What you want clipped, for whom, from what angle. The more specific, the better the picks. |
| `-t/--tone` | | Used for both clip selection and copy. |
| `-n/--count` | 5 | Number of clips. Claude proposes twice as many, and the best non-overlapping ones are kept. |
| `--min/--max` | 15/60 | Hard clip-length bounds in seconds. `--target 30` nudges toward a length. |
| `--style` | bold | `bold`, `clean`, `impact`, `minimal`. Override with `--font`, `--font-size`, `--color`, `--highlight`, `--words`, `--caption-y`. |
| `--hook-overlay` | intro | Hook headline at the top for the first ~3.5s, the whole clip (`full`), or `off`. |
| `--layout` | auto | `auto` picks per shot. `fit` or `center` forces one layout everywhere. `--no-stack` disables split screen. |
| `--whisper-model` | small | `large-v3-turbo` is more accurate if you have the time and RAM. |
| `--transcript` | | Use an existing word-timestamped JSON (this tool's format, or Whisper/WhisperX `segments[].words[]`). |
| `--model` | claude-opus-5-5 | Also settable via `CLIPPER_MODEL`. |
| `--effort` | high | Claude effort for clip selection. `medium` is cheaper. Copywriting always runs at `medium`. |
| `--copy-notes` | | Extra instructions for post copy, e.g. "Mention the full episode is on Spotify". |
| `--crf/--preset` | 19/medium | x264 quality and speed. |

## How the reframing decides

Each clip is sampled at 5 fps and split into shots by colour-histogram change. Then each shot gets one of these layouts:

- **track**: one main face. A 9:16 crop follows it. When the subject barely moves the crop stays locked, and otherwise movement is median-filtered and eased so it doesn't jitter.
- **stack**: two similarly sized faces too far apart to share one 9:16 frame (a typical two-person podcast wide shot). The output is a split screen, and captions move to the seam.
- **fit**: no reliable face (slides, screen shares, b-roll). The full frame sits over a blurred, darkened copy of itself.

Face detection uses OpenCV's YuNet model (bundled, MIT). Fonts are Poppins and Anton (bundled, SIL OFL).

## Limitations

- Speaker selection uses face size and continuity, not active-speaker detection. In a single wide shot where two people sit close together, the crop follows the larger face, not necessarily the one talking.
- Captions come from Whisper. Check names and jargon before posting. You can fix `clipNN.srt` and the words in the cached transcript, then re-render with `--clips`.
- Nothing is uploaded or posted for you. The output is files and copy to paste.

## Tests

```bash
pip install -e '.[dev]' && pytest -q
```
