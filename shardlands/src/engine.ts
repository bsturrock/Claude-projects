import { LEVELS, RESOURCES, UNIT_TYPES, type Bundle, type Resource, type Ruleset, type UnitType } from "./config.js";
import { bundleValue } from "./bundle.js";
import { ORDERS } from "./commands/index.js";
import { STEPS, type QueuedOrder, type ResolveCtx } from "./commands/types.js";
import { type Hex, findPath, fmt, inRange, key, rng } from "./hex.js";
import { capitalsForSeat, generateMap, passableTerrain } from "./map.js";
import type { AgentState, GameEvent, GameState, Settlement, TeamState, Unit, VpBreakdown } from "./types.js";

export { bundleValue, fmtBundle } from "./bundle.js";

export interface TeamSetup {
  id: string;
  name: string;
  agents: string[];
}

/** Behaviour counters per team, used by the league to compare how strategies differ. */
export interface TeamStats {
  unitsBuilt: Record<UnitType, number>;
  settlementsFounded: number;
  captures: number;
  settlementsLost: number;
  unitsLost: number;
  unitsKilled: number;
  /** Battles this team started by moving onto enemy units or settlements. */
  attacks: number;
  /** Turn of the first such attack, or null. */
  firstAttackTurn: number | null;
  /** Enemy tiles occupied (raided) summed over turns. */
  raidTileTurns: number;
  /** Turns this team held the Heart. */
  heartTurns: number;
  giftsTeamValue: number;
  exchanges: number;
  ruins: number;
  techs: string[];
  spend: { military: number; expansion: number; development: number; tech: number };
  peakSettlements: number;
  peakMilitary: number;
  orderErrors: number;
  ordersIssued: number;
}

const BUNDLE_ZERO = (): Record<Resource, number> => ({ food: 0, wood: 0, ore: 0, crystal: 0 });

const SETTLEMENT_NAMES = [
  "Ashford", "Brightwater", "Cinder Hollow", "Dunmere", "Eastmarch", "Fallow", "Glimmer", "Harrow", "Ironwell", "Juniper",
  "Kestrel", "Lowmoor", "Mistvale", "Northgate", "Oakheart", "Pellam", "Quarry", "Redfern", "Stonebridge", "Thornby",
  "Umber", "Vantage", "Westholm", "Yarrow", "Zephyr", "Amberlea", "Briar", "Coldspring", "Driftwood", "Emberly",
  "Foxglove", "Greystone", "Hollin", "Isen", "Larkspur", "Marrow", "Nettle", "Orrin", "Pike", "Rookery",
];

export interface TurnResult {
  /** Feedback lines per agent ("OK ..." / "FAILED ..."), shown in their next briefing. */
  feedback: Map<string, string[]>;
  events: GameEvent[];
}

/**
 * Game state and turn resolution for a two-team match. Orders are defined in src/commands
 * and resolved here step by step; the fixed phases (movement, combat, production) live below.
 */
export class Engine {
  state: GameState;
  stats = new Map<string, TeamStats>();
  rand: () => number;
  private nameIdx = 0;
  /** Seat index per team id (0 = north, 1 = south). */
  seat = new Map<string, number>();
  /** Units bought this turn; they appear after combat. */
  pendingSpawns: { owner: string; type: UnitType; settlement: string; cost: Bundle }[] = [];
  private combatHexes = new Set<string>();
  private startPos = new Map<string, string>();
  feedback = new Map<string, string[]>();
  private turnEvents: GameEvent[] = [];

