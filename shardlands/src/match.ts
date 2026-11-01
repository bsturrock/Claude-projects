import type { Ruleset } from "./config.js";
import { splitArgs } from "./commands/types.js";
import { Engine, type Snapshot, type TeamStats } from "./engine.js";
import { observe, type ObsContext } from "./observe.js";
import { AgentSession } from "./session.js";
import { TurnServer } from "./turnserver.js";
import type { Agent, Decision, GameEvent, Message, VpBreakdown } from "./types.js";
import { emptyDecision } from "./types.js";

export interface MatchTeam {
  id: string;
  name: string;
  agents: string[];
}

/** What one agent did in one phase. */
export interface DecisionLog {
  agent: string;
  phase: "council" | "orders";
  reasoning: string;
  thinking?: string;
  /** Every command the agent ran, with the CLI's reply. */
  transcript: { cmd: string; out: string }[];
  /** Orders submitted at the end of the phase. */
  orders: string[];
  said: { channel: string; text: string }[];
  notes: string;
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
  /** Seat order: [north, south]. */
  teams: MatchTeam[];
  initial: Snapshot;
  turns: TurnLog[];
  result: {
    /** [winner, loser] (by VP then stockpile when drawn on VP). */
    ranking: string[];
    winner: string | null;
    draw: boolean;
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
  /** Seat order: [north, south]. */
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
  server = new TurnServer();
  private inbox = new Map<string, ObsContext>();

  constructor(private o: MatchOptions) {
    this.eng = new Engine(o.rules, o.teams, o.seed);
    for (const t of o.teams)
      for (const a of t.agents) {
        this.agents.set(a, o.makeAgent(a, this.eng));
        this.inbox.set(a, { phase: "council", messages: [], events: [], feedback: [], notes: "" });
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

  /** Delivers what an agent said this phase to the right inboxes. */
  private route(from: string, said: { channel: string; text: string }[], phase: "council" | "orders"): Message[] {
    const team = this.eng.teamOf(from);
    const out: Message[] = [];
    for (const x of said) {
      const m: Message = { turn: this.eng.state.turn, phase, from, channel: x.channel, text: x.text };
      out.push(m);
      const to = x.channel === "public" ? [...this.inbox.keys()] : team.agents;
      for (const a of to) if (a !== from) this.inbox.get(a)!.messages.push(m);
    }
    this.eng.state.messages.push(...out);
    return out;
  }

  /** Feeds a JSON/mock decision's messages and order lines through the session, as if typed into the CLI. */
  private applyDecision(s: AgentSession, d: Decision) {
    if (d.team_message?.trim()) s.exec(["say", "team", d.team_message]);
    if (d.public_message?.trim()) s.exec(["say", "public", d.public_message]);
    if (s.phase === "orders") for (const line of d.orders ?? []) if (String(line).trim()) s.exec(splitArgs(String(line)));
    if (d.notes?.trim()) s.notes = d.notes.trim().slice(0, s.limits.notesChars);
  }

  private async phase(phase: "council" | "orders"): Promise<{ logs: DecisionLog[]; sessions: AgentSession[] }> {
    const eng = this.eng;
    const ids = [...this.agents.keys()].filter((a) => eng.isActive(a) || Object.values(eng.state.agents.get(a)!.stock).some((v) => v > 0));
    this.o.emit?.({ type: "phase", phase, turn: eng.state.turn, agents: ids });
    const sessions = ids.map((a) => {
      const ib = this.inbox.get(a)!;
      const s = new AgentSession(eng, a, phase, { ...ib, phase });
      s.endpoint = { url: this.server.url, token: this.server.open(s) };
      // The inbox is consumed by this decision.
      this.inbox.set(a, { phase, messages: [], events: [], feedback: [], notes: ib.notes });
      return s;
    });
    const logs = await pool(sessions, this.o.concurrency ?? 8, async (s) => {
      const observation = observe(eng, s.agent, { ...s.ctx, notes: s.notes });
      let d: Decision = emptyDecision();
      let error: string | undefined;
      try {
        d = await this.agents.get(s.agent)!.decide({ phase, agentId: s.agent, turn: eng.state.turn, observation, session: s });
        this.applyDecision(s, d);
      } catch (err) {
        error = String(err).slice(0, 300);
      }
      this.inbox.get(s.agent)!.notes = s.notes;
      const log: DecisionLog = {
        agent: s.agent,
        phase,
        reasoning: d.reasoning,
        thinking: d.thinking,
        transcript: s.transcript,
        orders: s.queue.map((q) => q.raw),
        said: s.said,
        notes: s.notes,
        error,
      };
      this.o.emit?.({ type: "decision", turn: eng.state.turn, decision: log, observation });
      return log;
    });
    this.server.closeAll();
    return { logs, sessions };
  }

  async run(): Promise<MatchLog> {
    const eng = this.eng;
    const gate = this.o.gate ?? (async () => {});
    await this.server.start();
    this.o.emit?.({ type: "start", log: { ...this.log, turns: [] } });
    try {
      while (!eng.state.over) {
        await gate();
        const turn = eng.state.turn;
        const all: DecisionLog[] = [];
        const messages: Message[] = [];
        if (this.o.council) {
          const { logs, sessions } = await this.phase("council");
          for (const s of sessions) messages.push(...this.route(s.agent, s.said, "council"));
          all.push(...logs);
          this.o.emit?.({ type: "messages", turn, messages });
          await gate();
        }
        const { logs, sessions } = await this.phase("orders");
        all.push(...logs);
        const res = eng.resolveTurn(new Map(sessions.map((s) => [s.agent, s.queue])));
        // Orders-phase messages are delivered after resolution, so they arrive next turn.
        for (const s of sessions) messages.push(...this.route(s.agent, s.said, "orders"));
        for (const [a, ib] of this.inbox) {
          ib.feedback.push(...(res.feedback.get(a) ?? []));
          ib.events.push(...res.events);
        }
        const t: TurnLog = { turn, decisions: all, messages, events: res.events, feedback: Object.fromEntries(res.feedback), snapshot: eng.snapshot() };
        this.log.turns.push(t);
        this.o.emit?.({ type: "turn", turnLog: t });
      }
    } finally {
      this.server.stop();
    }
    this.log.result = {
      ranking: eng.ranking(),
      winner: eng.state.winner,
      draw: eng.state.draw,
      scores: Object.fromEntries(eng.scores()),
      stats: Object.fromEntries(eng.stats),
      turns: eng.state.turn,
    };
    this.o.emit?.({ type: "end", result: this.log.result });
    return this.log;
  }

  close() {
    for (const a of this.agents.values()) a.close?.();
    this.server.stop();
  }
}
