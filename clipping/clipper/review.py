"""Local review UI: inspect, trim, restyle, approve and render clips in a browser.

Standard library only. Binds to 127.0.0.1. Run via `clipper SOURCE --review`.
"""

from __future__ import annotations

import json
import mimetypes
import queue
import re
import subprocess
import threading
import traceback
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import media
from .captions import PRESETS
from .pipeline import Project, log
from .selection import Clip

PAGE = Path(__file__).parent / "review.html"
BROWSER_VIDEO = {"h264", "vp8", "vp9", "av1"}
BROWSER_AUDIO = {"aac", "mp3", "opus", "vorbis"}
BROWSER_CONTAINERS = {".mp4", ".m4v", ".mov", ".webm"}


class ReviewState:
    def __init__(self, project: Project):
        self.p = project
        self.jobs: dict[int, dict] = {}
        self.q: queue.Queue = queue.Queue()
        self.proxy: Path | None = None
        self.proxy_ready = threading.Event()
        threading.Thread(target=self._worker, daemon=True).start()
        threading.Thread(target=self._make_proxy, daemon=True).start()

    # -- preview source ------------------------------------------------------
    def _make_proxy(self) -> None:
        src = self.p.src
        try:
            out = media.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name",
                             "-of", "json", str(src)]).stdout
            streams = json.loads(out)["streams"]
            v = {s["codec_name"] for s in streams if s["codec_type"] == "video"}
            a = {s["codec_name"] for s in streams if s["codec_type"] == "audio"}
            playable = (src.suffix.lower() in BROWSER_CONTAINERS and v <= BROWSER_VIDEO
                        and (not a or a <= BROWSER_AUDIO))
        except Exception:
            playable = False
        if playable:
            self.proxy = src
        else:
            proxy = self.p.work / "preview.mp4"
            if not proxy.exists():
                log("making a browser-friendly preview of the source (one-off)")
                tmp = proxy.with_suffix(".tmp.mp4")
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vf", "scale=-2:540",
                                "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
                                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(tmp)],
                               check=True)
                tmp.replace(proxy)
            self.proxy = proxy
        self.proxy_ready.set()

    # -- jobs ---------------------------------------------------------------
    def clip(self, idx: int) -> Clip:
        for c in self.p.clips:
            if c.index == idx:
                return c
        raise KeyError(idx)

    def enqueue(self, kind: str, idxs: list[int]) -> None:
        for i in idxs:
            self.jobs[i] = {"state": "queued", "kind": kind, "msg": "", "error": ""}
        self.q.put((kind, idxs))

    def _worker(self) -> None:
        while True:
            kind, idxs = self.q.get()
            clips = []
            for i in idxs:
                try:
                    clips.append(self.clip(i))
                except KeyError:
                    self.jobs.pop(i, None)
            try:
                if clips and kind in ("render", "copy"):
                    for c in clips:
                        self.jobs[c.index].update(state="running", msg="writing post copy")
                    self.p.ensure_copy(clips, force=(kind == "copy"))
            except Exception as e:
                for c in clips:
                    self.jobs[c.index].update(msg="", error=f"post copy failed: {e}")
            for c in clips:
                job = self.jobs[c.index]
                if kind != "render":
                    job.update(state="done", msg="")
                    continue
                try:
                    job.update(state="running", msg="starting")
                    self.p.render(c, progress=lambda m, j=job: j.update(msg=m))
                    job.update(state="done", msg="")
                except Exception as e:
                    traceback.print_exc()
                    job.update(state="error", error=str(e)[-600:], msg="")
            try:
                self.p.write_summary()
            except Exception:
                traceback.print_exc()

    # -- api payloads --------------------------------------------------------
    def state(self) -> dict:
        p = self.p
        clips = []
        for c in sorted(p.clips, key=lambda c: c.start):
            d = c.to_dict()
            d["text"] = p.clip_text(c)
            d["rendered"] = bool(c.file) and (p.out / c.file).exists()
            d["outdated"] = d["rendered"] and c.render_sig != p.render_sig(c)
            d["copy_outdated"] = bool(c.copy) and c.copy_sig != p.copy_sig(c)
            d["job"] = self.jobs.get(c.index)
            clips.append(d)
        return {
            "source": {"name": p.src.name, "duration": p.info.duration,
                       "ready": self.proxy_ready.is_set(), "url": "/media/source"},
            "styles": {k: v.description for k, v in PRESETS.items()},
            "brief": p.opts.brief, "tone": p.opts.tone, "out_dir": str(p.out.resolve()),
            "limits": {"min": p.opts.min_len, "max": p.opts.max_len},
            "copy_enabled": p.opts.write_post_copy,
            "clips": clips,
        }

    def words(self, start: float, end: float) -> list:
        return [[w.text, w.start, w.end] for w in self.p.transcript.words_between(start, end)]

    def update_clip(self, idx: int, body: dict) -> None:
        c = self.clip(idx)
        dur = self.p.info.duration
        with self.p.lock:
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
            if "copy" in body and isinstance(body["copy"], dict):
                c.copy = body["copy"]
                c.copy_sig = self.p.copy_sig(c)
                (self.p.out / f"{c.slug}.post.json").write_text(
                    json.dumps(c.copy, indent=2, ensure_ascii=False))
        self.p.save()

    def new_clip(self, start: float, end: float) -> int:
        with self.p.lock:
            idx = max([c.index for c in self.p.clips] + [0]) + 1
            c = Clip(start=round(start, 3), end=round(end, 3), title=f"Clip {idx}",
                     rationale="added in review", score=0, style=self.p.clips[0].style
                     if self.p.clips else "bold", index=idx, status="approved")
            self.p.clips.append(c)
        self.p.save()
        return idx

    def delete_clip(self, idx: int) -> None:
        with self.p.lock:
            self.p.clips = [c for c in self.p.clips if c.index != idx]
        self.p.save()