  constructor(
    public rules: Ruleset,
    teams: TeamSetup[],
    seed: number,
  ) {
    if (teams.length !== 2) throw new Error("Shardlands is a two-team game");
    this.rand = rng(seed ^ 0x9e3779b9);
    this.state = {
      seed,
      turn: 1,
      tiles: generateMap(rules, seed),
      teams: [],
      agents: new Map(),
      units: new Map(),
      settlements: new Map(),
      spireBuilt: null,
      nextId: 1,
      events: [],
      messages: [],
      over: false,
      winner: null,
      draw: false,
    };
    teams.forEach((t, seat) => {
      if (t.agents.length !== rules.agentsPerTeam) throw new Error(`team ${t.id} needs exactly ${rules.agentsPerTeam} agents`);
      this.seat.set(t.id, seat);
      const ts: TeamState = { id: t.id, name: t.name, agents: [...t.agents], techs: [], glory: 0, heart: 0, explored: new Set(), memory: new Map() };
      this.state.teams.push(ts);
      this.stats.set(t.id, {
        unitsBuilt: Object.fromEntries(UNIT_TYPES.map((u) => [u, 0])) as Record<UnitType, number>,
        settlementsFounded: 0, captures: 0, settlementsLost: 0, unitsLost: 0, unitsKilled: 0, attacks: 0, firstAttackTurn: null,
        raidTileTurns: 0, heartTurns: 0, giftsTeamValue: 0, exchanges: 0, ruins: 0, techs: [],
        spend: { military: 0, expansion: 0, development: 0, tech: 0 }, peakSettlements: 0, peakMilitary: 0, orderErrors: 0, ordersIssued: 0,
      });
      const caps = capitalsForSeat(seat, rules.agentsPerTeam);
      t.agents.forEach((a, i) => {
        const stock = BUNDLE_ZERO();
        for (const r of RESOURCES) stock[r] = rules.start.stock[r] ?? 0;
        this.state.agents.set(a, { id: a, team: t.id, stock });
        this.foundSettlement(a, caps[i], true);
        for (const u of rules.start.units) this.spawnUnit(a, u, caps[i]);
      });
    });
    this.updateVision();
  }

  // ---------- lookups ----------

  team(id: string): TeamState {
    const t = this.state.teams.find((x) => x.id === id);
    if (!t) throw new Error(`no team ${id}`);
    return t;
  }
  teamOf(agent: string): TeamState {
    return this.team(this.state.agents.get(agent)!.team);
  }
  opponentOf(team: string): TeamState {
    return this.state.teams.find((t) => t.id !== team)!;
  }
  hasTech(team: string, tech: string) {
    return this.team(team).techs.includes(tech);
  }
  /** True once the opening truce is over. */
  get fighting() {
    return this.state.turn > this.rules.truceTurns;
  }
  atWar(a: string, b: string) {
    return a !== b && this.fighting;
  }
  tile(h: Hex) {
    return this.state.tiles.get(key(h));
  }
  settlementAt(h: Hex): Settlement | undefined {
    const k = key(h);
    for (const s of this.state.settlements.values()) if (key(s.pos) === k) return s;
    return undefined;
  }
  unitsAt(h: Hex): Unit[] {
    const k = key(h);
    return [...this.state.units.values()].filter((u) => key(u.pos) === k);
  }
  unitsOf(agent: string) {
    return [...this.state.units.values()].filter((u) => u.owner === agent);
  }
  settlementsOf(agent: string) {
    return [...this.state.settlements.values()].filter((s) => s.owner === agent);
  }
  teamSettlements(team: string) {
    return [...this.state.settlements.values()].filter((s) => s.team === team);
  }
  isActive(agent: string) {
    return this.settlementsOf(agent).length > 0 || this.unitsOf(agent).length > 0;
  }
  teamAlive(team: string) {
    return this.team(team).agents.some((a) => this.isActive(a));
  }
  claimOwner(k: string): Settlement | undefined {
    for (const s of this.state.settlements.values()) if (s.claims.includes(k)) return s;
    return undefined;
  }

  unitStr(u: Unit) {
    let s = this.rules.units[u.type].str;
    if (u.type === "soldier" && this.hasTech(u.team, "bronze")) s += 1;
    if ((u.type === "soldier" || u.type === "rider") && this.hasTech(u.team, "steel")) s += 1;
    return s;
  }
  unitMaxHp(type: UnitType, team: string) {
    return this.rules.units[type].hp + (["soldier", "rider", "catapult"].includes(type) && this.hasTech(team, "tactics") ? 1 : 0);
  }
  unitMove(u: Unit) {
    return this.rules.units[u.type].move + (u.type === "scout" && this.hasTech(u.team, "cartography") ? 1 : 0);
  }
  unitSight(u: Unit) {
    return this.rules.units[u.type].sight + (this.hasTech(u.team, "cartography") ? 1 : 0);
  }
  settlementMaxHp(s: Settlement) {
    return this.rules.settlement.hp[s.level] + (s.walls ? this.rules.buildings.walls.hp : 0) + (this.hasTech(s.team, "statecraft") ? 2 : 0);
  }
  settlementDefense(s: Settlement) {
    return this.rules.settlement.defense[s.level] + (s.walls ? this.rules.buildings.walls.defense : 0);
  }
  isMilitary(t: UnitType) {
    return this.rules.units[t].str >= 2 || t === "catapult";
  }

