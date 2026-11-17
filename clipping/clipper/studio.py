"""Clip Studio: a local web workshop.

Projects (a show, topic or creator) carry their own prompt and settings. Drop
source videos into a project; each one is transcribed, clipped by Claude and
rendered in the background. Review and edit the results, download them, log
where you posted each clip and track how it performs.

Standard library HTTP server, bound to 127.0.0.1. Run: `clipper studio`.
"""

from __future__ import annotations

import json
import mimetypes
import queue
import re
import shutil
import threading
import time
import traceback
import uuid
import webbrowser
from dataclasses import asdict, dataclass, field, fields
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import media
from .captions import PRESETS
from .pipeline import Options, Project, log
from .selection import Clip, clip_from_dict, dedupe, find_moments, refine

PAGE = Path(__file__).parent / "studio.html"
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts", ".wmv", ".flv"}
BROWSER_VIDEO = {"h264", "vp8", "vp9", "av1"}
BROWSER_AUDIO = {"aac", "mp3", "opus", "vorbis"}
PLATFORMS = ["tiktok", "youtube_shorts", "instagram", "x"]
METRICS = ["views", "likes", "comments", "shares"]


def _id() -> str:
    return uuid.uuid4().hex[:10]


def _now() -> float:
    return round(time.time(), 1)


def _write_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    tmp.replace(path)


@dataclass
class ProjectSettings:
    id: str
    name: str
    brief: str = ""
    tone: str = ""
    style: str = "auto"
    count: int = 5
    min_len: float = 15
    max_len: float = 60
    target_len: float | None = None
    hook_mode: str = "intro"
    copy_notes: str = ""
    two_shot: str = "cut"
    crosstalk: bool = True
    whisper_model: str = "small"
    language: str = ""
    auto_render: bool = True
    created: float = field(default_factory=_now)

    @classmethod
    def from_dict(cls, d: dict) -> "ProjectSettings":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class Source:
    id: str
    name: str
    path: str                 # absolute path of the video (inside the workspace or linked)
    linked: bool = False      # True when we reference a file in place instead of copying it
    url: str = ""
    status: str = "queued"    # queued | processing | ready | error
    stage: str = ""
    error: str = ""
    duration: float = 0.0
    added: float = field(default_factory=_now)

    @classmethod
    def from_dict(cls, d: dict) -> "Source":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})


