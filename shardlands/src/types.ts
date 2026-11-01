import type { Level, Resource, Terrain, UnitType } from "./config.js";
import type { Hex } from "./hex.js";
import type { AgentSession } from "./session.js";

export interface Tile extends Hex {
  terrain: Terrain;
}

export interface Unit {
  id: string;
  type: UnitType;
  owner: string; // agent id
  team: string;
  pos: Hex;
  hp: number;
  /** Standing move order: the unit keeps walking here each turn until it arrives or is told otherwise. */
  dest: Hex | null;
}

export interface Settlement {
  id: string;
  name: string;
  owner: string;
  team: string;
  pos: Hex;
  level: Level;
  hp: number;
  walls: boolean;
  monument: boolean;
  spire: boolean;
  founded: number;
  /** Tile keys this settlement works. */
  claims: string[];
  attackedThisTurn?: boolean;
}

export interface AgentState {
  id: string; // e.g. "amber-a"
  team: string;
  stock: Record<Resource, number>;
}

export interface VpBreakdown {
  settlements: number;
  monuments: number;
  spire: number;
  tech: number;
  glory: number;
  heart: number;
  total: number;
}

export interface TeamState {
  id: string;
  name: string;
  agents: string[];
  techs: string[];
  /** Permanent VP earned during play (captures, ruins). */
  glory: number;
  /** Permanent VP from holding the Heart. */
  heart: number;
  /** Tile keys this team has ever seen. */
  explored: Set<string>;
  /** Last-seen settlement per explored tile (fog memory). */
  memory: Map<string, string>;
}

export interface Message {
  turn: number;
  phase: "council" | "orders";
  from: string;
  /** "team:<id>" or "public". */
  channel: string;
  text: string;
}

export interface GameEvent {
  turn: number;
  /** null = public; otherwise a team id that can see it. */
  vis: string | null;
  kind: string;
  text: string;
  data?: Record<string, unknown>;
}

export interface GameState {
  seed: number;
  turn: number;
  tiles: Map<string, Tile>;
  teams: TeamState[];
  agents: Map<string, AgentState>;
  units: Map<string, Unit>;
  settlements: Map<string, Settlement>;
  spireBuilt: string | null;
  nextId: number;
  events: GameEvent[];
  messages: Message[];
  over: boolean;
  winner: string | null;
  /** True when the game ended level on VP and stockpile. */
  draw: boolean;
}

/**
 * What an agent returns from one phase. Tool-using agents act through the session (the
 * `shard` CLI) and only return their reasoning; JSON and mock agents return command lines in
 * `orders`, which are run through the same command layer.
 */
export interface Decision {
  reasoning: string;
  team_message: string;
  public_message: string;
  orders: string[];
  notes: string;
  thinking?: string;
}

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  calls: number;
  usd?: number;
}

export interface DecisionRequest {
  phase: "council" | "orders";
  agentId: string;
  turn: number;
  /** The briefing text (same as `shard status`). */
  observation: string;
  /** Live command session for this agent and phase. */
  session: AgentSession;
}

export interface Agent {
  usage: Usage;
  decide(req: DecisionRequest): Promise<Decision>;
  close?(): void;
}

export const emptyDecision = (): Decision => ({ reasoning: "", team_message: "", public_message: "", orders: [], notes: "" });
