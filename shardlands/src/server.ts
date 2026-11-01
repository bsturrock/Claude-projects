import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCliAvailable, type Effort } from "./agents/cli.js";
import { divergence } from "./divergence.js";
import { League, MODELS, TEAM_NAMES, type Backend } from "./league.js";
import { listRulesets } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const PORT = Number(process.env.PORT ?? 3000);
const cli = claudeCliAvailable();

type Ev = { type: string; seq?: number; [k: string]: unknown };
let events: Ev[] = [];
let seq = 0;
const clients = new Set<ServerResponse>();
const run = { active: false, league: "", game: 0, games: 0, paused: false, stop: false, error: "" };
let resumeWaiters: (() => void)[] = [];

function push(e: Ev) {
  if (e.type === "start") events = [];
  const ev = { ...e, seq: seq++ };
  events.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(line);
}
function pushStatus() {
  push({ type: "status", run: { ...run } });
}

async function gate() {
  if (run.stop) throw new Error("stopped");
  while (run.paused) await new Promise<void>((r) => resumeWaiters.push(r));
  if (run.stop) throw new Error("stopped");
}

async function runLeague(name: string, games: number) {
  const league = League.open(name);
  Object.assign(run, { active: true, league: name, game: 0, games, paused: false, stop: false, error: "" });
  pushStatus();
  try {
    for (let i = 0; i < games && !run.stop; i++) {
      run.game = i + 1;
      pushStatus();
      await league.playGame({ emit: push, gate, log: (s) => console.log(s) });
    }
  } catch (err) {
    if (!String(err).includes("stopped")) {
      run.error = String(err).slice(0, 400);
      console.error(err);
    }
  } finally {
    run.active = false;
    run.paused = false;
    pushStatus();
  }
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "status", run })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/api/meta") return json(res, 200, { models: MODELS, rulesets: listRulesets(), cli, maxTeams: TEAM_NAMES.length, run, apiKey: !!process.env.ANTHROPIC_API_KEY });
    if (p === "/api/leagues" && req.method === "GET")
      return json(res, 200, League.list().map((n) => {
        const l = League.open(n);
        return { name: n, settings: l.file.settings, teams: l.file.teams, games: l.results().length };
      }));
    if (p === "/api/leagues" && req.method === "POST") {
      const b = await body(req);
      const l = League.create(String(b.name), Number(b.teams ?? 4), {
        backend: (b.backend ?? "claude-code") as Backend,
        model: b.model ?? MODELS[0],
        debriefModel: b.debriefModel || undefined,
        effort: (b.effort ?? "low") as Effort,
        interface: b.interface === "json" ? "json" : "cli",
        council: b.council !== false,
        ruleset: b.ruleset ?? "standard",
        turns: b.turns ? Number(b.turns) : undefined,
        concurrency: Number(b.concurrency ?? 8),
      });
      return json(res, 200, { name: l.file.name });
    }
    const m = p.match(/^\/api\/league\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const l = League.open(decodeURIComponent(m[1]));
      const sub = m[2] ?? "";
      if (!sub)
        return json(res, 200, {
          file: l.file,
          ratings: l.ratings(),
          results: l.results(),
          playbooks: Object.fromEntries(l.file.teams.map((t) => [t.id, l.playbook(t.id)])),
          memories: Object.fromEntries(l.file.teams.flatMap((t) => t.agents.map((a) => [a, l.memory(a)]))),
          divergence: divergence(l),
        });
      if (sub.startsWith("history/")) return json(res, 200, l.history(sub.slice(8)));
      if (sub.startsWith("game/")) {
        const g = l.gameLog(sub.slice(5));
        return g ? json(res, 200, g) : json(res, 404, { error: "no such game" });
      }
      if (sub === "run" && req.method === "POST") {
        if (run.active) return json(res, 409, { error: "a league is already running" });
        const b = await body(req);
        void runLeague(l.file.name, Math.max(1, Math.min(100, Number(b.games ?? 1))));
        return json(res, 200, { ok: true });
      }
    }
    if (p === "/api/pause") {
      run.paused = true;
      pushStatus();
      return json(res, 200, run);
    }
    if (p === "/api/resume") {
      run.paused = false;
      resumeWaiters.splice(0).forEach((r) => r());
      pushStatus();
      return json(res, 200, run);
    }
    if (p === "/api/stop") {
      run.stop = true;
      run.paused = false;
      resumeWaiters.splice(0).forEach((r) => r());
      pushStatus();
      return json(res, 200, run);
    }
    const file = path.join(publicDir, p === "/" ? "index.html" : p);
    if (!file.startsWith(publicDir) || !existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (err) {
    json(res, 400, { error: String(err instanceof Error ? err.message : err) });
  }
}).listen(PORT, () => {
  console.log(`Shardlands spectator on http://localhost:${PORT}`);
  console.log(cli.ok ? `Claude Code found: ${cli.version}` : "Claude Code not found on PATH (claude-code backend unavailable)");
});