class Workspace:
    def __init__(self, root: Path):
        self.root = root
        (root / "projects").mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self._pipelines: dict[tuple[str, str], Project] = {}
        self.clip_jobs: dict[tuple[str, str, int], dict] = {}
        self.q: queue.Queue = queue.Queue()
        self.proxy_state: dict[tuple[str, str], str] = {}
        threading.Thread(target=self._worker, daemon=True).start()
        self._resume()

    # -- paths --------------------------------------------------------------
    def pdir(self, pid: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{10}", pid):
            raise KeyError(pid)
        return self.root / "projects" / pid

    def sdir(self, pid: str, sid: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{10}", sid):
            raise KeyError(sid)
        return self.pdir(pid) / "sources" / sid

    # -- projects -----------------------------------------------------------
    def projects(self) -> list[ProjectSettings]:
        out = []
        for d in sorted((self.root / "projects").iterdir()):
            f = d / "project.json"
            if f.exists():
                out.append(ProjectSettings.from_dict(json.loads(f.read_text())))
        return sorted(out, key=lambda p: -p.created)

    def project(self, pid: str) -> ProjectSettings:
        f = self.pdir(pid) / "project.json"
        if not f.exists():
            raise KeyError(pid)
        return ProjectSettings.from_dict(json.loads(f.read_text()))

    def save_project(self, p: ProjectSettings) -> None:
        d = self.pdir(p.id)
        (d / "sources").mkdir(parents=True, exist_ok=True)
        _write_json(d / "project.json", asdict(p))

    def create_project(self, data: dict) -> ProjectSettings:
        p = ProjectSettings.from_dict({**data, "id": _id(), "created": _now()})
        if not p.name.strip():
            p.name = "Untitled project"
        self.save_project(p)
        return p

    def update_project(self, pid: str, data: dict) -> ProjectSettings:
        cur = asdict(self.project(pid))
        for k, v in data.items():
            if k in cur and k not in ("id", "created"):
                cur[k] = v
        p = ProjectSettings.from_dict(cur)
        if p.style not in ("auto", *PRESETS):
            p.style = "auto"
        p.count = max(1, min(30, int(p.count)))
        p.min_len, p.max_len = float(p.min_len), float(p.max_len)
        if p.min_len >= p.max_len:
            p.max_len = p.min_len + 5
        p.target_len = float(p.target_len) if p.target_len not in (None, "", 0) else None
        self.save_project(p)
        # settings feed into render signatures; drop cached pipelines so they pick it up
        with self.lock:
            for key in [k for k in self._pipelines if k[0] == pid]:
                self._pipelines.pop(key)
        return p

    def delete_project(self, pid: str) -> None:
        shutil.rmtree(self.pdir(pid), ignore_errors=True)

    # -- sources ------------------------------------------------------------
    def sources(self, pid: str) -> list[Source]:
        base = self.pdir(pid) / "sources"
        out = []
        if base.exists():
            for d in base.iterdir():
                f = d / "source.json"
                if f.exists():
                    out.append(Source.from_dict(json.loads(f.read_text())))
        return sorted(out, key=lambda s: s.added)

    def source(self, pid: str, sid: str) -> Source:
        f = self.sdir(pid, sid) / "source.json"
        if not f.exists():
            raise KeyError(sid)
        return Source.from_dict(json.loads(f.read_text()))

    def save_source(self, pid: str, s: Source) -> None:
        d = self.sdir(pid, s.id)
        d.mkdir(parents=True, exist_ok=True)
        _write_json(d / "source.json", asdict(s))

    def set_status(self, pid: str, sid: str, **kw) -> None:
        with self.lock:
            s = self.source(pid, sid)
            for k, v in kw.items():
                setattr(s, k, v)
            self.save_source(pid, s)

    def add_upload(self, pid: str, filename: str, stream, length: int) -> Source:
        self.project(pid)
        name = Path(filename).name or "video.mp4"
        if Path(name).suffix.lower() not in VIDEO_EXT:
            raise ValueError(f"{name}: not a video file")
        s = Source(id=_id(), name=name, path="")
        d = self.sdir(pid, s.id)
        d.mkdir(parents=True)
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name)
        dest = d / f"source-{safe}"
        left = length
        with open(dest, "wb") as f:
            while left > 0:
                chunk = stream.read(min(4 << 20, left))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        if left > 0:
            shutil.rmtree(d, ignore_errors=True)
            raise ValueError("Upload was interrupted")
        s.path = str(dest.resolve())
        self.save_source(pid, s)
        self.enqueue_process(pid, s.id)
        return s

    def add_path(self, pid: str, path: str) -> Source:
        self.project(pid)
        p = Path(path.strip().strip('"').strip("'")).expanduser()
        if not p.is_file():
            raise ValueError(f"File not found: {p}")
        if p.suffix.lower() not in VIDEO_EXT:
            raise ValueError(f"{p.name}: not a video file")
        s = Source(id=_id(), name=p.name, path=str(p.resolve()), linked=True)
        self.save_source(pid, s)
        self.enqueue_process(pid, s.id)
        return s

    def add_url(self, pid: str, url: str) -> Source:
        self.project(pid)
        if not media.is_url(url):
            raise ValueError("Not a URL")
        s = Source(id=_id(), name=url, path="", url=url)
        self.save_source(pid, s)
        self.enqueue_process(pid, s.id)
        return s

    def delete_source(self, pid: str, sid: str) -> None:
        with self.lock:
            self._pipelines.pop((pid, sid), None)
        shutil.rmtree(self.sdir(pid, sid), ignore_errors=True)

    # -- pipelines ------------------------------------------------------------
    def options(self, pid: str, sid: str) -> Options:
        p, s = self.project(pid), self.source(pid, sid)
        return Options(
            source=s.path or s.url, out_override=self.sdir(pid, sid), brief=p.brief, tone=p.tone,
            count=p.count, min_len=p.min_len, max_len=p.max_len, target_len=p.target_len,
            style=p.style, hook_mode=p.hook_mode, copy_extra=p.copy_notes, two_shot=p.two_shot,
            crosstalk=p.crosstalk, whisper_model=p.whisper_model, language=p.language or None,
            review=True, preset="medium",
        )

    def pipeline(self, pid: str, sid: str, prepare: bool = True) -> Project:
        key = (pid, sid)
        with self.lock:
            pl = self._pipelines.get(key)
            if pl is None:
                pl = Project(self.options(pid, sid))
                pl.prepared = False
                self._pipelines[key] = pl
        if prepare and not pl.prepared:
            pl.prepare()
            if pl.state_path.exists():
                pl.clips = [clip_from_dict(d) for d in json.loads(pl.state_path.read_text())]
            pl.prepared = True
        return pl

    # -- job queue ----------------------------------------------------------
    def enqueue_process(self, pid: str, sid: str, reselect: bool = False) -> None:
        self.set_status(pid, sid, status="queued", stage="waiting", error="")
        self.q.put(("process", pid, sid, reselect))

    def enqueue_clips(self, kind: str, pid: str, sid: str, idxs: list[int]) -> None:
        for i in idxs:
            self.clip_jobs[(pid, sid, i)] = {"state": "queued", "kind": kind, "msg": "", "error": ""}
        self.q.put((kind, pid, sid, idxs))

    def _resume(self) -> None:
        """Re-queue sources that were mid-processing when the studio last stopped."""
        for p in self.projects():
            for s in self.sources(p.id):
                if s.status in ("queued", "processing"):
                    self.enqueue_process(p.id, s.id)

    def _worker(self) -> None:
        while True:
            job = self.q.get()
            try:
                if job[0] == "process":
                    self._process(*job[1:])
                else:
                    self._clip_job(*job)
            except Exception:
                traceback.print_exc()

    def _process(self, pid: str, sid: str, reselect: bool) -> None:
        try:
            self.source(pid, sid)
        except KeyError:
            return  # deleted while queued
        stage = lambda m: self.set_status(pid, sid, status="processing", stage=m)  # noqa: E731
        try:
            stage("probing")
            with self.lock:
                self._pipelines.pop((pid, sid), None)
            pl = self.pipeline(pid, sid, prepare=False)
            pl.on_progress = stage
            pl.prepare()
            pl.prepared = True
            s = self.source(pid, sid)
            if s.url and not s.path:
                s.path, s.name = str(pl.src.resolve()), pl.src.name
            s.duration = pl.info.duration
            self.save_source(pid, s)
            if pl.state_path.exists() and not reselect:
                pl.clips = [clip_from_dict(d) for d in json.loads(pl.state_path.read_text())]
            else:
                self._select(pl, keep_existing=reselect)
            if not pl.clips:
                self.set_status(pid, sid, status="ready", stage="no clips found")
                return
            todo = [c for c in pl.clips if not c.file and c.status != "rejected"]
            if self.project(pid).auto_render and todo:
                stage("writing post copy")
                try:
                    pl.ensure_copy(todo)
                except Exception as e:
                    log(f"post copy failed: {e}")
                for n, c in enumerate(todo, 1):
                    key = (pid, sid, c.index)
                    self.clip_jobs[key] = {"state": "running", "kind": "render", "msg": "", "error": ""}
                    stage(f"rendering clip {n} of {len(todo)}")
                    try:
                        pl.render(c, progress=lambda m, k=key: self.clip_jobs[k].update(msg=m))
                        self.clip_jobs[key].update(state="done", msg="")
                    except Exception as e:
                        traceback.print_exc()
                        self.clip_jobs[key].update(state="error", error=str(e)[-500:], msg="")
            pl.write_summary()
            self.set_status(pid, sid, status="ready", stage="")
        except Exception as e:
            traceback.print_exc()
            self.set_status(pid, sid, status="error", stage="", error=str(e)[-800:])

    def _select(self, pl: Project, keep_existing: bool) -> None:
        o = pl.opts
        pl.note("finding clips with Claude")
        cands = find_moments(pl.transcript, brief=o.brief, tone=o.tone, count=o.count,
                             min_len=o.min_len, max_len=o.max_len, target_len=o.target_len,
                             model=o.model, effort=o.effort)
        new = dedupe([r for c in cands if (r := refine(c, pl.transcript, o.min_len, o.max_len))])
        keep = [c for c in pl.clips if c.status == "approved" or c.posts] if keep_existing else []
        # drop new candidates that overlap a kept clip
        new = [c for c in new if all(min(c.end, k.end) - max(c.start, k.start) < 0.25 * c.duration
                                     for k in keep)][: o.count]
        if o.style != "auto":
            for c in new:
                c.style = o.style
        for c in new:
            if c.style not in PRESETS:
                c.style = "bold"
        nxt = max([c.index for c in keep] + [0]) + 1
        for c in sorted(new, key=lambda c: c.start):
            c.index = nxt
            nxt += 1
        removed = [c for c in pl.clips if c not in keep]
        for c in removed:
            if c.file:
                for ext in (".mp4", ".jpg", ".srt", ".post.json"):
                    (pl.out / (Path(c.file).stem + ext)).unlink(missing_ok=True)
        pl.clips = keep + new
        pl.save()

    def _clip_job(self, kind: str, pid: str, sid: str, idxs: list[int]) -> None:
        try:
            pl = self.pipeline(pid, sid)
        except Exception as e:
            for i in idxs:
                self.clip_jobs[(pid, sid, i)] = {"state": "error", "error": str(e), "msg": "", "kind": kind}
            return
        clips = [c for c in pl.clips if c.index in idxs]
        try:
            for c in clips:
                self.clip_jobs[(pid, sid, c.index)].update(state="running", msg="writing post copy")
            pl.ensure_copy(clips, force=(kind == "copy"))
        except Exception as e:
            for c in clips:
                self.clip_jobs[(pid, sid, c.index)].update(error=f"post copy failed: {e}")
        for c in clips:
            job = self.clip_jobs[(pid, sid, c.index)]
            if kind != "render":
                job.update(state="done", msg="")
                continue
            try:
                job.update(state="running", msg="starting")
                pl.render(c, progress=lambda m, j=job: j.update(msg=m))
                job.update(state="done", msg="")
            except Exception as e:
                traceback.print_exc()
                job.update(state="error", error=str(e)[-600:], msg="")
        pl.write_summary()

    # -- preview proxy --------------------------------------------------------
    def preview_path(self, pid: str, sid: str) -> Path | None:
        """Browser-playable version of the source (made once, in the background)."""
        s = self.source(pid, sid)
        if not s.path:
            return None
        src = Path(s.path)
        proxy = self.sdir(pid, sid) / ".work" / "preview.mp4"
        if proxy.exists():
            return proxy
        key = (pid, sid)
        state = self.proxy_state.get(key)
        if state == "direct":
            return src
        if state == "making":
            return None
        try:
            out = media.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name",
                             "-of", "json", str(src)]).stdout
            streams = json.loads(out)["streams"]
            v = {x["codec_name"] for x in streams if x["codec_type"] == "video"}
            a = {x["codec_name"] for x in streams if x["codec_type"] == "audio"}
            if src.suffix.lower() in {".mp4", ".m4v", ".mov", ".webm"} and v <= BROWSER_VIDEO \
                    and (not a or a <= BROWSER_AUDIO):
                self.proxy_state[key] = "direct"
                return src
        except Exception:
            pass
        self.proxy_state[key] = "making"

        def make():
            import subprocess
            proxy.parent.mkdir(parents=True, exist_ok=True)
            tmp = proxy.with_suffix(".tmp.mp4")
            r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vf", "scale=-2:540",
                                "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-c:a", "aac",
                                "-b:a", "128k", "-movflags", "+faststart", str(tmp)])
            if r.returncode == 0:
                tmp.replace(proxy)
            self.proxy_state[key] = "done" if r.returncode == 0 else "failed"

        threading.Thread(target=make, daemon=True).start()
        return None

    # -- payloads -----------------------------------------------------------
    def clip_payload(self, pid: str, sid: str, pl: Project | None, c: Clip, full: bool) -> dict:
        d = c.to_dict()
        d["pid"], d["sid"] = pid, sid
        out = self.sdir(pid, sid)
        d["rendered"] = bool(c.file) and (out / c.file).exists()
        if pl is not None and pl.prepared:
            d["outdated"] = d["rendered"] and c.render_sig != pl.render_sig(c)
            d["copy_outdated"] = bool(c.copy) and c.copy_sig != pl.copy_sig(c)
            if full:
                d["text"] = pl.clip_text(c)
        d["job"] = self.clip_jobs.get((pid, sid, c.index))
        d["thumb"] = f"/media/{pid}/{sid}/{Path(c.file).stem}.jpg" if d["rendered"] else ""
        d["video"] = f"/media/{pid}/{sid}/{c.file}?v={c.render_sig}" if d["rendered"] else ""
        return d

    def project_payload(self, pid: str) -> dict:
        p = self.project(pid)
        srcs, clips = [], []
        for s in self.sources(pid):
            sd = asdict(s)
            sd["clips"] = 0
            pl = self._pipelines.get((pid, s.id))
            state = self.sdir(pid, s.id) / "clips.json"
            if pl is not None and pl.prepared:
                cl = pl.clips
            elif state.exists():
                cl = [clip_from_dict(d) for d in json.loads(state.read_text())]
            else:
                cl = []
            sd["clips"] = len(cl)
            srcs.append(sd)
            for c in cl:
                d = self.clip_payload(pid, s.id, pl, c, full=False)
                d["source_name"] = s.name
                clips.append(d)
        return {"project": asdict(p), "sources": srcs, "clips": clips}

    def summary(self) -> list[dict]:
        out = []
        for p in self.projects():
            srcs = self.sources(p.id)
            n_clips = n_posted = views = 0
            busy = sum(s.status in ("queued", "processing") for s in srcs)
            for s in srcs:
                f = self.sdir(p.id, s.id) / "clips.json"
                if f.exists():
                    for d in json.loads(f.read_text()):
                        n_clips += 1
                        posts = d.get("posts") or {}
                        if posts:
                            n_posted += 1
                        views += sum(int(v.get("views") or 0) for v in posts.values())
            out.append({**asdict(p), "sources": len(srcs), "clips": n_clips, "posted": n_posted,
                        "views": views, "busy": busy})
        return out

    # -- clip edits ---------------------------------------------------------
    def update_clip(self, pid: str, sid: str, idx: int, body: dict) -> None:
        pl = self.pipeline(pid, sid)
        c = next((c for c in pl.clips if c.index == idx), None)
        if c is None:
            raise KeyError(idx)
        dur = pl.info.duration
        with pl.lock:
            if "start" in body:
                c.start = round(min(max(0.0, float(body["start"])), dur), 3)
            if "end" in body:
                c.end = round(min(max(0.0, float(body["end"])), dur), 3)
            if c.end <= c.start + 1:
                c.end = round(min(dur, c.start + 1), 3)
            for k in ("title", "hook"):
                if k in body:
                    setattr(c, k, str(body[k])[:200])
            if body.get("style") in PRESETS:
                c.style = body["style"]
            if body.get("status") in ("pending", "approved", "rejected"):
                c.status = body["status"]
            if isinstance(body.get("copy"), dict):
                c.copy = body["copy"]
                c.copy_sig = pl.copy_sig(c)
                (pl.out / f"{c.slug}.post.json").write_text(json.dumps(c.copy, indent=2, ensure_ascii=False))
            if isinstance(body.get("post"), dict):
                self._update_post(c, body["post"])
        pl.save()
        pl.write_summary()

    @staticmethod
    def _update_post(c: Clip, post: dict) -> None:
        plat = post.get("platform")
        if plat not in PLATFORMS:
            raise ValueError("unknown platform")
        if post.get("remove"):
            c.posts.pop(plat, None)
            return
        cur = dict(c.posts.get(plat) or {})
        if "url" in post:
            cur["url"] = str(post["url"]).strip()[:500]
        if "posted_at" in post:
            cur["posted_at"] = str(post["posted_at"])[:20]
        cur.setdefault("posted_at", time.strftime("%Y-%m-%d"))
        changed = False
        for m in METRICS:
            if m in post:
                v = str(post[m]).replace(",", "").strip()
                cur[m] = int(float(v)) if v else None
                changed = True
        if changed:
            cur["updated"] = time.strftime("%Y-%m-%d %H:%M")
            hist = cur.setdefault("history", [])
            snap = {"at": cur["updated"], **{m: cur.get(m) for m in METRICS}}
            if not hist or hist[-1]["at"][:10] != snap["at"][:10]:
                hist.append(snap)
            else:
                hist[-1] = snap
        c.posts[plat] = cur

    def new_clip(self, pid: str, sid: str, start: float, end: float) -> int:
        pl = self.pipeline(pid, sid)
        p = self.project(pid)
        with pl.lock:
            idx = max([c.index for c in pl.clips] + [0]) + 1
            pl.clips.append(Clip(start=round(start, 3), end=round(end, 3), title=f"Clip {idx}",
                                 rationale="added by hand", score=0, index=idx, status="approved",
                                 style=p.style if p.style in PRESETS else "bold"))
        pl.save()
        return idx

    def delete_clip(self, pid: str, sid: str, idx: int) -> None:
        pl = self.pipeline(pid, sid)
        with pl.lock:
            c = next((c for c in pl.clips if c.index == idx), None)
            if c and c.file:
                for ext in (".mp4", ".jpg", ".srt", ".post.json"):
                    (pl.out / (Path(c.file).stem + ext)).unlink(missing_ok=True)
            pl.clips = [c for c in pl.clips if c.index != idx]
        pl.save()


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _make_handler(ws: Workspace):
    class H(BaseHTTPRequestHandler):
        server_version = "clip-studio"
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def _file(self, path: Path, download: str | None = None):
            size = path.stat().st_size
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if path.suffix.lower() == ".mov":
                ctype = "video/mp4"
            rng = self.headers.get("Range")
            start, end = 0, size - 1
            if rng and (m := re.match(r"bytes=(\d*)-(\d*)", rng)):
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                if start > end:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Cache-Control", "no-cache")
            if download:
                self.send_header("Content-Disposition", f'attachment; filename="{download}"')
            self.end_headers()
            try:
                with open(path, "rb") as f:
                    f.seek(start)
                    left = end - start + 1
                    while left > 0:
                        chunk = f.read(min(1 << 20, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            parts = [unquote(x) for x in u.path.strip("/").split("/")] if u.path != "/" else []
            try:
                if not parts:
                    data = PAGE.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                elif parts == ["api", "projects"]:
                    self._json({"projects": ws.summary(), "styles": {k: v.description for k, v in PRESETS.items()},
                                "workspace": str(ws.root)})
                elif len(parts) == 3 and parts[:2] == ["api", "p"]:
                    self._json(ws.project_payload(parts[2]))
                elif len(parts) == 7 and parts[:2] == ["api", "p"] and parts[3] == "s" and parts[5] == "c":
                    pid, sid, idx = parts[2], parts[4], int(parts[6])
                    pl = ws.pipeline(pid, sid)
                    c = next((c for c in pl.clips if c.index == idx), None)
                    if c is None:
                        raise KeyError(idx)
                    src = ws.source(pid, sid)
                    prev = ws.preview_path(pid, sid)
                    self._json({
                        "clip": ws.clip_payload(pid, sid, pl, c, full=True),
                        "source": {"name": src.name, "duration": pl.info.duration,
                                   "preview": f"/preview/{pid}/{sid}" if prev else ""},
                        "siblings": [x.index for x in sorted(pl.clips, key=lambda x: x.start)],
                        "limits": {"min": pl.opts.min_len, "max": pl.opts.max_len},
                    })
                elif len(parts) == 6 and parts[:2] == ["api", "p"] and parts[3] == "s" and parts[5] == "words":
                    pl = ws.pipeline(parts[2], parts[4])
                    a, b = float(q["start"][0]), float(q["end"][0])
                    self._json([[w.text, w.start, w.end] for w in pl.transcript.words_between(a, b)])
                elif len(parts) == 3 and parts[0] == "preview":
                    prev = ws.preview_path(parts[1], parts[2])
                    if prev is None:
                        self._json({"error": "preview not ready"}, 503)
                    else:
                        self._file(prev)
                elif len(parts) == 4 and parts[0] in ("media", "download"):
                    d = ws.sdir(parts[1], parts[2]).resolve()
                    target = (d / parts[3]).resolve()
                    if target.parent != d or not target.is_file() or target.name.startswith("source-"):
                        self._json({"error": "not found"}, 404)
                    else:
                        self._file(target, download=target.name if parts[0] == "download" else None)
                else:
                    self._json({"error": "not found"}, 404)
            except KeyError as e:
                self._json({"error": f"not found: {e}"}, 404)
            except Exception as e:
                traceback.print_exc()
                self._json({"error": str(e)}, 500)

        def do_POST(self):
            u = urlparse(self.path)
            parts = [unquote(x) for x in u.path.strip("/").split("/")]
            try:
                if parts == ["api", "projects"]:
                    self._json(asdict(ws.create_project(self._body())))
                elif len(parts) == 3 and parts[:2] == ["api", "p"]:
                    self._json(asdict(ws.update_project(parts[2], self._body())))
                elif len(parts) == 4 and parts[:2] == ["api", "p"] and parts[3] == "delete":
                    ws.delete_project(parts[2])
                    self._json({"ok": True})
                elif len(parts) == 4 and parts[:2] == ["api", "p"] and parts[3] == "upload":
                    name = unquote(self.headers.get("X-Filename") or "video.mp4")
                    n = int(self.headers.get("Content-Length") or 0)
                    self._json(asdict(ws.add_upload(parts[2], name, self.rfile, n)))
                elif len(parts) == 4 and parts[:2] == ["api", "p"] and parts[3] == "add":
                    b = self._body()
                    s = ws.add_url(parts[2], b["url"]) if b.get("url") else ws.add_path(parts[2], b.get("path", ""))
                    self._json(asdict(s))
                elif len(parts) == 6 and parts[:2] == ["api", "p"] and parts[3] == "s":
                    pid, sid, action = parts[2], parts[4], parts[5]
                    body = self._body()
                    if action == "delete":
                        ws.delete_source(pid, sid)
                    elif action == "reprocess":
                        ws.enqueue_process(pid, sid, reselect=bool(body.get("reselect")))
                    elif action == "render":
                        ws.enqueue_clips("render", pid, sid, [int(i) for i in body.get("indices", [])])
                    elif action == "copy":
                        ws.enqueue_clips("copy", pid, sid, [int(i) for i in body.get("indices", [])])
                    elif action == "newclip":
                        self._json({"index": ws.new_clip(pid, sid, float(body["start"]), float(body["end"]))})
                        return
                    else:
                        raise KeyError(action)
                    self._json({"ok": True})
                elif len(parts) == 7 and parts[:2] == ["api", "p"] and parts[3] == "s" and parts[5] == "c":
                    ws.update_clip(parts[2], parts[4], int(parts[6]), self._body())
                    self._json({"ok": True})
                elif len(parts) == 8 and parts[:2] == ["api", "p"] and parts[3] == "s" and parts[5] == "c" \
                        and parts[7] == "delete":
                    ws.delete_clip(parts[2], parts[4], int(parts[6]))
                    self._json({"ok": True})
                else:
                    self._json({"error": "not found"}, 404)
            except KeyError as e:
                self._json({"error": f"not found: {e}"}, 404)
            except ValueError as e:
                self._json({"error": str(e)}, 400)
            except Exception as e:
                traceback.print_exc()
                self._json({"error": str(e)}, 500)

    return H


def serve(root: Path, port: int = 8765, open_browser: bool = True) -> None:
    media.require_tools()
    ws = Workspace(root.expanduser())
    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), _make_handler(ws))
            break
        except OSError:
            continue
    if httpd is None:
        raise media.MediaError(f"No free port in {port}-{port + 19}")
    httpd.daemon_threads = True
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    log(f"Clip Studio running at {url}")
    log(f"workspace: {ws.root}")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        httpd.server_close()
