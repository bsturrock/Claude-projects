import Anthropic from "@anthropic-ai/sdk";
import { ClaudeAgent, buildSystemPrompt, type Effort } from "./agents/claude.js";
import { MockAgent } from "./agents/mock.js";
import { shuffle } from "./engine.js";
import { NAMES, PERSONAS, RULES_TEXT, rolesFor } from "./rules.js";
import type { Agent, Player, Usage } from "./types.js";

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

/** USD per million tokens: [input, cache write (5m), cache read, output]. Prompts <100K for Haiku. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 5, 0.2, 20],
  "claude-sonnet-5-5": [2, 2.5, 0.2, 10],
  "claude-haiku-5-5": [0.1, 0.125, 0.01, 0.5],
};

export function costOf(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (u.input * p[0] + u.cacheWrite * p[1] + u.cacheRead * p[2] + u.output * p[3]) / 1e6;
}

export interface GameConfig {
  numPlayers: number;
  /** One model for everyone, "mixed" (rotate through MODELS), or "mock". */
  model: string;
  effort: Effort;
}

export function createPlayers(cfg: GameConfig): { players: Player[]; agents: Agent[] } {
  const n = Math.max(5, Math.min(8, cfg.numPlayers));
  const roles = shuffle(rolesFor(n));
  const personas = shuffle(PERSONAS);
  const players: Player[] = roles.map((role, id) => ({
    id,
    name: NAMES[id],
    persona: personas[id],
    role,
    alive: true,
    hand: [],
    model: cfg.model === "mock" ? "mock" : cfg.model === "mixed" ? MODELS[id % MODELS.length] : cfg.model,
  }));
  const client = cfg.model === "mock" ? null : new Anthropic({ maxRetries: 4 });
  const agents: Agent[] = players.map((p) =>
    client
      ? new ClaudeAgent(client, p.model, buildSystemPrompt(RULES_TEXT, p.name, p.persona), cfg.effort)
      : new MockAgent(p, players),
  );
  return { players, agents };
}
