"""Generate platform-ready post copy for each clip."""

from __future__ import annotations

from .llm import structured_call
from .selection import Clip
from .transcript import Transcript

COPY_SYSTEM = """\
You write the post copy that ships with short-form video clips. You know each \
platform's conventions:

- TikTok: a short caption (one or two lines) that adds curiosity or a take, not \
a summary of the video. 3-5 relevant hashtags mixing broad and niche. No \
"link in bio" unless the brief asks.
- YouTube Shorts: a title under 70 characters that is searchable and clicky \
without being clickbait the video can't pay off; a 1-3 sentence description \
with keywords near the start, then 3 hashtags.
- Instagram Reels: a caption whose first line is the hook (it is all people see \
before "more"), then 1-3 short lines of context, a light call to action, then \
3-5 hashtags.
- X: a standalone post under 260 characters that reads like a person talking, \
not an ad. At most one hashtag, usually none. Also give one alternative angle.

Match the creator's tone. If the clip is provocative or heated, the copy can \
lean into that tension; do not sanitize it into something bland. Never invent facts, quotes, names or numbers that \
are not in the clip transcript. Do not use emojis unless the tone calls for \
them. Do not use em dashes.\
"""

PLATFORM_SCHEMA = {
    "type": "object",
    "properties": {
        "index": {"type": "integer"},
        "tiktok": {
            "type": "object",
            "properties": {"caption": {"type": "string"},
                           "hashtags": {"type": "array", "items": {"type": "string"}}},
            "required": ["caption", "hashtags"], "additionalProperties": False,
        },
        "youtube_shorts": {
            "type": "object",
            "properties": {"title": {"type": "string"}, "description": {"type": "string"},
                           "hashtags": {"type": "array", "items": {"type": "string"}}},
            "required": ["title", "description", "hashtags"], "additionalProperties": False,
        },
        "instagram": {
            "type": "object",
            "properties": {"caption": {"type": "string"},
                           "hashtags": {"type": "array", "items": {"type": "string"}}},
            "required": ["caption", "hashtags"], "additionalProperties": False,
        },
        "x": {
            "type": "object",
            "properties": {"post": {"type": "string"}, "alt_post": {"type": "string"}},
            "required": ["post", "alt_post"], "additionalProperties": False,
        },
    },
    "required": ["index", "tiktok", "youtube_shorts", "instagram", "x"],
    "additionalProperties": False,
}

COPY_SCHEMA = {
    "type": "object",
    "properties": {"posts": {"type": "array", "items": PLATFORM_SCHEMA}},
    "required": ["posts"],
    "additionalProperties": False,
}


def _normalize_tags(tags: list[str]) -> list[str]:
    out = []
    for t in tags:
        t = "#" + t.strip().lstrip("#").replace(" ", "")
        if len(t) > 1 and t.lower() not in {x.lower() for x in out}:
            out.append(t)
    return out


def write_copy(clips: list[Clip], t: Transcript, *, brief: str, tone: str,
               model: str, effort: str = "medium", extra: str = "", batch: bool = False) -> None:
    blocks = []
    for c in clips:
        blocks.append(
            f'<clip index="{c.index}" duration="{c.duration:.0f}s">\n'
            f"<working_title>{c.title}</working_title>\n"
            f"<on_screen_hook>{c.hook}</on_screen_hook>\n"
            f"<transcript>{' ... '.join(t.text_between(a, b) for a, b in c.parts())}</transcript>\n</clip>"
        )
    user = (
        f"<creator_brief>\n{brief or 'General audience.'}\n</creator_brief>\n"
        f"<tone>{tone or 'Match the speaker.'}</tone>\n"
        + (f"<extra_instructions>{extra}</extra_instructions>\n" if extra else "")
        + "\nWrite post copy for each clip below. Return one entry per clip with its index.\n\n"
        + "\n\n".join(blocks)
    )
    data = structured_call(system=COPY_SYSTEM, user=user, schema=COPY_SCHEMA,
                           model=model, effort=effort, batch=batch)
    by_index = {p["index"]: p for p in data["posts"]}
    for c in clips:
        p = by_index.get(c.index)
        if not p:
            continue
        for k in ("tiktok", "youtube_shorts", "instagram"):
            p[k]["hashtags"] = _normalize_tags(p[k]["hashtags"])
        warnings = []
        if len(p["x"]["post"]) > 280:
            warnings.append(f"X post is {len(p['x']['post'])} chars (limit 280 for non-Premium)")
        if len(p["youtube_shorts"]["title"]) > 100:
            warnings.append("YouTube title over 100 chars")
        if len(p["tiktok"]["caption"]) > 2200:
            warnings.append("TikTok caption over 2200 chars")
        p["warnings"] = warnings
        p.pop("index", None)
        c.copy = p


def format_post_md(c: Clip) -> str:
    p = c.copy
    if not p:
        return f"## {c.index:02d}. {c.title}\n\n(no copy generated)\n"
    tags = lambda k: " ".join(p[k]["hashtags"])  # noqa: E731
    out = [
        f"## {c.index:02d}. {c.title}",
        f"`{c.slug}.mp4` | {c.duration:.1f}s | source {c.start:.1f}s to {c.end:.1f}s | score {c.score}",
        f"> {c.rationale}",
        "### TikTok", f"{p['tiktok']['caption']}\n\n{tags('tiktok')}",
        "### YouTube Shorts", f"**{p['youtube_shorts']['title']}**\n\n"
        f"{p['youtube_shorts']['description']}\n\n{tags('youtube_shorts')}",
        "### Instagram Reels", f"{p['instagram']['caption']}\n\n{tags('instagram')}",
        "### X", p["x"]["post"], f"_Alt:_ {p['x']['alt_post']}",
    ]
    if p.get("warnings"):
        out.append("**Warnings:** " + "; ".join(p["warnings"]))
    return "\n\n".join(out) + "\n"
