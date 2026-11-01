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
}

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  calls: number;
}

export interface Agent {
  decide(req: DecisionRequest, newEvents: string[]): Promise<Decision>;
  usage: Usage;
}

/** Event sent to the spectator UI. `to` = null means public; otherwise only those players saw it. */
export interface UiEvent {
  seq: number;
  t: number;
  type: string;
  to: number[] | null;
  [k: string]: unknown;
}
