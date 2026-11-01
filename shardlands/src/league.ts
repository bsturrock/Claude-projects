import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "./config.js";
import { MockAgent, type MockStyle } from "./agents/mock.js";
import { ApiCompleter, CliCompleter, LlmAgent, agentSystemPrompt, type Completer } from "./agents/llm.js";
import type { Effort } from "./agents/cli.js";
import { gameReport, llmDebrief, mockDebrief, mockPlaybook, type DebriefResult, type TeamRecord } from "./debrief.js";
import { Match, type MatchLog, type UiEmit } from "./match.js";
import { styleVector, updateElo, type StyleVector } from "./metrics.js";
import { rulesText } from "./rules.js";
import { rng } from "./hex.js";
import type { Usage, VpBreakdown } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const LEAGUES_DIR = process.env.SHARD_LEAGUES_DIR ?? path.join(here, "..", "leagues");

export type Backend = "claude-code" | "api" | "mock";

export interface LeagueSettings {
  backend: Backend;
  model: string;
  /** Model for debriefs (reflection + playbook editing). Defaults to the game model. */
  debriefModel?: string;
  effort: Effort;
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
  seats: string[];
  ranking: string[];
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
    if (numTeams < 3 || numTeams > TEAM_NAMES.length) throw new Error(`teams must be 3-${TEAM_NAMES.length}`);
    const teams: TeamRecord[] = TEAM_NAMES.slice(0, numTeams).map((n) => {
      const id = n.toLowerCase();
      return { id, name: n, agents: ["a", "b", "c"].map((x) => `${id}-${x}`) };
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

  /** The 3 teams with the fewest games, seated so each team rotates through all seats. */
  schedule(seed: number): TeamRecord[] {
    const rows = this.results();
    const games = new Map(this.file.teams.map((t) => [t.id, 0]));
    const seatCount = new Map(this.file.teams.map((t) => [t.id, [0, 0, 0]]));
    for (const r of rows)
      r.seats.forEach((t, i) => {
        games.set(t, (games.get(t) ?? 0) + 1);
        seatCount.get(t)![i]++;
      });
    const rand = rng(seed);
    const pick = [...this.file.teams].sort((a, b) => games.get(a.id)! - games.get(b.id)! || rand() - 0.5).slice(0, 3);
    const perms = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    let best = perms[0];
    let bestCost = Infinity;
    for (const p of perms) {
      const cost = p.reduce((a, ti, seat) => a + seatCount.get(pick[ti].id)![seat], 0) + rand() * 0.5;
      if (cost < bestCost) {
        bestCost = cost;
        best = p;
      }
    }
    return best.map((i) => pick[i]);
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

    const completers: Completer[] = [];
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
      makeAgent: (agentId, eng) => {
        const team = seats.find((t) => t.agents.includes(agentId))!;
        if (s.backend === "mock") {
          const st = this.mockStyle(team.id).style;
          return new MockAgent(eng, agentId, st ?? { expand: 3, military: 0.35, science: 0.5, aggression: 0.4, trade: 0.4, wonder: 0.4 }, seed + agentId.length * 97 + agentId.charCodeAt(agentId.length - 1));
        }
        const c = this.completerFor(s.model);
        completers.push(c);
        return new LlmAgent(c, agentSystemPrompt(rtext, agentId, team.name, this.playbook(team.id), this.memory(agentId)), agentId);
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
    say(`[${this.file.name}] ${id} finished turn ${res.turns}: ${res.ranking.map((t, i) => `#${i + 1} ${seats.find((x) => x.id === t)!.name} ${res.scores[t].total}`).join(", ")}`);

    // Debriefs: every team learns only from its own report.
    opts.emit?.({ type: "debrief", status: "start" });
    const changelogs: Record<string, string> = {};
    const debriefUsage: Usage[] = [];
    await Promise.all(
      seats.map(async (team) => {
        const place = res.ranking.indexOf(team.id) + 1;
        const recent = prior
          .filter((r) => r.seats.includes(team.id))
          .slice(-6)
          .map((r) => `${r.game}: #${r.ranking.indexOf(team.id) + 1} vs ${r.seats.filter((x) => x !== team.id).map((x) => this.file.teams.find((t) => t.id === x)!.name).join(" & ")} (${r.scores[team.id].total} VP)`);
        const report = gameReport(log, team.id, recent);
        let d: DebriefResult;
        if (s.backend === "mock") {
          const ms = this.mockStyle(team.id);
          const next = mockDebrief(ms.style, ms.best, place, seed + team.id.length);
          writeFileSync(path.join(this.teamDir(team.id), "mock-style.json"), JSON.stringify(next, null, 2));
          d = { playbook: mockPlaybook(next.style), changelog: `placed #${place}; ${place === 1 ? "kept and fine-tuned" : "tried a variation of the best known"} style`, memories: {}, reflections: {}, editor: "mock" };
        } else {
          const c = this.completerFor(s.debriefModel ?? s.model);
          debriefUsage.push(c.usage);
          const memories = Object.fromEntries(team.agents.map((a) => [a, this.memory(a)]));
          d = await llmDebrief(c, rtext, team, this.playbook(team.id), memories, report, prior.filter((r) => r.seats.includes(team.id)).length);
          for (const [a, m] of Object.entries(d.memories)) writeFileSync(path.join(this.teamDir(team.id), `memory-${a}.md`), m);
        }
        writeFileSync(path.join(this.teamDir(team.id), "playbook.md"), d.playbook);
        const hist = [
          `# ${team.name} after ${id} (placed #${place})`,
          "",
          `Changelog (${d.editor}): ${d.changelog}`,
          "",
          ...Object.entries(d.reflections).map(([a, r]) => `## ${a}\n\n**Reflection.** ${r.reflection}\n\n**Proposals.** ${r.proposals}\n`),
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

    const ratings = updateElo(this.ratings(), res.ranking);
    writeFileSync(path.join(this.dir, "ratings.json"), JSON.stringify(ratings, null, 2));
    const model = s.backend === "mock" ? "mock" : s.model;
    const usd =
      completers.reduce((a, c) => a + costOf(model, c.usage), 0) + debriefUsage.reduce((a, u) => a + costOf(s.debriefModel ?? s.model, u), 0);
    const row: ResultRow = {
      game: id,
      number,
      date: new Date().toISOString(),
      seed,
      seats: seats.map((t) => t.id),
      ranking: res.ranking,
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
