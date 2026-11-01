import type { Bundle, Level, Resource, Terrain, UnitType } from "./config.js";
import type { Hex } from "./hex.js";

export type Stance = "peace" | "war";

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

export interface Offer {
  id: string;
  from: string;
  to: string;
  give: Bundle;
  get: Bundle;
  turn: number;
}

export interface VpBreakdown {
  settlements: number;
  monuments: number;
  spire: number;
  tech: number;
  glory: number;
  heart: number;
  commerce: number;
  total: number;
}

export interface TeamState {
  id: string;
  name: string;
  agents: string[];
  techs: string[];
  /** Permanent VP earned during play (captures, ruins, heart, trades). */
  glory: number;
  heart: number;
  commerce: number;
  /** Turn the last commerce VP was earned (one per turn). */
  commerceTurn: number;
  /** Tile keys this team has ever seen. */
  explored: Set<string>;
  /** Last-seen settlement owner per explored tile (fog memory). */
  memory: Map<string, string>;
}

export interface Message {
  turn: number;
  phase: "council" | "orders";
  from: string;
  /** "team:<id>", "public", or "embassy:<teamA>|<teamB>" (sorted). */
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
  /** Key "a|b" (sorted team ids). */
  stances: Map<string, Stance>;
  /** Peace proposals: key "from>to" -> turn proposed. */
  peaceOffers: Map<string, number>;
  offers: Map<string, Offer>;
  spireBuilt: string | null;
  nextId: number;
  events: GameEvent[];
  messages: Message[];
  over: boolean;
  winner: string | null;
}

/** What an agent sends each phase. */
export interface Decision {
  reasoning: string;
  team_message: string;
  public_message: string;
  embassy: { team: string; message: string }[];
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
  observation: string;
}

export interface Agent {
  usage: Usage;
  decide(req: DecisionRequest): Promise<Decision>;
  close?(): void;
}

export const emptyDecision = (): Decision => ({ reasoning: "", team_message: "", public_message: "", embassy: [], orders: [], notes: "" });
