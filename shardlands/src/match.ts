import type { Ruleset } from "./config.js";
import { Engine, type Snapshot, type TeamStats } from "./engine.js";
import { observe } from "./observe.js";
import type { Agent, Decision, GameEvent, Message, VpBreakdown } from "./types.js";
import { emptyDecision } from "./types.js";

export interface MatchTeam {
  id: string;
  name: string;
  agents: string[];
}

export interface DecisionLog extends Decision {
  agent: string;
  phase: "council" | "orders";
  error?: string;
}

export interface TurnLog {
  turn: number;
  decisions: DecisionLog[];
  messages: Message[];
  events: GameEvent[];
  feedback: Record<string, string[]>;
  snapshot: Snapshot;
}

export interface MatchLog {
  id: string;
  startedAt: string;
  seed: number;
  ruleset: string;
  council: boolean;
  backend: string;
  model: string;
  teams: MatchTeam[];
  initial: Snapshot;
  turns: TurnLog[];
  result: {
    ranking: string[];
    scores: Record<string, VpBreakdown>;
    stats: Record<string, TeamStats>;
    turns: number;
  } | null;
}

export type UiEmit = (ev: { type: string; [k: string]: unknown }) => void;

export interface MatchOptions {
  id: string;
  rules: Ruleset;
  seed: number;
  /** Seat order. */
  teams: MatchTeam[];
  /** Agents are created after the engine exists (mock bots read it). */
  makeAgent: (agentId: string, eng: Engine) => Agent;
  council: boolean;
  backend: string;
  model: string;
  emit?: UiEmit;
  /** Awaited between phases; throw to abort (used for pause/stop). */
  gate?: () => Promise<void>;
  /** Max concurrent agent calls. */
  concurrency?: number;
}

interface Inbox {
  messages: Message[];
  events: GameEvent[];
  feedback: string[];
  notes: string;
}

async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export class Match {
  eng: Engine;
  agents = new Map<string, Agent>();
  log: MatchLog;
  private inbox = new Map<string, Inbox>();

  constructor(private o: MatchOptions) {
    this.eng = new Engine(o.rules, o.teams, o.seed);
    for (const t of o.teams) for (const a of t.agents) {
      this.agents.set(a, o.makeAgent(a, this.eng));
      this.inbox.set(a, { messages: [], events: [], feedback: [], notes: "" });
    }
    this.log = {
      id: o.id,
      startedAt: new Date().toISOString(),
      seed: o.seed,
      ruleset: o.rules.name,
      council: o.council,
      backend: o.backend,
      model: o.model,
      teams: o.teams,
      initial: this.eng.snapshot(),
      turns: [],
      result: null,
    };
  }

  private route(from: string, d: Decision, phase: "council" | "orders"): Message[] {
    const eng = this.eng;
    const team = eng.teamOf(from);
    const turn = eng.state.turn;
    const out: Message[] = [];
    const deliver = (m: Message, to: string[]) => {
      out.push(m);
      for (const a of to) if (a !== from) this.inbox.get(a)!.messages.push(m);
    };
    const clip = (s: string) => s.trim().slice(0, 1200);
    if (d.team_message?.trim()) deliver({ turn, phase, from, channel: `team:${team.id}`, text: clip(d.team_message) }, team.agents);
    if (d.public_message?.trim()) deliver({ turn, phase, from, channel: "public", text: clip(d.public_message) }, [...this.inbox.keys()]);
    for (const em of d.embassy ?? []) {
      if (!em?.message?.trim()) continue;
      const other = eng.state.teams.find((t) => t.id === em.team || t.name.toLowerCase() === String(em.team).toLowerCase());
      if (!other || other.id === team.id) continue;
      const ch = `embassy:${[team.id, other.id].sort().join("|")}`;
      deliver({ turn, phase, from, channel: ch, text: clip(em.message) }, [...team.agents, ...other.agents]);
    }
    eng.state.messages.push(...out);
    return out;
  }

  private async phase(phase: "council" | "orders"): Promise<DecisionLog[]> {
    const eng = this.eng;
    const ids = [...this.agents.keys()].filter((a) => eng.isActive(a) || Object.values(eng.state.agents.get(a)!.stock).some((v) => v > 0));
    this.o.emit?.({ type: "phase", phase, turn: eng.state.turn, agents: ids });
    const observations = new Map(ids.map((a) => {
      const ib = this.inbox.get(a)!;
      return [a, observe(eng, a, { phase, feedback: ib.feedback, events: ib.events, messages: ib.messages, notes: ib.notes })];
    }));
    // Inbox is consumed by this decision.
    for (const a of ids) {
      const ib = this.inbox.get(a)!;
      ib.messages = [];
      ib.events = [];
      ib.feedback = [];
    }
    const decisions = await pool(ids, this.o.concurrency ?? 9, async (a) => {
      let d: Decision;
      let error: string | undefined;
      try {
        d = await this.agents.get(a)!.decide({ phase, agentId: a, turn: eng.state.turn, observation: observations.get(a)! });
      } catch (err) {
        d = emptyDecision();
        error = String(err).slice(0, 300);
      }
      const log: DecisionLog = { ...d, agent: a, phase, error };
      this.o.emit?.({ type: "decision", turn: eng.state.turn, decision: log, observation: observations.get(a) });
      return log;
    });
    return decisions;
  }

  async run(): Promise<MatchLog> {
    const eng = this.eng;
    const gate = this.o.gate ?? (async () => {});
    this.o.emit?.({ type: "start", log: { ...this.log, turns: [] } });
    while (!eng.state.over) {
      await gate();
      const turn = eng.state.turn;
      const all: DecisionLog[] = [];
      const messages: Message[] = [];
      if (this.o.council) {
        const ds = await this.phase("council");
        for (const d of ds) {
          messages.push(...this.route(d.agent, d, "council"));
          if (d.notes?.trim()) this.inbox.get(d.agent)!.notes = d.notes.trim().slice(0, 1500);
        }
        all.push(...ds);
        this.o.emit?.({ type: "messages", turn, messages });
        await gate();
      }
      const ds = await this.phase("orders");
      const orders = new Map<string, string[]>();
      for (const d of ds) {
        orders.set(d.agent, (d.orders ?? []).map(String));
        if (d.notes?.trim()) this.inbox.get(d.agent)!.notes = d.notes.trim().slice(0, 1500);
      }
      all.push(...ds);
      const res = eng.resolveTurn(orders);
      // Orders-phase messages are delivered after resolution, so they arrive next turn.
      const late: Message[] = [];
      for (const d of ds) late.push(...this.route(d.agent, d, "orders"));
      messages.push(...late);
      for (const [a, ib] of this.inbox) {
        ib.feedback.push(...(res.feedback.get(a) ?? []));
        ib.events.push(...res.events);
      }
      const t: TurnLog = { turn, decisions: all, messages, events: res.events, feedback: Object.fromEntries(res.feedback), snapshot: eng.snapshot() };
      this.log.turns.push(t);
      this.o.emit?.({ type: "turn", turnLog: t });
    }
    const sc = eng.scores();
    this.log.result = {
      ranking: eng.ranking(),
      scores: Object.fromEntries(sc),
      stats: Object.fromEntries(eng.stats),
      turns: eng.state.turn,
    };
    this.o.emit?.({ type: "end", result: this.log.result });
    return this.log;
  }

  close() {
    for (const a of this.agents.values()) a.close?.();
  }
}