  unitCost(type: UnitType, team: string): Bundle {
    const c = { ...this.rules.units[type].cost };
    if (type === "settler" && this.hasTech(team, "statecraft")) {
      c.food = Math.max(0, (c.food ?? 0) - 2);
      c.wood = Math.max(0, (c.wood ?? 0) - 2);
    }
    return c;
  }
  upgradeCost(s: Settlement): Bundle | null {
    if (s.level === "city") return null;
    const target = s.level === "village" ? "town" : "city";
    const c = { ...this.rules.settlement.upgradeCost[target] };
    if (target === "town" && this.hasTech(s.team, "statecraft")) {
      c.food = Math.max(0, (c.food ?? 0) - 2);
      c.wood = Math.max(0, (c.wood ?? 0) - 2);
    }
    return c;
  }
  wallsCost(team: string): Bundle {
    const c = { ...this.rules.buildings.walls.cost };
    if (this.hasTech(team, "masonry")) for (const r of RESOURCES) if (c[r]) c[r] = Math.ceil(c[r]! / 2);
    return c;
  }
  bankRate(team: string) {
    return this.hasTech(team, "currency") ? this.rules.currencyBankRate : this.rules.bankRate;
  }

  techAvailable(team: string, tech: string): string | null {
    const t = this.rules.techs[tech];
    if (!t) return "unknown tech";
    if (this.hasTech(team, tech)) return "already known";
    if (t.requiresAny?.length && !t.requiresAny.some((x) => this.hasTech(team, x))) return `needs one of: ${t.requiresAny.join(", ")}`;
    if (t.requiresAll?.length && !t.requiresAll.every((x) => this.hasTech(team, x))) return `needs all of: ${t.requiresAll.join(", ")}`;
    return null;
  }

  /** Per-turn yield of a settlement, skipping blockaded tiles. */
  settlementYield(s: Settlement, blockaded = new Set<string>()): Record<Resource, number> {
    const out = BUNDLE_ZERO();
    const lvl = LEVELS.indexOf(s.level);
    const produced = new Set<Resource>();
    for (const k of s.claims) {
      if (blockaded.has(k)) continue;
      const t = this.state.tiles.get(k);
      if (!t) continue;
      const y = { ...(this.rules.yields[t.terrain] ?? {}) };
      if (t.terrain === "plains" && this.hasTech(s.team, "irrigation")) y.food = (y.food ?? 0) + 1;
      if (t.terrain === "forest" && this.hasTech(s.team, "forestry")) y.wood = (y.wood ?? 0) + 1;
      if (t.terrain === "hills" && this.hasTech(s.team, "mining")) y.ore = (y.ore ?? 0) + 1;
      if (t.terrain === "crystal" && this.hasTech(s.team, "crystal_lore")) y.crystal = (y.crystal ?? 0) + 1;
      if (t.terrain === "heart" && this.hasTech(s.team, "crystal_lore")) y.crystal = (y.crystal ?? 0) + 2;
      for (const r of RESOURCES) {
        if (!y[r]) continue;
        out[r] += y[r]! + (r === "crystal" ? 0 : lvl * this.rules.levelBonusPerTile);
        produced.add(r);
      }
    }
    if (this.hasTech(s.team, "guilds")) for (const r of produced) out[r] += 1;
    return out;
  }

  // ---------- VP ----------

  scores(): Map<string, VpBreakdown> {
    const m = new Map<string, VpBreakdown>();
    for (const t of this.state.teams) {
      const b: VpBreakdown = { settlements: 0, monuments: 0, spire: 0, tech: 0, glory: t.glory, heart: t.heart, total: 0 };
      for (const s of this.teamSettlements(t.id)) {
        b.settlements += this.rules.vp.settlement[s.level];
        if (s.monument) b.monuments += this.rules.buildings.monument.vp;
        if (s.spire) b.spire += this.rules.buildings.spire.vp;
      }
      for (const tech of t.techs) b.tech += this.rules.vp.techTier[this.rules.techs[tech].tier];
      b.total = b.settlements + b.monuments + b.spire + b.tech + b.glory + b.heart;
      m.set(t.id, b);
    }
    return m;
  }

