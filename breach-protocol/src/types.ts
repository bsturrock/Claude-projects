export type Role = "crew" | "saboteur" | "infiltrator";
export type Card = "repair" | "breach";

export interface Player {
  id: number;
  name: string;
  persona: string;
  role: Role;
  alive: boolean;
  hand: Card[];
  model: string; // model id, or "mock"
}

export type DecisionKind =
  | "discuss"
  | "nominate"
  | "vote"
  | "supply"
  | "play_card"
  | "debrief"
  | "scan"
  | "eject";

export interface DecisionRequest {
  kind: DecisionKind;
  /** Instruction text shown to the agent for this decision. */
  instruction: string;
  /** Snapshot of the board as this player sees it. */
  status: string;
  /** Valid player names for `target`, when the decision needs one. */
  targets?: string[];
}

/** One schema for every decision keeps the request prefix stable (better prompt caching). */
export interface Decision {
  private_reasoning: string;
  say: string;
  target: string;
  vote: "yes" | "no" | "none";
  card: Card | "none";
  /** Summarized extended-thinking text, when the model returns it (not part of the JSON schema). */
  thinking?: string;
}

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  calls: number;
  /** Cost reported by the backend itself (Claude Code CLI). API-equivalent; not billed on a subscription. */
  usd?: number;
}

export interface Agent {
  decide(req: DecisionRequest, newEvents: string[]): Promise<Decision>;
  usage: Usage;
  /** Release resources (e.g. a long-running Claude Code process) when the game ends. */
  close?(): void;
}

/** Event sent to the spectator UI. `to` = null means public; otherwise only those players saw it. */
export interface UiEvent {
  seq: number;
  t: number;
  type: string;
  to: number[] | null;
  [k: string]: unknown;
}

export interface RoundSummary {
  public_recap: string;
  spectator_analysis: string;
}

export interface GameSummary {
  headline: string;
  story: string;
  turning_points: string[];
  best_play: string;
  biggest_mistake: string;
  players: { name: string; verdict: string }[];
}

/** Writes recaps from the full (spectator) log. Never talks to the players. */
export interface Narrator {
  usage: Usage;
  model: string;
  round(log: string): Promise<RoundSummary>;
  game(log: string): Promise<GameSummary>;
}
