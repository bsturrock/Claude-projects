# clipper

Turn long-form video (podcasts, interviews, debates, talks, streams) into vertical 9:16 clips with burned-in animated captions and ready-to-post copy for TikTok, YouTube Shorts, Instagram Reels and X.

```
source video / URL
  -> transcribe (faster-whisper, word timestamps, cached)
  -> find moments that fit your brief (Claude), pick a caption style per clip
  -> snap to clean sentence boundaries, enforce 15-60s
  -> [optional] review in the browser: trim, restyle, approve, add your own clips
  -> reframe to 1080x1920 (active speaker detection, speaker cuts, crosstalk split screen)
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

The first run downloads the Whisper model (`small` is about 500 MB). The transcript is cached, so later runs on the same file skip that step.

## Clip Studio (the main way to use it)

```bash
clipper studio            # opens http://127.0.0.1:8765, workspace in ~/ClipStudio
```

- **Projects:** one per show, topic or creator. Each has its own prompt, tone, caption style, clip count and length, and notes for the post copy.
- **Adding sources:** drop videos onto a project (they're copied into the workspace), paste a file path to use a file in place without copying, or paste a YouTube URL. Each source is transcribed, clipped with the project's prompt and rendered in the background, with progress shown. "Find again" asks Claude for a fresh set and keeps clips you approved or posted.
- **Clip grid:** filter by To review, Approved or Posted. Open a clip to trim it, change the hook, title or caption style, re-render, download the MP4, and edit or copy the post text for each platform.
- **Posted to:** after posting a clip yourself, log the link and its views, likes, comments and shares for each platform. The project's **Performance** tab totals them per platform, ranks posts by views and shows engagement rate. Each day's numbers are kept as history.

Everything lives in the workspace folder as plain files: `projects/<id>/project.json`, and `projects/<id>/sources/<id>/` holding the clips, `clips.json` and `posts.md`. Restarting the studio resumes any source that was mid-processing.

The command-line flow below still works for one-off jobs and scripting.

## Usage

```bash
# Pick clips, then review them in the browser before rendering
clipper podcast.mp4 -b "Contrarian takes on hiring for early-stage founders" -t "direct, funny" -n 8 --review

# Fully automatic
clipper "https://www.youtube.com/watch?v=..." -b "the most heated exchanges" -n 5
```

### Review UI (`--review`)

This opens `http://127.0.0.1:8765` (local only). For each clip you can:

- play exactly the clip, or start 3 seconds before it
- trim it with nudge buttons, or set start and end from the playhead. In the transcript, Alt-click a word to start there or Shift-click to end after it.
- change the title, hook, and caption style
- approve or reject it, then render one clip or all approved clips
- watch the rendered vertical clip, then edit and copy the post text for each platform
- add a clip of your own at the playhead

Keyboard: `space` play/pause, `i`/`o` set in/out, `a` approve, `x` reject, `j`/`k` next/previous clip.

Edits save to `out/<name>/clips.json` as you go. Running the same command again resumes where you left off, and `--reselect` asks Claude for a fresh set.

Output goes to `out/<source-name>/`:

| File | What it is |
| --- | --- |
| `clipNN-<title>.mp4` | 1080x1920 clip, captions burned in |
| `clipNN-<title>.srt` | Plain captions, for platforms that accept caption uploads |
| `clipNN-<title>.jpg` | Cover frame |
| `clipNN-<title>.post.json` | Post copy for that clip |
| `posts.md` | All rendered clips with copy for every platform, ready to paste |
| `clips.json` | Timings, titles, hooks, styles, scores, reasoning, review state |

## Caption styles

Claude picks one per clip from the content (`--style auto`, the default). You can force one for every clip with `--style NAME`, or change individual clips in the review UI.

| Style | Look | For |
| --- | --- | --- |
| `bold` | Big all-caps sans, yellow active word, pop-in | Hot takes, commentary, podcasts, most viral talking-head content |
| `playful` | Chunky rounded type, colour-cycling active word, bounce and tilt | Gaming, streams, comedy, reactions, entertainment |
| `editorial` | Serif on a translucent box, gold active word, soft fade | News, politics, business, finance, documentary, serious moments |
| `clean` | Sentence-case sans, green active word | Education, how-to, tech, interviews, calm explainers |