  /** [winner, loser]. An eliminated team always loses; then VP; then total stockpile. */
  ranking(): string[] {
    const sc = this.scores();
    const stockOf = (t: string) => this.team(t).agents.reduce((a, ag) => a + bundleValue(this.state.agents.get(ag)!.stock), 0);
    const cmp = (a: string, b: string) =>
      Number(this.teamAlive(b)) - Number(this.teamAlive(a)) || sc.get(b)!.total - sc.get(a)!.total || stockOf(b) - stockOf(a);
    const [a, b] = this.state.teams.map((t) => t.id);
    return cmp(a, b) <= 0 ? [a, b] : [b, a];
  }
  private isTie(): boolean {
    const [a, b] = this.ranking();
    const sc = this.scores();
    const stockOf = (t: string) => this.team(t).agents.reduce((x, ag) => x + bundleValue(this.state.agents.get(ag)!.stock), 0);
    return this.teamAlive(a) === this.teamAlive(b) && sc.get(a)!.total === sc.get(b)!.total && stockOf(a) === stockOf(b);
  }

  // ---------- vision ----------

  visibleTo(team: string): Set<string> {
    const vis = new Set<string>(["0,0"]);
    const add = (c: Hex, r: number) => {
      for (const h of inRange(c, r)) if (this.state.tiles.has(key(h))) vis.add(key(h));
    };
    for (const s of this.teamSettlements(team)) add(s.pos, this.rules.settlement.sight + (this.hasTech(team, "cartography") ? 1 : 0));
    for (const u of this.state.units.values()) if (u.team === team) add(u.pos, this.unitSight(u));
    return vis;
  }

  updateVision() {
    for (const t of this.state.teams) {
      for (const k of this.visibleTo(t.id)) {
        t.explored.add(k);
        const s = this.settlementAt(parseHex(k));
        if (s) t.memory.set(k, `${s.id} ${s.level} of ${s.owner}`);
        else t.memory.delete(k);
      }
    }
  }

  // ---------- helpers used by command definitions ----------

  log(vis: string | null, kind: string, text: string, data?: Record<string, unknown>) {
    const e: GameEvent = { turn: this.state.turn, vis, kind, text, data };
    this.state.events.push(e);
    this.turnEvents.push(e);
  }
  fb(agent: string, line: string) {
    if (!this.feedback.has(agent)) this.feedback.set(agent, []);
    this.feedback.get(agent)!.push(line);
  }
  canAfford(agent: string, cost: Bundle) {
    const st = this.state.agents.get(agent)!.stock;
    return RESOURCES.every((r) => st[r] >= (cost[r] ?? 0));
  }
  pay(agent: string, cost: Bundle, category?: keyof TeamStats["spend"]) {
    const a = this.state.agents.get(agent)!;
    for (const r of RESOURCES) a.stock[r] -= cost[r] ?? 0;
    if (category) this.stats.get(a.team)!.spend[category] += bundleValue(cost);
  }
  gain(agent: string, b: Bundle) {
    const a = this.state.agents.get(agent)!;
    for (const r of RESOURCES) a.stock[r] += b[r] ?? 0;
  }
  missing(agent: string, cost: Bundle, stock?: Record<Resource, number>) {
    const st = stock ?? this.state.agents.get(agent)!.stock;
    const m: Bundle = {};
    for (const r of RESOURCES) if ((cost[r] ?? 0) > st[r]) m[r] = (cost[r] ?? 0) - st[r];
    return RESOURCES.filter((r) => m[r]).map((r) => `${m[r]} ${r}`).join(", ");
  }
  newId(prefix: string) {
    return `${prefix}${this.state.nextId++}`;
  }

  spawnUnit(owner: string, type: UnitType, pos: Hex): Unit {
    const team = this.state.agents.get(owner)!.team;
    const u: Unit = { id: this.newId("u"), type, owner, team, pos: { ...pos }, hp: this.unitMaxHp(type, team), dest: null };
    this.state.units.set(u.id, u);
    return u;
  }

  foundSettlement(owner: string, pos: Hex, initial = false): Settlement {
    const team = this.state.agents.get(owner)!.team;
    const claims: string[] = [];
    for (const h of inRange(pos, 1)) {
      const k = key(h);
      if (this.state.tiles.has(k) && !this.claimOwner(k)) claims.push(k);
    }
    const s: Settlement = {
      id: this.newId("s"),
      name: SETTLEMENT_NAMES[this.nameIdx++ % SETTLEMENT_NAMES.length],
      owner, team, pos: { ...pos }, level: "village", hp: 0, walls: false, monument: false, spire: false, founded: this.state.turn, claims,
    };
    s.hp = this.settlementMaxHp(s);
    this.state.settlements.set(s.id, s);
    if (!initial) this.stats.get(team)!.settlementsFounded++;
    return s;
  }

