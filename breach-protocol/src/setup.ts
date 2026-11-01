import Anthropic from "@anthropic-ai/sdk";
import { ClaudeAgent, buildSystemPrompt, type Effort } from "./agents/claude.js";
import { ClaudeCodeAgent } from "./agents/claudecode.js";
import { MockAgent } from "./agents/mock.js";
import { shuffle } from "./engine.js";
import { ClaudeCodeNarrator, ClaudeNarrator, MockNarrator } from "./narrator.js";
import { NAMES, PERSONAS } from "./rules.js";
import { loadRuleset, rolesFor, rulesText, type Ruleset } from "./ruleset.js";
import type { Agent, Narrator, Player, Usage } from "./types.js";

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

/** USD per million tokens: [input, cache write (5m), cache read, output]. Haiku: prompts under 100K. */
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

export type Backend = "claude-code" | "api" | "mock";

export interface GameConfig {
  numPlayers: number;
  /** "claude-code": each player is a headless Claude Code session (your login, no API key). "api": Messages API. "mock": offline bots. */
  backend: Backend;
  /** One model for everyone, or "mixed" (rotate through MODELS). Ignored for mock. */
  model: string;
  effort: Effort;
  /** File name (without .json) in /rulesets. */
  ruleset: string;
  /** Write round and game recaps with a narrator agent. */
  narrator: boolean;
}

export function createGameParts(cfg: GameConfig): { rules: Ruleset; players: Player[]; agents: Agent[]; narrator?: Narrator } {
  const rules = loadRuleset(cfg.ruleset);
  const text = rulesText(rules);
  const n = Math.max(5, Math.min(8, cfg.numPlayers));
  const roles = shuffle(rolesFor(rules, n));
  const personas = shuffle(PERSONAS);
  const players: Player[] = roles.map((role, id) => ({
    id,
    name: NAMES[id],
    persona: personas[id],
    role,
    alive: true,
    hand: [],
    model: cfg.backend === "mock" ? "mock" : cfg.model === "mixed" ? MODELS[id % MODELS.length] : cfg.model,
  }));
  const narratorModel = cfg.model === "mixed" ? MODELS[0] : cfg.model;
  let agents: Agent[];
  let narrator: Narrator | undefined;
  if (cfg.backend === "api") {
    const client = new Anthropic({ maxRetries: 4 });
    agents = players.map((p) => new ClaudeAgent(client, p.model, buildSystemPrompt(text, p.name, p.persona), cfg.effort));
    if (cfg.narrator) narrator = new ClaudeNarrator(client, narratorModel, text);
  } else if (cfg.backend === "claude-code") {
    agents = players.map((p) => new ClaudeCodeAgent(p.model, buildSystemPrompt(text, p.name, p.persona), cfg.effort, p.name));
    if (cfg.narrator) narrator = new ClaudeCodeNarrator(narratorModel, text);
  } else {
    agents = players.map((p) => new MockAgent(p, players));
    if (cfg.narrator) narrator = new MockNarrator();
  }
  return { rules, players, agents, narrator };
}
