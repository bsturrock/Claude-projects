import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "./engine.js";
import { MockAgent } from "./agents/mock.js";
import { listRulesets } from "./ruleset.js";
import { MODELS, costOf, createGameParts, type GameConfig } from "./setup.js";
import type { UiEvent, Usage } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const logsDir = path.join(here, "..", "logs");
const PORT = Number(process.env.PORT ?? 3000);

let events: UiEvent[] = [];
let seq = 0;
const clients = new Set<ServerResponse>();
let game: Game | null = null;
let paused = false;
let stopped = false;
let resumeWaiters: (() => void)[] = [];

function push(e: Omit<UiEvent, "seq" | "t">) {
  const ev = { ...e, seq: seq++, t: Date.now() } as UiEvent;
  if (ev.type === "state") {
    const st = ev.state as {
      players: { model: string; usage: Usage }[];
      narrator: { model: string; usage: Usage } | null;
      usd?: number;
    };
    st.usd =
      st.players.reduce((a, p) => a + costOf(p.model, p.usage), 0) +
      (st.narrator ? costOf(st.narrator.model, st.narrator.usage) : 0);
  }
  events.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(line);
}

async function gate() {
  if (stopped) throw new Error("stopped");
  while (paused) await new Promise<void>((r) => resumeWaiters.push(r));
  if (stopped) throw new Error("stopped");
}

async function startGame(cfg: GameConfig) {
  stopped = true;
  paused = false;
  resumeWaiters.splice(0).forEach((r) => r());
  await new Promise((r) => setTimeout(r, 50));
  stopped = false;
  events = [];
  push({ type: "reset", to: null, config: cfg });
  let parts: ReturnType<typeof createGameParts>;
  try {
    parts = createGameParts(cfg);
  } catch (err) {
    push({ type: "error", to: null, text: `Could not start: ${String(err)}` });
    return;
  }
  const { rules, players, agents, narrator } = parts;
  MockAgent.delayMs = cfg.model === "mock" ? 250 : 0;
  const g = new Game({ rules, players, agents, narrator, emit: push, gate, paceMs: cfg.model === "mock" ? 500 : 0 });
  game = g;
  push({ type: "players", to: null, players: players.map((p) => ({ id: p.id, name: p.name, model: p.model, persona: p.persona })) });
  try {
    await g.run();
  } catch (err) {
    if (String(err).includes("stopped")) return;
    push({ type: "error", to: null, text: `Game crashed: ${String(err)}` });
  } finally {
    if (game === g) {
      const cost =
        players.reduce((a, p) => a + costOf(p.model, agents[p.id].usage), 0) +
        (narrator ? costOf(narrator.model, narrator.usage) : 0);
      push({ type: "cost", to: null, usd: cost });
      mkdirSync(logsDir, { recursive: true });
      const file = path.join(logsDir, `game-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      writeFileSync(
        file,
        JSON.stringify({ config: cfg, ruleset: rules, winner: g.winner, reason: g.winReason, summary: g.gameSummary, usd: cost, events }),
      );
    }
  }
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/api/config") {
    return json(res, 200, {
      models: MODELS,
      rulesets: listRulesets(),
      hasKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    if (url.pathname === "/api/start") {
      const cfg: GameConfig = {
        numPlayers: Number(data.numPlayers ?? 7),
        model: String(data.model ?? "claude-opus-5-5"),
        effort: data.effort ?? "medium",
        ruleset: String(data.ruleset ?? "supply-crate"),
        narrator: data.narrator !== false,
      };
      void startGame(cfg);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/pause") {
      paused = true;
      push({ type: "paused", to: null, paused });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/resume") {
      paused = false;
      resumeWaiters.splice(0).forEach((r) => r());
      push({ type: "paused", to: null, paused });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/stop") {
      stopped = true;
      paused = false;
      resumeWaiters.splice(0).forEach((r) => r());
      push({ type: "system", to: null, text: "Game stopped by spectator." });
      return json(res, 200, { ok: true });
    }
  }
  if (url.pathname === "/api/logs") {
    let files: string[] = [];
    try {
      files = readdirSync(logsDir).filter((f) => f.endsWith(".json")).sort().reverse();
    } catch {}
    const list = files.slice(0, 50).map((f) => {
      try {
        const d = JSON.parse(readFileSync(path.join(logsDir, f), "utf8"));
        return { file: f, winner: d.winner, model: d.config?.model, players: d.config?.numPlayers, ruleset: d.ruleset?.name };
      } catch {
        return { file: f };
      }
    });
    return json(res, 200, list);
  }
  const isLog = url.pathname.startsWith("/logs/");
  const baseDir = isLog ? logsDir : publicDir;
  const file = isLog ? url.pathname.slice("/logs/".length) : url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(baseDir, path.normalize(file));
  if (!full.startsWith(baseDir + path.sep)) return json(res, 403, { error: "forbidden" });
  let buf: Buffer;
  try {
    buf = readFileSync(full);
  } catch {
    return json(res, 404, { error: "not found" });
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(full)] ?? "application/octet-stream" });
  res.end(buf);
}).listen(PORT, () => console.log(`Breach Protocol spectator UI: http://localhost:${PORT}`));