  findUnit(agent: string, id: string): Unit | string {
    const u = this.state.units.get(id);
    if (!u) return `no unit ${id}`;
    if (u.owner !== agent) return `${id} belongs to ${u.owner}, not you (you can only command your own units)`;
    return u;
  }
  findSettlement(agent: string, ref: string): Settlement | string {
    let s = this.state.settlements.get(ref);
    if (!s) s = [...this.state.settlements.values()].find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!s) return `no settlement ${ref}`;
    if (s.owner !== agent) return `${ref} belongs to ${s.owner}, not you`;
    return s;
  }

  passableFor(u: Unit) {
    return (h: Hex) => {
      const t = this.tile(h);
      if (!t || !passableTerrain(t.terrain)) return false;
      const s = this.settlementAt(h);
      // Enemy settlements are closed during the truce.
      if (s && s.team !== u.team && !this.atWar(s.team, u.team)) return false;
      return true;
    };
  }

  shuffled<T>(a: T[]): T[] {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }

  // ---------- turn resolution ----------

  /**
   * Resolves one turn. `orders` are validated, queued orders per agent (from the command
   * layer). Each order resolves at its step; within a step, agents go in random order and each
   * agent's orders go in the order they were queued.
   */
  resolveTurn(orders: Map<string, QueuedOrder[]>): TurnResult {
    this.feedback = new Map();
    this.turnEvents = [];
    this.pendingSpawns = [];
    this.combatHexes = new Set();
    this.startPos = new Map([...this.state.units.values()].map((u) => [u.id, key(u.pos)]));
    for (const s of this.state.settlements.values()) s.attackedThisTurn = false;
    if (this.state.turn === this.rules.truceTurns + 1) this.log(null, "truce", `The truce is over. From now on, units that meet will fight.`);

    const ctx: ResolveCtx = {
      builtAt: new Set(),
      fail: (agent, raw, why) => {
        this.stats.get(this.state.agents.get(agent)!.team)!.orderErrors++;
        this.fb(agent, `FAILED "${raw}": ${why}`);
      },
    };
    for (const [agent, list] of orders) this.stats.get(this.state.agents.get(agent)!.team)!.ordersIssued += list.length;
    const agentOrder = this.shuffled([...orders.keys()]);
    for (const step of STEPS) {
      for (const def of ORDERS.filter((d) => d.step === step && d.resolveAll)) {
        const items = agentOrder.flatMap((agent) => orders.get(agent)!.filter((o) => o.name === def.name).map((o) => ({ agent, a: o.args, raw: o.raw })));
        if (items.length) def.resolveAll!(this, items, ctx);
      }
      for (const agent of agentOrder)
        for (const o of orders.get(agent)!) {
          const def = ORDERS.find((d) => d.name === o.name)!;
          if (def.step === step && def.resolve) def.resolve(this, agent, o.args, o.raw, ctx);
        }
      if (step === "movement") this.resolveMovement();
    }

    this.resolveCombat();

    for (const sp of this.pendingSpawns) {
      const s = this.state.settlements.get(sp.settlement);
      if (!s || s.owner !== sp.owner) {
        this.gain(sp.owner, sp.cost);
        this.fb(sp.owner, `REFUNDED ${sp.type}: ${sp.settlement} was lost before it was ready`);
        continue;
      }
      if (this.unitsAt(s.pos).filter((x) => x.team === s.team).length >= this.rules.maxStack) {
        this.gain(sp.owner, sp.cost);
        this.fb(sp.owner, `REFUNDED ${sp.type}: ${s.id} is full (max ${this.rules.maxStack} units per hex per team)`);
        continue;
      }
      const u = this.spawnUnit(sp.owner, sp.type, s.pos);
      this.fb(sp.owner, `NEW ${u.type} ${u.id} at ${s.id} ${fmt(s.pos)}`);
    }

    this.resolveRuins();
    this.resolveEconomy();

    const heart = this.settlementAt({ q: 0, r: 0 });
    if (heart) {
      this.team(heart.team).heart += this.rules.vp.heartPerTurn;
      this.stats.get(heart.team)!.heartTurns++;
    }

    this.updateVision();
    for (const t of this.state.teams) {
      const st = this.stats.get(t.id)!;
      st.peakSettlements = Math.max(st.peakSettlements, this.teamSettlements(t.id).length);
      st.peakMilitary = Math.max(st.peakMilitary, [...this.state.units.values()].filter((u) => u.team === t.id && this.isMilitary(u.type)).length);
    }
    const sc = this.scores();
    const alive = this.state.teams.filter((t) => this.teamAlive(t.id));
    const hit = [...sc.values()].some((b) => b.total >= this.rules.vpTarget);
    if (this.state.turn >= this.rules.turns || hit || alive.length <= 1) {
      this.state.over = true;
      this.state.draw = this.isTie();
      this.state.winner = this.state.draw ? null : this.ranking()[0];
      const why = alive.length <= 1 ? "by elimination" : hit ? `by reaching ${this.rules.vpTarget} VP` : "on VP at the turn limit";
      this.log(null, "end", this.state.draw ? `Game over after turn ${this.state.turn}: a draw.` : `Game over after turn ${this.state.turn}. ${this.team(this.state.winner!).name} wins ${why}.`);
    } else this.state.turn++;
    return { feedback: this.feedback, events: this.turnEvents };
  }

  private hostileAt(h: Hex, team: string): boolean {
    const s = this.settlementAt(h);
    if (s && this.atWar(s.team, team)) return true;
    return this.unitsAt(h).some((x) => this.atWar(x.team, team));
  }

  private resolveMovement() {
    const moving = new Map<string, { path: Hex[]; left: number; engaged: boolean }>();
    for (const u of this.state.units.values()) {
      if (!u.dest) continue;
      if (key(u.dest) === key(u.pos)) {
        u.dest = null;
        continue;
      }
      const path = findPath(u.pos, u.dest, this.passableFor(u));
      if (!path) {
        this.fb(u.owner, `BLOCKED ${u.id} has no route to ${fmt(u.dest)}; order cleared`);
        u.dest = null;
        continue;
      }
      moving.set(u.id, { path, left: this.unitMove(u), engaged: false });
    }
    const maxSteps = Math.max(0, ...[...moving.values()].map((m) => m.left));
    for (let step = 0; step < maxSteps; step++) {
      const proposals = new Map<string, Hex>();
      for (const [id, m] of moving) if (!m.engaged && m.left > 0 && m.path.length) proposals.set(id, m.path[0]);
      // Enemies trying to swap hexes: only the stronger one moves (into the other).
      for (const [id, to] of proposals) {
        const u = this.state.units.get(id)!;
        for (const [id2, to2] of proposals) {
          if (id2 <= id) continue;
          const v = this.state.units.get(id2)!;
          if (!this.atWar(u.team, v.team)) continue;
          if (key(to) === key(v.pos) && key(to2) === key(u.pos)) {
            if (this.unitStr(u) + u.hp >= this.unitStr(v) + v.hp) proposals.delete(id2);
            else proposals.delete(id);
          }
        }
      }
      for (const [id, to] of this.shuffled([...proposals.entries()])) {
        const u = this.state.units.get(id)!;
        const m = moving.get(id)!;
        if (this.unitsAt(to).filter((x) => x.team === u.team).length >= this.rules.maxStack) {
          m.left = 0;
          this.fb(u.owner, `WAIT ${u.id} stopped: ${fmt(to)} is full`);
          continue;
        }
        u.pos = { ...to };
        m.path.shift();
        m.left--;
        if (this.hostileAt(u.pos, u.team)) {
          m.engaged = true;
          for (const x of this.unitsAt(u.pos)) {
            const mx = moving.get(x.id);
            if (mx && this.atWar(x.team, u.team)) mx.engaged = true;
          }
        }
      }
    }
    for (const [id, m] of moving) {
      const u = this.state.units.get(id);
      if (!u) continue;
      if (u.dest && key(u.dest) === key(u.pos)) u.dest = null;
      if (m.engaged) this.fb(u.owner, `CONTACT ${u.id} ran into enemies at ${fmt(u.pos)}`);
    }
  }

  private resolveCombat() {
    const hexes = new Set<string>();
    for (const u of this.state.units.values()) hexes.add(key(u.pos));
    for (const k of hexes) {
      const h = parseHex(k);
      const units = this.unitsAt(h);
      const settlement = this.settlementAt(h);
      const teams = new Set(units.map((u) => u.team));
      if (settlement) teams.add(settlement.team);
      const tl = [...teams];
      if (tl.length < 2 || !this.atWar(tl[0], tl[1])) continue;
      this.combatHexes.add(k);
      const terrain = this.tile(h)!.terrain;
      // Attackers: teams that moved a unit onto this hex this turn.
      for (const t of tl) {
        if (units.some((u) => u.team === t && this.startPos.get(u.id) !== k)) {
          const st = this.stats.get(t)!;
          st.attacks++;
          st.firstAttackTurn ??= this.state.turn;
        }
      }
      const side = (t: string) => {
        const us = units.filter((u) => u.team === t);
        let normal = 0;
        let siege = 0;
        for (const u of us) {
          const bonus = terrain === "hills" && this.startPos.get(u.id) === k ? this.rules.hillsDefenseBonus : 0;
          const s = this.unitStr(u) + bonus;
          if (this.rules.units[u.type].siege) siege += s;
          else normal += s;
        }
        if (settlement && settlement.team === t) normal += this.settlementDefense(settlement);
        return { us, normal, siege };
      };
      const sides = new Map(tl.map((t) => [t, side(t)]));
      const report: string[] = [];
      for (const t of tl) {
        const enemy = sides.get(tl.find((o) => o !== t)!)!;
        const sd = sides.get(t)!;
        const defendsSettlement = settlement && settlement.team === t;
        const siegeVsSettlement = defendsSettlement ? enemy.siege * (this.rules.units.catapult.siege ?? 1) : 0;
        let pool = enemy.normal + (defendsSettlement ? 0 : enemy.siege);
        // Military units shield civilians; sturdiest first.
        const order = [...sd.us].sort((a, b) => Number(this.isMilitary(b.type)) - Number(this.isMilitary(a.type)) || b.hp - a.hp);
        for (const u of order) {
          if (pool <= 0) break;
          const hit = Math.min(pool, u.hp);
          u.hp -= hit;
          pool -= hit;
          if (u.hp <= 0) {
            this.state.units.delete(u.id);
            this.stats.get(u.team)!.unitsLost++;
            this.stats.get(tl.find((o) => o !== t)!)!.unitsKilled++;
            report.push(`${u.owner}'s ${u.type} ${u.id} was destroyed`);
            this.fb(u.owner, `LOST ${u.type} ${u.id} at ${fmt(h)}`);
          }
        }
        if (defendsSettlement) {
          const toSettlement = pool + siegeVsSettlement;
          if (toSettlement > 0) {
            settlement.hp = Math.max(0, settlement.hp - toSettlement);
            report.push(`${settlement.name} (${settlement.id}) took ${toSettlement} damage (HP ${settlement.hp}/${this.settlementMaxHp(settlement)})`);
          }
          settlement.attackedThisTurn = true;
        }
      }
      this.log(null, "combat", `Battle at ${fmt(h)} (${tl.map((t) => this.team(t).name).join(" vs ")}): ${report.join("; ") || "no losses"}.`, { hex: k, teams: tl });
      if (settlement && settlement.hp <= 0) this.tryCapture(settlement, h);
    }
  }

  private tryCapture(settlement: Settlement, h: Hex) {
    const defenders = this.unitsAt(h).filter((u) => u.team === settlement.team);
    const attackers = this.unitsAt(h).filter((u) => this.atWar(u.team, settlement.team) && this.unitStr(u) > 0);
    if (defenders.length || !attackers.length) return;
    const byAgent = new Map<string, number>();
    for (const u of attackers) byAgent.set(u.owner, (byAgent.get(u.owner) ?? 0) + this.unitStr(u));
    const captor = [...byAgent.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const ct = this.state.agents.get(captor)!.team;
    const oldTeam = settlement.team;
    const oldOwner = settlement.owner;
    settlement.owner = captor;
    settlement.team = ct;
    if (settlement.level !== "village") settlement.level = LEVELS[LEVELS.indexOf(settlement.level) - 1];
    settlement.walls = false;
    settlement.hp = Math.ceil(this.settlementMaxHp(settlement) / 2);
    this.team(ct).glory += this.rules.vp.capture;
    this.stats.get(ct)!.captures++;
    this.stats.get(oldTeam)!.settlementsLost++;
    if (settlement.spire) this.state.spireBuilt = ct;
    this.log(null, "capture", `${captor} (${this.team(ct).name}) CAPTURED ${settlement.name} (${settlement.id}) from ${oldOwner}! +${this.rules.vp.capture} glory VP.`, { team: ct, from: oldTeam });
    this.fb(oldOwner, `LOST settlement ${settlement.id} ${settlement.name} to ${captor}`);
    this.fb(captor, `CAPTURED ${settlement.id} ${settlement.name}`);
  }

  private resolveRuins() {
    for (const t of this.state.tiles.values()) {
      if (t.terrain !== "ruins") continue;
      const here = this.unitsAt(t).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      if (!here.length) continue;
      const u = here[0];
      const L = this.rules.ruinLoot;
      const n = L.min + Math.floor(this.rand() * (L.max - L.min + 1));
      const loot: Bundle = {};
      for (let i = 0; i < n; i++) {
        const r = RESOURCES[Math.floor(this.rand() * RESOURCES.length)];
        loot[r] = (loot[r] ?? 0) + 1;
      }
      this.gain(u.owner, loot);
      this.team(u.team).glory += L.vp;
      this.stats.get(u.team)!.ruins++;
      t.terrain = "plains";
      this.fb(u.owner, `RUINS explored by ${u.id} at ${fmt(t)}: found ${Object.entries(loot).map(([r, v]) => `${v} ${r}`).join(", ")} (+${L.vp} glory VP)`);
      this.log(null, "ruins", `${u.owner} (${this.team(u.team).name}) explored ruins at ${fmt(t)}.`);
    }
  }

  private resolveEconomy() {
    // Claimed tiles with enemy units on them are raided and produce nothing for their owner.
    for (const s of this.state.settlements.values()) {
      const blocked = new Set<string>();
      for (const k of s.claims) {
        const raiders = this.unitsAt(parseHex(k)).filter((u) => this.atWar(u.team, s.team));
        if (raiders.length) {
          blocked.add(k);
          this.stats.get(raiders[0].team)!.raidTileTurns++;
        }
      }
      if (s.attackedThisTurn) {
        this.fb(s.owner, `BESIEGED ${s.id} produced nothing this turn`);
        continue;
      }
      this.gain(s.owner, this.settlementYield(s, blocked));
      if (blocked.size) this.fb(s.owner, `RAIDED ${s.id}: ${blocked.size} tile(s) occupied by enemies produced nothing`);
    }
    for (const a of this.state.agents.values()) {
      const units = this.unitsOf(a.id);
      a.stock.food -= units.length * this.rules.upkeepPerUnit;
      if (a.stock.food < 0) {
        a.stock.food = 0;
        for (const u of units) {
          u.hp -= 1;
          if (u.hp <= 0) {
            this.state.units.delete(u.id);
            this.stats.get(u.team)!.unitsLost++;
            this.fb(a.id, `STARVED ${u.type} ${u.id} died (no food for upkeep)`);
          }
        }
        this.fb(a.id, `STARVING: not enough food for unit upkeep; every unit lost 1 HP`);
      }
    }
    for (const u of this.state.units.values()) {
      if (this.combatHexes.has(key(u.pos))) continue;
      const claim = this.claimOwner(key(u.pos));
      if (!claim || claim.team !== u.team) continue;
      const heal = this.hasTech(u.team, "tactics") ? 2 : this.rules.healPerTurn;
      u.hp = Math.min(this.unitMaxHp(u.type, u.team), u.hp + heal);
    }
    for (const s of this.state.settlements.values()) if (!s.attackedThisTurn) s.hp = Math.min(this.settlementMaxHp(s), s.hp + this.rules.settlement.regen);
  }

  // ---------- snapshots for logs / UI ----------

  snapshot() {
    const sc = this.scores();
    return {
      turn: this.state.turn,
      over: this.state.over,
      winner: this.state.winner,
      draw: this.state.draw,
      fighting: this.fighting,
      teams: this.state.teams.map((t) => ({ id: t.id, name: t.name, agents: t.agents, techs: [...t.techs], vp: sc.get(t.id)!, alive: this.teamAlive(t.id), seat: this.seat.get(t.id) })),
      agents: [...this.state.agents.values()].map((a) => ({ id: a.id, team: a.team, stock: { ...a.stock } })),
      units: [...this.state.units.values()].map((u) => ({ ...u, pos: { ...u.pos }, dest: u.dest ? { ...u.dest } : null, maxHp: this.unitMaxHp(u.type, u.team) })),
      settlements: [...this.state.settlements.values()].map((s) => ({ ...s, pos: { ...s.pos }, claims: [...s.claims], maxHp: this.settlementMaxHp(s) })),
      tiles: [...this.state.tiles.values()].map((t) => ({ q: t.q, r: t.r, t: t.terrain })),
      visible: Object.fromEntries(this.state.teams.map((t) => [t.id, [...this.visibleTo(t.id)]])),
    };
  }
}

export type Snapshot = ReturnType<Engine["snapshot"]>;

export function parseHex(k: string): Hex {
  const [q, r] = k.split(",").map(Number);
  return { q, r };
}

export type { AgentState };
