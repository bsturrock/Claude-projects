# clipper

Turn long-form video (podcasts, interviews, debates, talks, streams) into vertical 9:16 clips with burned-in animated captions and ready-to-post copy for TikTok, YouTube Shorts, Instagram Reels and X.

```
source video / URL / watch folder
  -> transcribe (mlx-whisper on Apple Silicon, else faster-whisper; custom vocabulary; cached)
  -> measure audio cues (loud, fast, long pauses)
  -> Claude finds moments that fit the project prompt, learning from clips you rated top/flop:
     single clips, cold opens (payoff first) and stitched clips, plus key words and alt hooks
  -> editing pass (Claude): each clip re-cut as one complete thought, starting where the idea
     starts and ending right after the payoff, tangents cut; sentence snapping as fallback
  -> review in Clip Studio: trim parts, restyle, approve, rate, make variants
  -> reframe to 1080x1920 (active speaker detection, speaker cuts, crosstalk split screen,
     looser framing when faces are big, static borders cropped)
  -> optional: trim long pauses, clean up voices
  -> captions: channel signature styles (Pillow) or generic styles (libass) + hook headline
  -> animated channel end card with its own sound
  -> encode (Mac hardware encoder when available), -14 LUFS, faststart; 2 clips in parallel
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

- **Projects:** one per show, topic or creator, tied to a **channel** (Yap or Framebite). The channel sets the end card, the signature caption style and sensible defaults. Each project has its own prompt, tone, clip count and length, a list of names and terms to spell correctly, notes for the post copy, and toggles for pause trimming, voice cleanup, swear masking and economy mode (Claude Batch API, half price, slower).
- **Adding sources:** drop videos onto a project (they're copied into the workspace), paste a file path to use a file in place without copying, paste a YouTube URL, or set a **watch folder** so new recordings are picked up automatically. Each source is transcribed, clipped and rendered in the background. "Find again" asks Claude for a fresh set and keeps clips you approved, rated or posted.
- **Clip grid:** filter by To review, Approved, Posted or Top performers. Approve or reject right on the cards, or approve/reject everything shown and render all approved clips in one go.
- **Auto-edit** on a clip page asks Claude to re-cut that clip as one complete thought (useful for clips you add by hand).
- **Clip page:** edit the clip's **parts** (one span, or several for a cold open or stitched clip), hook, title and caption style. Re-render, download, and copy the post text for each platform. **Make variant** copies the clip with an alternative hook and a different style for A/B testing.
- **How did it do?** Mark clips as **Top performer** or **Flopped**. The next time Claude picks clips for that project, it sees those clips as examples of what works and what doesn't for that audience.
- **Posted to:** tick off where a clip has gone out, optionally with the link.

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

## Channels: end cards and signature captions

Brand kits live in `clipper/brands/<id>/` (`logo.png` + `brand.json`). Each clip ends on an animated card of about 1.3 s with a synthesized sound:

- **Yap** (podcasts, streams, debates): "yap" pops in, then the speech bubble drops from the top, lands on the text with a thump and bounces to rest.
- **Framebite** (TV, film, established media): the rounded rectangle pops in, then one big bite takes the corner out, with a munch, a jolt and crumbs.

Cold opens get a quick (0.6 s) branded rewind wipe between the payoff and the start of the thought, with a tape-rewind sound. Hook headlines are branded too: Yap gets yellow type on a black bubble, Framebite a cream serif title between teal rules, and everything else a dark pill.

Signature caption styles, drawn frame by frame:

- `yap`: lowercase words in a yellow speech bubble with a lightning-bolt tail. Words fill in as they're spoken, and key words flip into black pills.
- `framebite`: cinematic serif subtitles. A teal underline glides from word to word, and key words turn teal.

## Caption styles

A project uses its channel's signature style by default. In `auto`, Claude picks one of the generic styles per clip. You can change any clip's style on its page.

| Style | Look | For |
| --- | --- | --- |
| `bold` | Big all-caps sans, yellow active word, pop-in | Hot takes, commentary, podcasts, most viral talking-head content |
| `playful` | Chunky rounded type, colour-cycling active word, bounce and tilt | Gaming, streams, comedy, reactions, entertainment |
| `editorial` | Serif with a soft shadow, gold active word, soft fade | News, politics, business, finance, documentary, serious moments |
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
   - Several people too far apart for one crop: the video **cuts to whoever is talking**. A new speaker must lead for about 0.5 s and each shot lasts at least 2 s, so short interjections don't cause strobing.
   - **Crosstalk:** when two people talk over each other for 2 s or more, that stretch becomes a split screen. Turn this off with `--no-crosstalk-split`.
5. **Framing:** when faces are big relative to the picture, the speaker is shown in a wider 4:5 or square window over a blurred fill, instead of a full-height crop that feels too close. Set `--framing tight|medium|wide`, or choose it per project.

**Trim pauses** (`--tighten`) shortens only pauses longer than 0.8 s (um and uh count as pause) down to about 0.4 s, and never cuts more often than every 2 s.
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
| `--min/--max` | 15/90 | Clip length bounds in seconds. Clips always finish their sentence, so they can run up to about 35% over. `--target 30` nudges toward a length. |
| `--brand` | | Channel end card (`yap`, `framebite`). |
| `--tighten` / `--clean-audio` | off | Trim long pauses / denoise, de-ess and compress voices. |
| `--vocab` | | Comma-separated names and terms for transcription. |
| `--economy` | off | Claude Batch API: half price, can take longer. |
| `--encoder` / `--parallel` | auto / 2 | Mac hardware encoder when available; clips rendered at once. |
| `-r/--review` | off | Browser review before rendering. |
| `--no-edit` / `--edit` | | Skip Claude's editing pass / also run it on `--clips` input. |
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
- End-card sounds are synthesized in code (`clipper/endcard.py`); no audio samples are used.

## Tests

```bash
pip install -e '.[dev]' && pytest -q
```