def _make_handler(st: ReviewState):
    class H(BaseHTTPRequestHandler):
        server_version = "clipper-review"

        def log_message(self, *a):  # quiet
            pass

        # -- helpers --
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

        def _file(self, path: Path):
            size = path.stat().st_size
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if path.suffix.lower() == ".mov":
                ctype = "video/mp4"  # lets Chrome play H.264 .mov files
            rng = self.headers.get("Range")
            start, end = 0, size - 1
            if rng and (m := re.match(r"bytes=(\d*)-(\d*)", rng)):
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = size - int(m.group(2))
                end = min(end, size - 1)
                if start > end:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{size}")
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

        # -- routes --
        def do_GET(self):
            u = urlparse(self.path)
            try:
                if u.path == "/":
                    data = PAGE.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                elif u.path == "/api/state":
                    self._json(st.state())
                elif u.path == "/api/words":
                    q = parse_qs(u.query)
                    self._json(st.words(float(q["start"][0]), float(q["end"][0])))
                elif u.path == "/media/source":
                    if not st.proxy_ready.is_set():
                        self._json({"error": "preview not ready"}, 503)
                    else:
                        self._file(st.proxy)
                elif u.path.startswith("/media/out/"):
                    name = u.path[len("/media/out/"):]
                    target = (st.p.out / name).resolve()
                    if "/" in name or "\\" in name or target.parent != st.p.out.resolve() \
                            or not target.is_file():
                        self._json({"error": "not found"}, 404)
                    else:
                        self._file(target)
                else:
                    self._json({"error": "not found"}, 404)
            except Exception as e:
                traceback.print_exc()
                self._json({"error": str(e)}, 500)

        def do_POST(self):
            u = urlparse(self.path)
            try:
                body = self._body()
                if m := re.fullmatch(r"/api/clip/(\d+)", u.path):
                    st.update_clip(int(m.group(1)), body)
                    self._json({"ok": True})
                elif m := re.fullmatch(r"/api/clip/(\d+)/delete", u.path):
                    st.delete_clip(int(m.group(1)))
                    self._json({"ok": True})
                elif u.path == "/api/clip/new":
                    self._json({"index": st.new_clip(float(body["start"]), float(body["end"]))})
                elif u.path == "/api/render":
                    st.enqueue("render", [int(i) for i in body.get("indices", [])])
                    self._json({"ok": True})
                elif u.path == "/api/copy":
                    st.enqueue("copy", [int(i) for i in body.get("indices", [])])
                    self._json({"ok": True})
                else:
                    self._json({"error": "not found"}, 404)
            except KeyError as e:
                self._json({"error": f"unknown clip {e}"}, 404)
            except Exception as e:
                traceback.print_exc()
                self._json({"error": str(e)}, 500)

    return H


def serve(project: Project, port: int = 8765, open_browser: bool = True) -> None:
    st = ReviewState(project)
    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), _make_handler(st))
            break
        except OSError:
            continue
    if httpd is None:
        raise media.MediaError(f"No free port in {port}-{port + 19}")
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    log(f"review UI at {url}  (Ctrl+C to stop; your edits are saved as you go)")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("stopping review server")
    finally:
        httpd.server_close()
        project.write_summary()