Fine-tune with `--font`, `--font-size`, `--color`, `--highlight`, `--words`, `--caption-y`.

## How reframing works

Each clip is analysed at 25 fps:

1. **Faces** are detected with YuNet and linked into tracks. Shot changes are detected from colour histograms.
2. **Active speaker detection.** Each face track's lip region plus the audio is scored by Light-ASD (CVPR 2023), running on CPU through onnxruntime. It costs about 20 s of analysis per minute of clip on a laptop.
3. **Static borders** (branded frames, logo bars, letterboxing) are detected and cropped away.
4. Per shot:
   - One person: the crop locks on them, or follows gently if they move around.
   - Several people close together: one static crop holds the group.
   - Several people too far apart for one crop: the video **cuts to whoever is talking**. A new speaker must lead for about 0.5 s and each shot lasts at least 1.2 s, so short interjections don't cause strobing.
   - **Crosstalk:** when two people talk over each other for 1.5 s or more, that stretch becomes a split screen. Turn this off with `--no-crosstalk-split`.
   - No usable face (slides, screen shares, b-roll): the full frame sits over a blurred fill.

`--two-shot stack` uses a permanent split screen for two-person shots instead of cuts. `--no-asd` follows the largest face. `--layout fit|center` forces one layout for the whole clip.

## Content notes

- Controversial, heated and profane moments are explicitly allowed in the selection and copy prompts, and are often the best clips. Claude is told to keep enough context that a clip doesn't misrepresent the speaker, and not to invent quotes in the copy.
- Claude will decline sexual content involving minors, extremist propaganda and harassment campaigns, and may refuse how-to instructions for weapons, hacking or drugs. A borderline request is retried automatically on a fallback model. If a request is fully declined, the run stops with an error.
- Clipping content you don't own invites Content ID claims and takedowns, and background music triggers claims even on your own uploads. That is a platform issue, not something the tool can fix.
- Selection reads the transcript, so moments with no speech (a reaction, a fall, gameplay) are invisible to it. Add those yourself in the review UI.
- The bundled fonts cover Latin-script languages only. For CJK, Arabic and similar scripts, pass `--font` with a font installed on your system.

## Options worth knowing

| Flag | Default | Notes |
| --- | --- | --- |
| `-b/--brief` | | What you want clipped, for whom, from what angle. |
| `-t/--tone` | | Used for both selection and copy. |
| `-n/--count` | 5 | Claude proposes twice as many, and the best non-overlapping ones are kept. |
| `--min/--max` | 15/60 | Clip length bounds in seconds. `--target 30` nudges toward a length. |
| `-r/--review` | off | Browser review before rendering. |
| `--hook-overlay` | intro | Hook headline for the first ~3.5s, the whole clip (`full`), or `off`. |
| `--whisper-model` | small | `large-v3-turbo` is more accurate if you have the time and RAM. |
| `--transcript` | | Existing word-timestamped JSON (this tool's format, or Whisper/WhisperX). |
| `--model` | claude-opus-5-5 | Also settable via `CLIPPER_MODEL`. |
| `--effort` | high | Claude effort for selection. `medium` is cheaper. |
| `--copy-notes` | | Extra instructions for post copy, e.g. "Mention the full episode is on Spotify". |
| `--clips` | | Skip AI selection and render a JSON list of `{start, end, title, hook, style}`. |

## Known limitations

- A speaker who starts talking while looking away or down can be picked up a second or two late.
- Captions are only as good as Whisper's transcript. Check names and jargon.
- Low-resolution sources look soft after the 9:16 crop, because the crop is upscaled to 1080x1920.
- Nothing is posted for you.

## Credits

- Light-ASD active speaker model: Liao et al., CVPR 2023, MIT licence. The weights were converted to ONNX: `clipper/models/LICENSE-Light-ASD.txt`.
- YuNet face detector: OpenCV Zoo, MIT licence.
- Fonts: Poppins, Lilita One and DM Serif Display, all SIL Open Font License.

## Tests

```bash
pip install -e '.[dev]' && pytest -q
```
