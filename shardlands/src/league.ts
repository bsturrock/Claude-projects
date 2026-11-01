import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "./config.js";
import { DEFAULT_STYLE, MockAgent, type MockStyle } from "./agents/mock.js";
import { ApiCliAgent, ApiCompleter, ClaudeCodeCliAgent, CliCompleter, JsonAgent, agentSystemPrompt, type AgentInterface, type Completer } from "./agents/llm.js";
import type { Effort } from "./agents/cli.js";
import { gameReport, llmDebrief, mockDebrief, mockPlaybook, type DebriefResult, type TeamRecord } from "./debrief.js";
import { Match, type MatchLog, type UiEmit } from "./match.js";
import { styleVector, updateElo, type StyleVector } from "./metrics.js";
import { rulesText } from "./rules.js";
import { rng } from "./hex.js";
import type { Agent, Usage, VpBreakdown } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const LEAGUES_DIR = process.env.SHARD_LEAGUES_DIR ?? path.join(here, "..", "leagues");

export type Backend = "claude-code" | "api" | "mock";

export interface LeagueSettings {
  backend: Backend;
  model: string;
  /** Model for debriefs (reflection + playbook editing). Defaults to the game model. */
  debriefModel?: string;
  effort: Effort;
  /** "cli": agents act through the shard CLI (tool use, default). "json": one JSON answer per phase (cheaper). */
  interface: AgentInterface;
  council: boolean;
  ruleset: string;
  /** Override the ruleset's turn limit. */
  turns?: number;
  /** Max concurrent agent calls. */
  concurrency: number;
}

export interface LeagueFile {
  name: string;
  created: string;
  settings: LeagueSettings;
  teams: TeamRecord[];
}

export interface ResultRow {
  game: string;
  number: number;
  date: string;
  seed: number;
  /** [north, south]. */
  seats: string[];
  /** [winner, loser]; on a draw, ordered by stockpile. */
  ranking: string[];
  winner: string | null;
  draw: boolean;
  turns: number;
  scores: Record<string, VpBreakdown>;
  styles: Record<string, StyleVector>;
  ratings: Record<string, number>;
  changelogs: Record<string, string>;
  usd: number;
}

export const TEAM_NAMES = ["Amber", "Cobalt", "Verdant", "Crimson", "Ivory", "Onyx", "Saffron", "Slate"];

const zeroUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 });

export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];

/** USD per million tokens [input, cache write, cache read, output]. Used only when the backend reports no cost. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 5, 0.2, 20],
  "claude-sonnet-5-5": [2, 2.5, 0.2, 10],
  "claude-haiku-5-5": [0.1, 0.125, 0.01, 0.5],
};
export function costOf(model: string, u: Usage): number {
  if (u.usd !== undefined) return u.usd;
  const p = PRICES[model];
  if (!p) return 0;
  return (u.input * p[0] + u.cacheWrite * p[1] + u.cacheRead * p[2] + u.output * p[3]) / 1e6;
}

export class League {
  dir: string;
  file: LeagueFile;

  private constructor(dir: string, file: LeagueFile) {
    this.dir = dir;
    this.file = file;
  }

  static list(): string[] {
    if (!existsSync(LEAGUES_DIR)) return [];
    return readdirSync(LEAGUES_DIR).filter((d) => existsSync(path.join(LEAGUES_DIR, d, "league.json")));
  }

  static create(name: string, numTeams: number, settings: LeagueSettings): League {
    if (!/^[a-z0-9-_]+$/i.test(name)) throw new Error("league name: letters, digits, - and _ only");
    const dir = path.join(LEAGUES_DIR, name);
    if (existsSync(path.join(dir, "league.json"))) throw new Error(`league "${name}" already exists`);
    if (numTeams < 2 || numTeams > TEAM_NAMES.length) throw new Error(`teams must be 2-${TEAM_NAMES.length}`);
    const size = loadRuleset(settings.ruleset).agentsPerTeam;
    const teams: TeamRecord[] = TEAM_NAMES.slice(0, numTeams).map((n) => {
      const id = n.toLowerCase();
      return { id, name: n, agents: "abcdefgh".slice(0, size).split("").map((x) => `${id}-${x}`) };
    });
    mkdirSync(path.join(dir, "games"), { recursive: true });
    for (const t of teams) {
      mkdirSync(path.join(dir, "teams", t.id, "history"), { recursive: true });
      writeFileSync(path.join(dir, "teams", t.id, "playbook.md"), "");
      for (const a of t.agents) writeFileSync(path.join(dir, "teams", t.id, `memory-${a}.md`), "");
    }
    const file: LeagueFile = { name, created: new Date().toISOString(), settings, teams };
    writeFileSync(path.join(dir, "league.json"), JSON.stringify(file, null, 2));
    writeFileSync(path.join(dir, "ratings.json"), JSON.stringify(Object.fromEntries(teams.map((t) => [t.id, 1500])), null, 2));
    return new League(dir, file);
  }

  static open(name: string): League {
    const dir = path.join(LEAGUES_DIR, name);
    const f = path.join(dir, "league.json");
    if (!existsSync(f)) throw new Error(`no league "${name}" (looked in ${dir})`);
    return new League(dir, JSON.parse(readFileSync(f, "utf8")));
  }

  // ---------- storage ----------

  teamDir(t: string) {
    return path.join(this.dir, "teams", t);
  }
  playbook(t: string): string {
    const f = path.join(this.teamDir(t), "playbook.md");
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  }
  memory(agent: string): string {
    const t = agent.split("-")[0];
    const f = path.join(this.teamDir(t), `memory-${agent}.md`);
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  }
  mockStyle(t: string): { style: MockStyle | null; best: MockStyle | null } {
    const f = path.join(this.teamDir(t), "mock-style.json");
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { style: null, best: null };
  }
  results(): ResultRow[] {
    const f = path.join(this.dir, "results.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  ratings(): Record<string, number> {
    return JSON.parse(readFileSync(path.join(this.dir, "ratings.json"), "utf8"));
  }
  history(t: string): { game: string; text: string }[] {
    const d = path.join(this.teamDir(t), "history");
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ game: f.slice(0, -3), text: readFileSync(path.join(d, f), "utf8") }));
  }
  gameLog(id: string): MatchLog | null {
    const f = path.join(this.dir, "games", `${id}.json`);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  }

  // ---------- scheduling ----------

  /**
   * Next pairing: the team with the fewest games, against the opponent it has met least
   * (then the one with the fewest games), so matchups vary. Seats alternate so each team
   * plays north and south equally.
   */
  schedule(seed: number): TeamRecord[] {
    const rows = this.results();
    const rand = rng(seed);
    const games = new Map(this.file.teams.map((t) => [t.id, 0]));
    const north = new Map(this.file.teams.map((t) => [t.id, 0]));
    const met = new Map<string, number>();
    for (const r of rows) {
      for (const t of r.seats) games.set(t, (games.get(t) ?? 0) + 1);
      north.set(r.seats[0], (north.get(r.seats[0]) ?? 0) + 1);
      const k = [...r.seats].sort().join("|");
      met.set(k, (met.get(k) ?? 0) + 1);
    }
    const jitter = new Map(this.file.teams.map((t) => [t.id, rand()]));
    const byGames = [...this.file.teams].sort((a, b) => games.get(a.id)! - games.get(b.id)! || jitter.get(a.id)! - jitter.get(b.id)!);
    const a = byGames[0];
    const b = byGames
      .slice(1)
      .sort((x, y) => (met.get([a.id, x.id].sort().join("|")) ?? 0) - (met.get([a.id, y.id].sort().join("|")) ?? 0) || games.get(x.id)! - games.get(y.id)! || jitter.get(x.id)! - jitter.get(y.id)!)[0];
    const aNorthShare = north.get(a.id)! - (games.get(a.id)! - north.get(a.id)!);
    const bNorthShare = north.get(b.id)! - (games.get(b.id)! - north.get(b.id)!);
    return aNorthShare < bNorthShare || (aNorthShare === bNorthShare && rand() < 0.5) ? [a, b] : [b, a];
  }

  /** One line per past game of this team, for its debrief. */
  private teamHistory(team: string, rows: ResultRow[]): string[] {
    return rows
      .filter((r) => r.seats.includes(team))
      .slice(-10)
      .map((r) => {
        const opp = r.seats.find((x) => x !== team)!;
        const res = r.draw ? "DRAW" : r.winner === team ? "WIN" : "LOSS";
        return `${r.game}: ${res} vs ${this.file.teams.find((t) => t.id === opp)!.name}, ${r.scores[team].total}-${r.scores[opp].total} VP in ${r.turns} turns`;
      });
  }

  // ---------- running ----------

  private completerFor(model: string): Completer {
    const s = this.file.settings;
    if (s.backend === "api") return new ApiCompleter(new Anthropic({ maxRetries: 4 }), model, s.effort);
    return new CliCompleter(model, s.effort);
  }

  async playGame(opts: { emit?: UiEmit; gate?: () => Promise<void>; seed?: number; log?: (s: string) => void } = {}): Promise<ResultRow> {
    const s = this.file.settings;
    const say = opts.log ?? (() => {});
    const rules = loadRuleset(s.ruleset);
    if (s.turns) rules.turns = s.turns;
    const rtext = rulesText(rules);
    const prior = this.results();
    const number = prior.length + 1;
    const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    const seats = this.schedule(seed);
    const id = `g${String(number).padStart(4, "0")}`;
    say(`[${this.file.name}] game ${id}: ${seats.map((t) => t.name).join(" vs ")} (seed ${seed})`);

    const agents: Agent[] = [];
    const match = new Match({
      id,
      rules,
      seed,
      teams: seats,
      council: s.council,
      backend: s.backend,
      model: s.backend === "mock" ? "mock" : s.model,
      emit: opts.emit,
      gate: opts.gate,
      concurrency: s.concurrency,
      makeAgent: (agentId, eng): Agent => {
        const team = seats.find((t) => t.agents.includes(agentId))!;
        if (s.backend === "mock") {
          const st = this.mockStyle(team.id).style;
          return new MockAgent(eng, agentId, st ?? { ...DEFAULT_STYLE }, seed + agentId.length * 97 + agentId.charCodeAt(agentId.length - 1));
        }
        const iface = s.interface ?? "cli";
        const system = agentSystemPrompt(rtext, agentId, team.name, team.agents.length, this.playbook(team.id), this.memory(agentId), iface);
        let agent: Agent;
        if (iface === "json") {
          const c = this.completerFor(s.model);
          agent = new JsonAgent(c, system, agentId);
        } else if (s.backend === "api") agent = new ApiCliAgent(new Anthropic({ maxRetries: 4 }), s.model, s.effort, system);
        else agent = new ClaudeCodeCliAgent(s.model, s.effort, system, agentId);
        agents.push(agent);
        return agent;
      },
    });
    let log: MatchLog;
    try {
      log = await match.run();
    } finally {
      match.close();
    }
    writeFileSync(path.join(this.dir, "games", `${id}.json`), JSON.stringify(log));
    const res = log.result!;
    const nm = (t: string) => seats.find((x) => x.id === t)!.name;
    say(`[${this.file.name}] ${id} finished turn ${res.turns}: ${res.draw ? "draw" : `${nm(res.winner!)} wins`} (${seats.map((t) => `${t.name} ${res.scores[t.id].total}`).join(", ")})`);

    // Debriefs: every team learns only from its own report.
    opts.emit?.({ type: "debrief", status: "start" });
    const changelogs: Record<string, string> = {};
    const debriefUsage: Usage[] = [];
    await Promise.all(
      seats.map(async (team) => {
        const won = res.winner === team.id;
        const outcome = res.draw ? "draw" : won ? "win" : "loss";
        const report = gameReport(log, team.id, this.teamHistory(team.id, prior));
        let d: DebriefResult;
        if (s.backend === "mock") {
          const ms = this.mockStyle(team.id);
          const next = mockDebrief(ms.style, ms.best, won, seed + team.id.length);
          writeFileSync(path.join(this.teamDir(team.id), "mock-style.json"), JSON.stringify(next, null, 2));
          d = { playbook: mockPlaybook(next.style), changelog: `${outcome}; ${won ? "kept and fine-tuned" : "tried a variation of the best known"} style`, memories: {}, reflections: {}, edits: [] };
        } else {
          const c = this.completerFor(s.debriefModel ?? s.model);
          debriefUsage.push(c.usage);
          const memories = Object.fromEntries(team.agents.map((a) => [a, this.memory(a)]));
          d = await llmDebrief(c, rtext, team, this.playbook(team.id), memories, report, s.interface ?? "cli", seed + team.id.length);
          for (const [a, m] of Object.entries(d.memories)) writeFileSync(path.join(this.teamDir(team.id), `memory-${a}.md`), m);
        }
        writeFileSync(path.join(this.teamDir(team.id), "playbook.md"), d.playbook);
        const hist = [
          `# ${team.name} after ${id} (${outcome} vs ${seats.find((t) => t.id !== team.id)!.name})`,
          "",
          ...Object.entries(d.reflections).map(([a, r]) => `## ${a}\n\n${r.reflection}\n`),
          "## Playbook edits (in turn order)",
          "",
          ...(d.edits.length ? d.edits.map((e) => `- ${e.agent}: ${e.action}. ${e.changelog}`) : [`- ${d.changelog}`]),
          "",
          "## Playbook",
          "",
          d.playbook,
        ].join("\n");
        writeFileSync(path.join(this.teamDir(team.id), "history", `${id}.md`), hist);
        writeFileSync(path.join(this.teamDir(team.id), "history", `${id}-report.txt`), report);
        changelogs[team.id] = d.changelog;
        say(`[${this.file.name}] ${team.name} debrief: ${d.changelog.slice(0, 160)}`);
      }),
    );
    opts.emit?.({ type: "debrief", status: "done", changelogs });

    const [north, south] = seats.map((t) => t.id);
    const ratings = updateElo(this.ratings(), north, south, res.draw ? 0.5 : res.winner === north ? 1 : 0);
    writeFileSync(path.join(this.dir, "ratings.json"), JSON.stringify(ratings, null, 2));
    const model = s.backend === "mock" ? "mock" : s.model;
    const usd =
      agents.reduce((a, c) => a + costOf(model, c.usage), 0) + debriefUsage.reduce((a, u) => a + costOf(s.debriefModel ?? s.model, u), 0);
    const row: ResultRow = {
      game: id,
      number,
      date: new Date().toISOString(),
      seed,
      seats: seats.map((t) => t.id),
      ranking: res.ranking,
      winner: res.winner,
      draw: res.draw,
      turns: res.turns,
      scores: res.scores,
      styles: Object.fromEntries(seats.map((t) => [t.id, styleVector(res.stats[t.id], res.scores[t.id], res.turns)])),
      ratings,
      changelogs,
      usd: Math.round(usd * 1000) / 1000,
    };
    appendFileSync(path.join(this.dir, "results.jsonl"), JSON.stringify(row) + "\n");
    return row;
  }
}

export { zeroUsage };
