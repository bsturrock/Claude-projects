import { LEVELS, RESOURCES, UNIT_TYPES, type Bundle, type Level, type Resource, type Ruleset, type UnitType } from "./config.js";
import { type Hex, dist, findPath, fmt, inRange, key, rng } from "./hex.js";
import { capitalsForSeat, generateMap, passableTerrain } from "./map.js";
import type { AgentState, GameEvent, GameState, Offer, Settlement, Stance, TeamState, Unit, VpBreakdown } from "./types.js";

export interface TeamSetup {
  id: string;
  name: string;
  agents: string[]; // exactly 3, in fixed order
}

/** Behaviour counters per team, used by the league to compare how strategies differ. */
export interface TeamStats {
  unitsBuilt: Record<UnitType, number>;
  settlementsFounded: number;
  captures: number;
  settlementsLost: number;
  unitsLost: number;
  unitsKilled: number;
  warsDeclared: number;
  peacesMade: number;
  /** Turn of the team's first war declaration, or null. */
  firstWarTurn: number | null;
  /** War declared on a team this team was at peace with within the last 3 turns of making peace. */
  betrayals: number;
  tradesCross: number;
  giftsCrossValue: number;
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
export const bundleValue = (b: Bundle) => RESOURCES.reduce((a, r) => a + (b[r] ?? 0), 0);
export const fmtBundle = (b: Bundle) =>
  RESOURCES.filter((r) => (b[r] ?? 0) > 0)
    .map((r) => `${b[r]} ${r}`)
    .join(", ") || "nothing";

const SETTLEMENT_NAMES = [
  "Ashford", "Brightwater", "Cinder Hollow", "Dunmere", "Eastmarch", "Fallow", "Glimmer", "Harrow", "Ironwell", "Juniper",
  "Kestrel", "Lowmoor", "Mistvale", "Northgate", "Oakheart", "Pellam", "Quarry", "Redfern", "Stonebridge", "Thornby",
  "Umber", "Vantage", "Westholm", "Yarrow", "Zephyr", "Amberlea", "Briar", "Coldspring", "Driftwood", "Emberly",
  "Foxglove", "Greystone", "Hollin", "Isen", "Larkspur", "Marrow", "Nettle", "Orrin", "Pike", "Rookery",
];

export interface ParsedOrder {
  raw: string;
  kind: string;
  args: Record<string, any>;
}

export interface TurnResult {
  /** Feedback lines per agent ("OK ..." / "FAILED ..."), shown in their next observation. */
  feedback: Map<string, string[]>;
  events: GameEvent[];
}

export class Engine {
  state: GameState;
  stats = new Map<string, TeamStats>();
  /** Turn each pair of teams last made peace (for betrayal stats). */
  private peaceTurn = new Map<string, number>();
  private rand: () => number;
  private nameIdx = 0;
  /** Seat index per team id (0..2). */
  seat = new Map<string, number>();
  /** Units built this turn, spawned after combat. */
  private pendingSpawns: { owner: string; type: UnitType; settlement: string; cost: Bundle }[] = [];
  private combatHexes = new Set<string>();
  private startPos = new Map<string, string>();
  feedback = new Map<string, string[]>();

  constructor(
    public rules: Ruleset,
    teams: TeamSetup[],
    seed: number,
  ) {
    if (teams.length !== 3) throw new Error("Shardlands needs exactly 3 teams");
    this.rand = rng(seed ^ 0x9e3779b9);
    this.state = {
      seed,
      turn: 1,
      tiles: generateMap(rules, seed),
      teams: [],
      agents: new Map(),
      units: new Map(),
      settlements: new Map(),
      stances: new Map(),
      peaceOffers: new Map(),
      offers: new Map(),
      spireBuilt: null,
      nextId: 1,
      events: [],
      messages: [],
      over: false,
      winner: null,
    };
    teams.forEach((t, seat) => {
      if (t.agents.length !== 3) throw new Error(`team ${t.id} needs exactly 3 agents`);
      this.seat.set(t.id, seat);
      const ts: TeamState = { id: t.id, name: t.name, agents: [...t.agents], techs: [], glory: 0, heart: 0, commerce: 0, commerceTurn: 0, explored: new Set(), memory: new Map() };
      this.state.teams.push(ts);
      this.stats.set(t.id, {
        unitsBuilt: Object.fromEntries(UNIT_TYPES.map((u) => [u, 0])) as Record<UnitType, number>,
        settlementsFounded: 0, captures: 0, settlementsLost: 0, unitsLost: 0, unitsKilled: 0, warsDeclared: 0, peacesMade: 0,
        firstWarTurn: null, betrayals: 0, tradesCross: 0, giftsCrossValue: 0, giftsTeamValue: 0, exchanges: 0, ruins: 0, techs: [],
        spend: { military: 0, expansion: 0, development: 0, tech: 0 }, peakSettlements: 0, peakMilitary: 0, orderErrors: 0, ordersIssued: 0,
      });
      const caps = capitalsForSeat(seat);
      t.agents.forEach((a, i) => {
        const stock = BUNDLE_ZERO();
        for (const r of RESOURCES) stock[r] = rules.start.stock[r] ?? 0;
        this.state.agents.set(a, { id: a, team: t.id, stock });
        this.foundSettlement(a, caps[i], true);
        for (const u of rules.start.units) this.spawnUnit(a, u, caps[i]);
      });
    });
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) this.state.stances.set(pairKey(this.state.teams[i].id, this.state.teams[j].id), "peace");
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
  hasTech(team: string, tech: string) {
    return this.team(team).techs.includes(tech);
  }
  stance(a: string, b: string): Stance {
    if (a === b) return "peace";
    return this.state.stances.get(pairKey(a, b)) ?? "peace";
  }
  atWar(a: string, b: string) {
    return a !== b && this.stance(a, b) === "war";
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
    const spec = this.rules.units[u.type];
    let s = spec.str;
    if (u.type === "soldier" && this.hasTech(u.team, "bronze")) s += 1;
    if ((u.type === "soldier" || u.type === "rider") && this.hasTech(u.team, "steel")) s += 1;
    return s;
  }
  unitMaxHp(type: UnitType, team: string) {
    const base = this.rules.units[type].hp;
    return base + (["soldier", "rider", "catapult"].includes(type) && this.hasTech(team, "tactics") ? 1 : 0);
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
  tradeCap(team: string) {
    return this.rules.vp.tradeCap + (this.hasTech(team, "guilds") ? 4 : 0);
  }

  techAvailable(team: string, tech: string): string | null {
    const t = this.rules.techs[tech];
    if (!t) return "unknown tech";
    if (this.hasTech(team, tech)) return "already known";
    if (t.requiresAny?.length && !t.requiresAny.some((x) => this.hasTech(team, x))) return `needs one of: ${t.requiresAny.join(", ")}`;
    if (t.requiresAll?.length && !t.requiresAll.every((x) => this.hasTech(team, x))) return `needs all of: ${t.requiresAll.join(", ")}`;
    return null;
  }

  /** Per-turn yield of a settlement, before blockades. */
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
        // Level bonus applies to food/wood/ore tiles; crystal is scarce on purpose.
        const bonus = r === "crystal" ? 0 : lvl * this.rules.levelBonusPerTile;
        out[r] += y[r]! + bonus;
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
      const b: VpBreakdown = { settlements: 0, monuments: 0, spire: 0, tech: 0, glory: t.glory, heart: t.heart, commerce: t.commerce, total: 0 };
      for (const s of this.teamSettlements(t.id)) {
        b.settlements += this.rules.vp.settlement[s.level];
        if (s.monument) b.monuments += this.rules.buildings.monument.vp;
        if (s.spire) b.spire += this.rules.buildings.spire.vp;
      }
      for (const tech of t.techs) b.tech += this.rules.vp.techTier[this.rules.techs[tech].tier];
      b.total = b.settlements + b.monuments + b.spire + b.tech + b.glory + b.heart + b.commerce;
      m.set(t.id, b);
    }
    return m;
  }

  /** Final ranking: eliminated teams last, then VP, then total stockpile. */
  ranking(): string[] {
    const sc = this.scores();
    const stockOf = (t: string) => this.team(t).agents.reduce((a, ag) => a + bundleValue(this.state.agents.get(ag)!.stock), 0);
    return this.state.teams
      .map((t) => t.id)
      .sort((a, b) => {
        const alive = Number(this.teamAlive(b)) - Number(this.teamAlive(a));
        if (alive) return alive;
        return sc.get(b)!.total - sc.get(a)!.total || stockOf(b) - stockOf(a);
      });
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
      const vis = this.visibleTo(t.id);
      for (const k of vis) {
        t.explored.add(k);
        const s = this.settlementAt(parseHex(k));
        if (s) t.memory.set(k, `${s.id} ${s.level} of ${s.owner}`);
        else t.memory.delete(k);
      }
    }
  }

  // ---------- helpers that mutate ----------

  private log(vis: string | null, kind: string, text: string, data?: Record<string, unknown>) {
    const e: GameEvent = { turn: this.state.turn, vis, kind, text, data };
    this.state.events.push(e);
    this.turnEvents.push(e);
  }
  private turnEvents: GameEvent[] = [];

  private fb(agent: string, line: string) {
    if (!this.feedback.has(agent)) this.feedback.set(agent, []);
    this.feedback.get(agent)!.push(line);
  }

  private canAfford(agent: string, cost: Bundle) {
    const st = this.state.agents.get(agent)!.stock;
    return RESOURCES.every((r) => st[r] >= (cost[r] ?? 0));
  }
  private pay(agent: string, cost: Bundle, category?: keyof TeamStats["spend"]) {
    const a = this.state.agents.get(agent)!;
    for (const r of RESOURCES) a.stock[r] -= cost[r] ?? 0;
    if (category) this.stats.get(a.team)!.spend[category] += bundleValue(cost);
  }
  private gain(agent: string, b: Bundle) {
    const a = this.state.agents.get(agent)!;
    for (const r of RESOURCES) a.stock[r] += b[r] ?? 0;
  }
  private missing(agent: string, cost: Bundle) {
    const st = this.state.agents.get(agent)!.stock;
    return fmtBundle(Object.fromEntries(RESOURCES.map((r) => [r, Math.max(0, (cost[r] ?? 0) - st[r])])) as Bundle);
  }

  private newId(prefix: string) {
    return `${prefix}${this.state.nextId++}`;
  }

  private spawnUnit(owner: string, type: UnitType, pos: Hex): Unit {
    const team = this.state.agents.get(owner)!.team;
    const u: Unit = { id: this.newId("u"), type, owner, team, pos: { ...pos }, hp: this.unitMaxHp(type, team), dest: null };
    this.state.units.set(u.id, u);
    return u;
  }

  private foundSettlement(owner: string, pos: Hex, initial = false): Settlement {
    const team = this.state.agents.get(owner)!.team;
    const claims: string[] = [];
    for (const h of inRange(pos, 1)) {
      const k = key(h);
      if (this.state.tiles.has(k) && !this.claimOwner(k)) claims.push(k);
    }
    const s: Settlement = {
      id: this.newId("s"),
      name: SETTLEMENT_NAMES[this.nameIdx++ % SETTLEMENT_NAMES.length],
      owner,
      team,
      pos: { ...pos },
      level: "village",
      hp: 0,
      walls: false,
      monument: false,
      spire: false,
      founded: this.state.turn,
      claims,
    };
    s.hp = this.settlementMaxHp(s);
    this.state.settlements.set(s.id, s);
    if (!initial) this.stats.get(team)!.settlementsFounded++;
    return s;
  }

  findUnit(agent: string, id: string): Unit | string {
    const u = this.state.units.get(id);
    if (!u) return `no unit ${id}`;
    if (u.owner !== agent) return `${id} is not your unit`;
    return u;
  }
  findSettlement(agent: string, ref: string): Settlement | string {
    let s = this.state.settlements.get(ref);
    if (!s) s = [...this.state.settlements.values()].find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!s) return `no settlement ${ref}`;
    if (s.owner !== agent) return `${ref} is not your settlement`;
    return s;
  }

  // ---------- order parsing ----------

  parse(agent: string, raw: string): ParsedOrder | string {
    const text = raw.trim().toLowerCase().replace(/[(),:;]/g, " ").replace(/\s+/g, " ").trim();
    const tok = text.split(" ").filter(Boolean);
    const verb = tok[0];
    const rest = tok.slice(1);
    const coord = (a: string[]): Hex | null => {
      const nums = a.map(Number);
      if (nums.length < 2 || nums.slice(0, 2).some((n) => !Number.isInteger(n))) return null;
      return { q: nums[0], r: nums[1] };
    };
    switch (verb) {
      case "move":
      case "goto": {
        const h = coord(rest.slice(1).filter((x) => x !== "to"));
        if (!rest[0] || !h) return "usage: move <unit> <q>,<r>";
        return { raw, kind: "move", args: { unit: rest[0], to: h } };
      }
      case "stop":
      case "hold":
        if (!rest[0]) return "usage: stop <unit>";
        return { raw, kind: "stop", args: { unit: rest[0] } };
      case "found":
      case "settle":
        if (!rest[0]) return "usage: found <settler>";
        return { raw, kind: "found", args: { unit: rest[0] } };
      case "build":
      case "train": {
        const type = singular(rest[0]) as UnitType;
        if (!UNIT_TYPES.includes(type)) return `unknown unit type "${rest[0]}" (types: ${UNIT_TYPES.join(", ")})`;
        const at = rest.filter((x) => x !== "at" && x !== "in")[1];
        if (!at) return "usage: build <type> <settlement>";
        return { raw, kind: "build", args: { type, at } };
      }
      case "upgrade":
        if (!rest[0]) return "usage: upgrade <settlement>";
        return { raw, kind: "upgrade", args: { at: rest[0] } };
      case "construct": {
        const what = rest[0];
        if (!["walls", "wall", "monument", "spire"].includes(what)) return "usage: construct walls|monument|spire <settlement>";
        const at = rest.filter((x) => x !== "at" && x !== "in")[1];
        if (!at) return "usage: construct walls|monument|spire <settlement>";
        return { raw, kind: "construct", args: { what: what === "wall" ? "walls" : what, at } };
      }
      case "research": {
        const tech = rest.join("_");
        const id = Object.keys(this.rules.techs).find((k) => k === tech || this.rules.techs[k].name.toLowerCase().replace(/ /g, "_") === tech);
        if (!id) return `unknown tech "${rest.join(" ")}"`;
        return { raw, kind: "research", args: { tech: id } };
      }
      case "give":
      case "send": {
        const to = rest[0];
        const b = parseBundle(rest.slice(1));
        if (!to || typeof b === "string") return typeof b === "string" ? b : "usage: give <agent> <n> <resource> ...";
        return { raw, kind: "give", args: { to, bundle: b } };
      }
      case "offer": {
        const to = rest[0];
        const i = rest.indexOf("for");
        if (!to || i < 0) return "usage: offer <agent> <n> <resource> ... for <n> <resource> ...";
        const give = parseBundle(rest.slice(1, i).filter((x) => x !== "give"));
        const get = parseBundle(rest.slice(i + 1));
        if (typeof give === "string") return give;
        if (typeof get === "string") return get;
        return { raw, kind: "offer", args: { to, give, get } };
      }
      case "accept":
        if (!rest[0]) return "usage: accept <offer-id>";
        return { raw, kind: "accept", args: { id: rest[0] } };
      case "exchange":
      case "bank": {
        const i = rest.indexOf("for");
        if (i < 0) return "usage: exchange <n> <resource> for <resource>";
        const give = parseBundle(rest.slice(0, i));
        const want = normRes(rest[i + 1]);
        if (typeof give === "string") return give;
        const gr = RESOURCES.filter((r) => give[r]);
        if (gr.length !== 1 || !want) return "usage: exchange <n> <resource> for <resource>";
        if (want === gr[0]) return "cannot exchange a resource for itself";
        if (want === "crystal") return "the bank does not sell crystal (get it from crystal tiles, the Heart, ruins or trade)";
        return { raw, kind: "exchange", args: { res: gr[0], n: give[gr[0]]!, want } };
      }
      case "war":
      case "declare": {
        const t = rest.filter((x) => x !== "war" && x !== "on")[0];
        if (!t) return "usage: war <team>";
        return { raw, kind: "war", args: { team: t } };
      }
      case "peace":
        if (!rest[0]) return "usage: peace <team>";
        return { raw, kind: "peace", args: { team: rest[0] } };
      case "disband":
        if (!rest[0]) return "usage: disband <unit>";
        return { raw, kind: "disband", args: { unit: rest[0] } };
      default:
        return `unknown order "${verb ?? ""}"`;
    }
  }

  // ---------- turn resolution ----------

  resolveTurn(orders: Map<string, string[]>): TurnResult {
    this.feedback = new Map();
    this.turnEvents = [];
    this.pendingSpawns = [];
    this.combatHexes = new Set();
    this.startPos = new Map([...this.state.units.values()].map((u) => [u.id, key(u.pos)]));
    for (const s of this.state.settlements.values()) s.attackedThisTurn = false;

    const parsed = new Map<string, ParsedOrder[]>();
    for (const [agent, list] of orders) {
      const team = this.state.agents.get(agent)!.team;
      const st = this.stats.get(team)!;
      const ok: ParsedOrder[] = [];
      for (const raw of list.slice(0, this.rules.maxOrdersPerTurn)) {
        if (!raw.trim()) continue;
        st.ordersIssued++;
        const p = this.parse(agent, raw);
        if (typeof p === "string") {
          st.orderErrors++;
          this.fb(agent, `FAILED "${raw}": ${p}`);
        } else ok.push(p);
      }
      if (list.length > this.rules.maxOrdersPerTurn) this.fb(agent, `Only your first ${this.rules.maxOrdersPerTurn} orders were read.`);
      parsed.set(agent, ok);
    }
    const ofKind = (k: string) => [...parsed.entries()].flatMap(([a, ps]) => ps.filter((p) => p.kind === k).map((p) => ({ agent: a, p })));
    const fail = (agent: string, p: ParsedOrder, why: string) => {
      this.stats.get(this.state.agents.get(agent)!.team)!.orderErrors++;
      this.fb(agent, `FAILED "${p.raw}": ${why}`);
    };

    // 1. Diplomacy.
    this.resolveDiplomacy(ofKind("war"), ofKind("peace"), fail);

    // 2. Economy: accepted trades, then gifts, then each agent's purchases in the order they listed them.
    for (const { agent, p } of ofKind("accept")) this.resolveAccept(agent, p, fail);
    for (const { agent, p } of ofKind("give")) this.resolveGive(agent, p, fail);
    const builtAt = new Set<string>();
    for (const [agent, ps] of this.shuffled([...parsed.entries()])) {
      for (const p of ps) {
        if (p.kind === "exchange") this.resolveExchange(agent, p, fail);
        else if (p.kind === "research") this.resolveResearch(agent, p, fail);
        else if (p.kind === "upgrade") this.resolveUpgrade(agent, p, fail);
        else if (p.kind === "construct") this.resolveConstruct(agent, p, fail);
        else if (p.kind === "build") this.resolveBuild(agent, p, fail, builtAt);
        else if (p.kind === "disband") {
          const u = this.findUnit(agent, p.args.unit);
          if (typeof u === "string") fail(agent, p, u);
          else {
            this.state.units.delete(u.id);
            this.fb(agent, `OK disbanded ${u.id}`);
          }
        }
      }
    }
    for (const { agent, p } of ofKind("offer")) this.resolveOffer(agent, p, fail);

    // 3. Found settlements (settlers found where they stand, before moving).
    for (const { agent, p } of this.shuffled(ofKind("found"))) this.resolveFound(agent, p, fail);

    // 4. Movement.
    for (const { agent, p } of [...ofKind("stop"), ...ofKind("move")]) {
      const u = this.findUnit(agent, p.args.unit);
      if (typeof u === "string") {
        fail(agent, p, u);
        continue;
      }
      if (p.kind === "stop") {
        u.dest = null;
        this.fb(agent, `OK ${u.id} holds position`);
        continue;
      }
      const to = p.args.to as Hex;
      if (!this.tile(to)) {
        fail(agent, p, `${fmt(to)} is off the map`);
        continue;
      }
      if (!passableTerrain(this.tile(to)!.terrain)) {
        fail(agent, p, `${fmt(to)} is ${this.tile(to)!.terrain} (impassable)`);
        continue;
      }
      u.dest = { ...to };
    }
    this.resolveMovement();

    // 5. Combat and captures.
    this.resolveCombat();

    // 6. New units appear.
    for (const sp of this.pendingSpawns) {
      const s = this.state.settlements.get(sp.settlement);
      if (!s || s.owner !== sp.owner) {
        this.gain(sp.owner, sp.cost);
        this.fb(sp.owner, `REFUNDED ${sp.type}: ${sp.settlement} was lost before it was ready`);
        continue;
      }
      const u = this.spawnUnit(sp.owner, sp.type, s.pos);
      this.fb(sp.owner, `NEW ${u.type} ${u.id} at ${s.id} ${fmt(s.pos)}`);
    }

    // 7. Ruins.
    this.resolveRuins();

    // 8-10. Production, upkeep, healing.
    this.resolveEconomy();

    // 11. Heart.
    const heart = this.settlementAt({ q: 0, r: 0 });
    if (heart) {
      this.team(heart.team).heart += this.rules.vp.heartPerTurn;
    }

    // 12. Offers expire.
    for (const [id, o] of this.state.offers)
      if (this.state.turn - o.turn >= this.rules.offerTtl) {
        this.state.offers.delete(id);
        this.fb(o.from, `Offer ${id} to ${o.to} expired.`);
      }
    for (const [k, t] of this.state.peaceOffers) if (this.state.turn - t >= 2) this.state.peaceOffers.delete(k);

    // 13. Vision, stats, end check.
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
      this.state.winner = this.ranking()[0];
      this.log(null, "end", `Game over after turn ${this.state.turn}. ${this.team(this.state.winner).name} wins.`);
    } else this.state.turn++;
    return { feedback: this.feedback, events: this.turnEvents };
  }

  private shuffled<T>(a: T[]): T[] {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }

  private resolveTeamRef(ref: string): TeamState | undefined {
    return this.state.teams.find((t) => t.id === ref || t.name.toLowerCase() === ref);
  }

  private resolveDiplomacy(
    wars: { agent: string; p: ParsedOrder }[],
    peaces: { agent: string; p: ParsedOrder }[],
    fail: (a: string, p: ParsedOrder, why: string) => void,
  ) {
    const votes = (list: typeof wars) => {
      const m = new Map<string, Set<string>>(); // "from>to" -> voters
      for (const { agent, p } of list) {
        const from = this.state.agents.get(agent)!.team;
        const to = this.resolveTeamRef(p.args.team);
        if (!to) {
          fail(agent, p, `unknown team "${p.args.team}"`);
          continue;
        }
        if (to.id === from) {
          fail(agent, p, "that is your own team");
          continue;
        }
        const k = `${from}>${to.id}`;
        if (!m.has(k)) m.set(k, new Set());
        m.get(k)!.add(agent);
      }
      return m;
    };
    const needed = (team: string) => Math.min(2, this.team(team).agents.filter((a) => this.isActive(a)).length || 1);
    for (const [k, voters] of votes(wars)) {
      const [from, to] = k.split(">");
      if (this.atWar(from, to)) {
        for (const a of voters) this.fb(a, `NOTE already at war with ${this.team(to).name}`);
        continue;
      }
      if (voters.size < needed(from)) {
        for (const a of voters)
          this.fb(a, `PENDING war on ${this.team(to).name}: only ${voters.size} of your team voted; ${needed(from)} must order "war ${to}" in the same turn`);
        continue;
      }
      this.state.stances.set(pairKey(from, to), "war");
      const st = this.stats.get(from)!;
      st.warsDeclared++;
      if (st.firstWarTurn === null) st.firstWarTurn = this.state.turn;
      const pt = this.peaceTurn.get(pairKey(from, to));
      if (pt !== undefined && this.state.turn - pt <= 3) st.betrayals++;
      this.state.peaceOffers.delete(`${to}>${from}`);
      this.log(null, "war", `${this.team(from).name} declared WAR on ${this.team(to).name}.`, { from, to });
    }
    for (const [k, voters] of votes(peaces)) {
      const [from, to] = k.split(">");
      if (!this.atWar(from, to)) {
        for (const a of voters) this.fb(a, `NOTE already at peace with ${this.team(to).name}`);
        continue;
      }
      if (voters.size < needed(from)) {
        for (const a of voters) this.fb(a, `PENDING peace with ${this.team(to).name}: ${needed(from)} of your team must order "peace ${to}" in the same turn`);
        continue;
      }
      if (this.state.peaceOffers.has(`${to}>${from}`)) {
        this.state.stances.set(pairKey(from, to), "peace");
        this.state.peaceOffers.delete(`${to}>${from}`);
        this.peaceTurn.set(pairKey(from, to), this.state.turn);
        this.stats.get(from)!.peacesMade++;
        this.stats.get(to)!.peacesMade++;
        this.log(null, "peace", `${this.team(from).name} and ${this.team(to).name} made PEACE.`, { from, to });
      } else {
        this.state.peaceOffers.set(`${from}>${to}`, this.state.turn);
        this.log(null, "peace_offer", `${this.team(from).name} offers peace to ${this.team(to).name} (they must answer "peace ${from}" within 1 turn).`, { from, to });
      }
    }
    // Simultaneous mutual offers made this turn.
    for (const [k, t] of [...this.state.peaceOffers]) {
      const [from, to] = k.split(">");
      if (t === this.state.turn && this.state.peaceOffers.get(`${to}>${from}`) === this.state.turn && this.atWar(from, to)) {
        this.state.stances.set(pairKey(from, to), "peace");
        this.state.peaceOffers.delete(k);
        this.state.peaceOffers.delete(`${to}>${from}`);
        this.peaceTurn.set(pairKey(from, to), this.state.turn);
        this.stats.get(from)!.peacesMade++;
        this.stats.get(to)!.peacesMade++;
        this.log(null, "peace", `${this.team(from).name} and ${this.team(to).name} made PEACE.`, { from, to });
      }
    }
  }

  private resolveAccept(agent: string, p: ParsedOrder, fail: (a: string, p: ParsedOrder, why: string) => void) {
    const o = this.state.offers.get(p.args.id);
    if (!o) return fail(agent, p, `no open offer ${p.args.id}`);
    if (o.to !== agent) return fail(agent, p, `offer ${o.id} is not addressed to you`);
    if (!this.canAfford(o.from, o.give)) {
      this.state.offers.delete(o.id);
      return fail(agent, p, `${o.from} can no longer pay; offer ${o.id} cancelled`);
    }
    if (!this.canAfford(agent, o.get)) return fail(agent, p, `you lack ${this.missing(agent, o.get)}`);
    this.pay(o.from, o.give);
    this.gain(agent, o.give);
    this.pay(agent, o.get);
    this.gain(o.from, o.get);
    this.state.offers.delete(o.id);
    const ta = this.state.agents.get(o.from)!.team;
    const tb = this.state.agents.get(agent)!.team;
    this.fb(agent, `OK trade ${o.id}: received ${fmtBundle(o.give)}, paid ${fmtBundle(o.get)}`);
    this.fb(o.from, `OK ${agent} accepted ${o.id}: you received ${fmtBundle(o.get)}, paid ${fmtBundle(o.give)}`);
    if (ta !== tb) {
      this.stats.get(ta)!.tradesCross++;
      this.stats.get(tb)!.tradesCross++;
      const big = bundleValue(o.give) >= this.rules.vp.tradeMinValue && bundleValue(o.get) >= this.rules.vp.tradeMinValue;
      let vpNote = "";
      if (big)
        for (const t of [ta, tb]) {
          const ts = this.team(t);
          if (ts.commerceTurn !== this.state.turn && ts.commerce < this.tradeCap(t)) {
            ts.commerce += this.rules.vp.tradePerTurn;
            ts.commerceTurn = this.state.turn;
            vpNote += ` ${ts.name} +${this.rules.vp.tradePerTurn} commerce VP.`;
          }
        }
      this.log(null, "trade", `Trade: ${o.from} gave ${fmtBundle(o.give)} to ${agent} for ${fmtBundle(o.get)}.${vpNote}`, { from: o.from, to: agent });
    }
  }

  private resolveGive(agent: string, p: ParsedOrder, fail: (a: string, p: ParsedOrder, why: string) => void) {
    const to = this.state.agents.get(p.args.to);
    if (!to) return fail(agent, p, `no agent "${p.args.to}"`);
    if (to.id === agent) return fail(agent, p, "cannot give to yourself");
    const b = p.args.bundle as Bundle;
    if (!this.canAfford(agent, b)) return fail(agent, p, `you lack ${this.missing(agent, b)}`);
    this.pay(agent, b);
    this.gain(to.id, b);
    const mine = this.state.agents.get(agent)!.team;
    if (mine === to.team) this.stats.get(mine)!.giftsTeamValue += bundleValue(b);
    else {
      this.stats.get(mine)!.giftsCrossValue += bundleValue(b);
      this.log(null, "gift", `${agent} gave ${fmtBundle(b)} to ${to.id}.`);
    }
    this.fb(agent, `OK gave ${fmtBundle(b)} to ${to.id}`);
    this.fb(to.id, `RECEIVED ${fmtBundle(b)} from ${agent}`);
  }

  private resolveExchange(agent: string, p: ParsedOrder, fail: (a: string, p: ParsedOrder, why: string) => void) {
    const team = this.state.agents.get(agent)!.team;
    const rate = this.bankRate(team);
    const n = Math.floor(p.args.n / rate) * rate;
    if (n <= 0) return fail(agent, p, `the bank rate is ${rate}:1`);
    const cost = { [p.args.res]: n } as Bundle;
    if (!this.canAfford(agent, cost)) return fail(agent, p, `you lack ${this.missing(agent, cost)}`);
    this.pay(agent, cost);
    this.gain(agent, { [p.args.want]: n / rate } as Bundle);
    this.stats.get(team)!.exchanges++;
    this.fb(agent, `OK exchanged ${n} ${p.args.res} for ${n / rate} ${p.args.want}`);
  }

  private resolveResearch(agent: string, p: ParsedOrder, fail: (a: string, p: ParsedOrder, why: string) => void) {
    const team = this.state.agents.get(agent)!.team;
    const why = this.techAvailable(team, p.args.tech);
    if (why) return fail(agent, p, why);
    const t = this.rules.techs[p.args.tech];
    if (!this.canAfford(agent, t.cost)) return fail(agent, p, `you lack ${this.missing(agent, t.cost)}`);
    this.pay(agent, t.cost, "tech");
    this.team(team).techs.push(p.args.tech);
    this.stats.get(team)!.techs.push(p.args.tech);
    this.log(null, "tech", `${this.team(team).name} discovered ${t.name}.`, { team, tech: p.args.tech });
    this.fb(agent, `OK researched ${t.name}`);
  }

  private resolveUpgrade(agent: string, p: ParsedOrder, fail: (a: string, p: ParsedOrder, why: string) => void) {
    const s = this.findSettlement(agent, p.args.at);
    if (typeof s === "string") return fail(agent, p, s);
    const cost = this.upgradeCost(s);
    if (!cost) return fail(agent, p, `${s.id} is already a city`);
    if (s.level === "town" && !this.hasTech(s.team, this.rules.settlement.cityRequires)) return fail(agent, p, `cities need ${this.rules.settlement.cityRequires}`);
    if (!this.canAfford(agent, cost)) return fail(agent, p, `you lack ${this.missing(agent, cost)}`);
    this.pay(agent, cost, "development");
    const before = this.settlementMaxHp(s);
    s.level = LEVELS[LEVELS.indexOf(s.level) + 1];
    s.hp += this.settlementMaxHp(s) - before;
    this.fb(agent, `OK ${s.id} is now a ${s.level}`);
    this.log(this.state.agents.get(agent)!.team, "upgrade", `${agent} upgraded ${s.name} (${s.id}) to a ${s.level}.`);
  }

  private resolveConstruct(agent: string, p: ParsedOrder, fail: (a: string, p: ParsedOrder, why: string) => void) {
    const s = this.findSettlement(agent, p.args.at);
    if (typeof s === "string") return fail(agent, p, s);
    const B = this.rules.buildings;
    if (p.args.what === "walls") {
      if (s.walls) return fail(agent, p, `${s.id} already has walls`);
      const cost = this.wallsCost(s.team);
      if (!this.canAfford(agent, cost)) return fail(agent, p, `you lack ${this.missing(agent, cost)}`);
      this.pay(agent, cost, "military");
      s.walls = true;
      s.hp += B.walls.hp;
      this.fb(agent, `OK walls built at ${s.id}`);
    } else if (p.args.what === "monument") {
      if (s.monument) return fail(agent, p, `${s.id} already has a monument`);
      if (!this.hasTech(s.team, B.monument.requires)) return fail(agent, p, `monuments need ${B.monument.requires}`);
      if (!this.canAfford(agent, B.monument.cost)) return fail(agent, p, `you lack ${this.missing(agent, B.monument.cost)}`);
      this.pay(agent, B.monument.cost, "development");
      s.monument = true;
      this.fb(agent, `OK monument built at ${s.id} (+${B.monument.vp} VP while you hold it)`);
      this.log(null, "monument", `${this.team(s.team).name} built a Monument in ${s.name} (${s.id}).`);
    } else {
      if (this.state.spireBuilt) return fail(agent, p, "the Shard Spire has already been built");
      if (!this.hasTech(s.team, B.spire.requires)) return fail(agent, p, `the Spire needs ${B.spire.requires}`);
      if (LEVELS.indexOf(s.level) < LEVELS.indexOf(B.spire.level)) return fail(agent, p, `the Spire must be built in a ${B.spire.level}`);
      if (!this.canAfford(agent, B.spire.cost)) return fail(agent, p, `you lack ${this.missing(agent, B.spire.cost)}`);
      this.pay(agent, B.spire.cost, "development");
      s.spire = true;
      this.state.spireBuilt = s.team;
      this.fb(agent, `OK the Shard Spire rises in ${s.id}`);
      this.log(null, "spire", `${this.team(s.team).name} completed the SHARD SPIRE in ${s.name} (${s.id})! (+${B.spire.vp} VP while held)`);
    }
  }

  private resolveBuild(agent: string, p: ParsedOrder, fail: (a: string, p: ParsedOrder, why: string) => void, builtAt: Set<string>) {
    const s = this.findSettlement(agent, p.args.at);
    if (typeof s === "string") return fail(agent, p, s);
    const type = p.args.type as UnitType;
    const req = this.rules.units[type].requires;
    if (req && !this.hasTech(s.team, req)) return fail(agent, p, `${type}s need ${req}`);
    if (builtAt.has(s.id)) return fail(agent, p, `${s.id} already builds a unit this turn (one per settlement per turn)`);
    const cost = this.unitCost(type, s.team);
    if (!this.canAfford(agent, cost)) return fail(agent, p, `you lack ${this.missing(agent, cost)}`);
    const here = this.unitsAt(s.pos).filter((u) => u.team === s.team).length;
    if (here >= this.rules.maxStack) return fail(agent, p, `${s.id} is full (max ${this.rules.maxStack} units per hex per team); move units out first`);
    this.pay(agent, cost, type === "settler" || type === "scout" ? "expansion" : "military");
    builtAt.add(s.id);
    this.stats.get(s.team)!.unitsBuilt[type]++;
    this.pendingSpawns.push({ owner: agent, type, settlement: s.id, cost });
    this.fb(agent, `OK building ${type} at ${s.id} (appears at end of turn)`);
  }

  private resolveOffer(agent: string, p: ParsedOrder, fail: (a: string, p: ParsedOrder, why: string) => void) {
    const to = this.state.agents.get(p.args.to);
    if (!to) return fail(agent, p, `no agent "${p.args.to}"`);
    if (to.id === agent) return fail(agent, p, "cannot trade with yourself");
    if (!this.canAfford(agent, p.args.give)) return fail(agent, p, `you lack ${this.missing(agent, p.args.give)}`);
    const o: Offer = { id: this.newId("t"), from: agent, to: to.id, give: p.args.give, get: p.args.get, turn: this.state.turn };
    this.state.offers.set(o.id, o);
    this.fb(agent, `OK offer ${o.id} sent to ${to.id}: your ${fmtBundle(o.give)} for their ${fmtBundle(o.get)} (open ${this.rules.offerTtl} turns)`);
    this.fb(to.id, `OFFER ${o.id} from ${agent}: they give ${fmtBundle(o.give)}, you give ${fmtBundle(o.get)}. Order "accept ${o.id}" to take it.`);
  }

  private resolveFound(agent: string, p: ParsedOrder, fail: (a: string, p: ParsedOrder, why: string) => void) {
    const u = this.findUnit(agent, p.args.unit);
    if (typeof u === "string") return fail(agent, p, u);
    if (u.type !== "settler") return fail(agent, p, `${u.id} is a ${u.type}, not a settler`);
    const t = this.tile(u.pos)!;
    if (!passableTerrain(t.terrain) || t.terrain === "ruins") return fail(agent, p, `cannot found on ${t.terrain}`);
    const near = [...this.state.settlements.values()].find((s) => dist(s.pos, u.pos) < this.rules.minSettlementDistance);
    if (near) return fail(agent, p, `too close to ${near.id} at ${fmt(near.pos)} (minimum distance ${this.rules.minSettlementDistance})`);
    const hostile = this.unitsAt(u.pos).some((x) => this.atWar(x.team, u.team));
    if (hostile) return fail(agent, p, "enemy units are on this hex");
    this.state.units.delete(u.id);
    const s = this.foundSettlement(agent, u.pos);
    this.fb(agent, `OK founded ${s.name} (${s.id}) at ${fmt(s.pos)}`);
    this.log(null, "found", `${agent} (${this.team(u.team).name}) founded ${s.name} (${s.id}) at ${fmt(s.pos)}.`, { team: u.team });
  }

  private passableFor(u: Unit) {
    return (h: Hex) => {
      const t = this.tile(h);
      if (!t || !passableTerrain(t.terrain)) return false;
      const s = this.settlementAt(h);
      // Foreign settlements you are not at war with are closed borders.
      if (s && s.team !== u.team && !this.atWar(s.team, u.team)) return false;
      return true;
    };
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
      // Path through anything passable; stopping on contact is handled step by step.
      const path = findPath(u.pos, u.dest, this.passableFor(u));
      if (!path) {
        this.fb(u.owner, `BLOCKED ${u.id} has no route to ${fmt(u.dest)}; order cleared`);
        u.dest = null;
        continue;
      }
      // Units already sharing a hex with an enemy stay engaged unless they move away.
      moving.set(u.id, { path, left: this.unitMove(u), engaged: false });
    }
    const maxSteps = Math.max(0, ...[...moving.values()].map((m) => m.left));
    for (let step = 0; step < maxSteps; step++) {
      const proposals = new Map<string, Hex>();
      for (const [id, m] of moving) if (!m.engaged && m.left > 0 && m.path.length) proposals.set(id, m.path[0]);
      // Swaps between enemies: only the stronger unit moves.
      for (const [id, to] of proposals) {
        const u = this.state.units.get(id)!;
        for (const [id2, to2] of proposals) {
          if (id2 <= id) continue;
          const v = this.state.units.get(id2)!;
          if (!this.atWar(u.team, v.team)) continue;
          if (key(to) === key(v.pos) && key(to2) === key(u.pos)) {
            const su = this.unitStr(u) + u.hp;
            const sv = this.unitStr(v) + v.hp;
            if (su >= sv) proposals.delete(id2);
            else proposals.delete(id);
          }
        }
      }
      for (const [id, to] of this.shuffled([...proposals.entries()])) {
        const u = this.state.units.get(id)!;
        const m = moving.get(id)!;
        const friendly = this.unitsAt(to).filter((x) => x.team === u.team).length;
        if (friendly >= this.rules.maxStack) {
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
      const hostile = tl.some((a) => tl.some((b) => this.atWar(a, b)));
      if (!hostile) continue;
      this.combatHexes.add(k);
      const terrain = this.tile(h)!.terrain;
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
        return { us, normal, siege, total: normal + siege };
      };
      const sides = new Map(tl.map((t) => [t, side(t)]));
      const damage = new Map<string, { normal: number; siege: number }>(tl.map((t) => [t, { normal: 0, siege: 0 }]));
      for (const t of tl) {
        const enemies = tl.filter((o) => this.atWar(t, o));
        if (!enemies.length) continue;
        const target = enemies.sort((a, b) => sides.get(b)!.total - sides.get(a)!.total)[0];
        const d = damage.get(target)!;
        d.normal += sides.get(t)!.normal;
        d.siege += sides.get(t)!.siege;
      }
      const report: string[] = [];
      for (const t of tl) {
        const d = damage.get(t)!;
        const sd = sides.get(t)!;
        let normal = d.normal;
        let siege = d.siege;
        const siegeVsSettlement = settlement && settlement.team === t ? siege * (this.rules.units.catapult.siege ?? 1) : 0;
        if (siegeVsSettlement) siege = 0;
        let pool = normal + siege;
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
            report.push(`${u.owner}'s ${u.type} ${u.id} was destroyed`);
            this.fb(u.owner, `LOST ${u.type} ${u.id} at ${fmt(h)}`);
          }
        }
        if (settlement && settlement.team === t) {
          const toSettlement = pool + siegeVsSettlement;
          if (toSettlement > 0) {
            settlement.hp = Math.max(0, settlement.hp - toSettlement);
            report.push(`${settlement.name} (${settlement.id}) took ${toSettlement} damage (HP ${settlement.hp}/${this.settlementMaxHp(settlement)})`);
          }
          settlement.attackedThisTurn = true;
        }
      }
      // Kill credit: count enemy losses per team.
      const losses = new Map<string, number>();
      for (const t of tl) losses.set(t, sides.get(t)!.us.filter((u) => !this.state.units.has(u.id)).length);
      for (const t of tl) {
        const enemyLoss = tl.filter((o) => this.atWar(t, o)).reduce((a, o) => a + (losses.get(o) ?? 0), 0);
        this.stats.get(t)!.unitsKilled += enemyLoss;
      }
      const names = tl.map((t) => this.team(t).name).join(" vs ");
      this.log(null, "combat", `Battle at ${fmt(h)} (${names}): ${report.join("; ") || "no losses"}.`, { hex: k, teams: tl });
      // Capture.
      if (settlement && settlement.hp <= 0) {
        const defenders = this.unitsAt(h).filter((u) => u.team === settlement.team);
        const attackers = this.unitsAt(h).filter((u) => this.atWar(u.team, settlement.team) && this.unitStr(u) > 0);
        if (!defenders.length && attackers.length) {
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
          // Pending builds there are refunded by the spawn step.
          for (const u of this.unitsAt(h)) if (u.team === oldTeam) this.state.units.delete(u.id);
          this.log(null, "capture", `${captor} (${this.team(ct).name}) CAPTURED ${settlement.name} (${settlement.id}) from ${oldOwner}! +${this.rules.vp.capture} glory VP.`, { team: ct, from: oldTeam });
          this.fb(oldOwner, `LOST settlement ${settlement.id} ${settlement.name} to ${captor}`);
          this.fb(captor, `CAPTURED ${settlement.id} ${settlement.name}`);
        }
      }
    }
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
      this.fb(u.owner, `RUINS explored by ${u.id} at ${fmt(t)}: found ${fmtBundle(loot)} (+${L.vp} glory VP)`);
      this.log(null, "ruins", `${u.owner} (${this.team(u.team).name}) explored ruins at ${fmt(t)}.`);
    }
  }

  private resolveEconomy() {
    // Tiles with enemy units on them are blockaded and produce nothing for their owner.
    const blockade = new Map<string, Set<string>>(); // settlement id -> blocked tile keys
    for (const s of this.state.settlements.values()) {
      const b = new Set<string>();
      for (const k of s.claims) if (this.unitsAt(parseHex(k)).some((u) => this.atWar(u.team, s.team))) b.add(k);
      blockade.set(s.id, b);
    }
    for (const s of this.state.settlements.values()) {
      if (s.attackedThisTurn) {
        this.fb(s.owner, `BESIEGED ${s.id} produced nothing this turn`);
        continue;
      }
      const y = this.settlementYield(s, blockade.get(s.id));
      this.gain(s.owner, y);
      if (blockade.get(s.id)!.size) this.fb(s.owner, `RAIDED ${s.id}: ${blockade.get(s.id)!.size} tile(s) occupied by enemies produced nothing`);
    }
    for (const a of this.state.agents.values()) {
      const units = this.unitsOf(a.id);
      const upkeep = units.length * this.rules.upkeepPerUnit;
      a.stock.food -= upkeep;
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
    for (const s of this.state.settlements.values())
      if (!s.attackedThisTurn) s.hp = Math.min(this.settlementMaxHp(s), s.hp + this.rules.settlement.regen);
  }

  // ---------- snapshots for logs / UI ----------

  snapshot() {
    const sc = this.scores();
    return {
      turn: this.state.turn,
      over: this.state.over,
      winner: this.state.winner,
      stances: Object.fromEntries(this.state.stances),
      teams: this.state.teams.map((t) => ({ id: t.id, name: t.name, agents: t.agents, techs: [...t.techs], vp: sc.get(t.id)!, alive: this.teamAlive(t.id), seat: this.seat.get(t.id) })),
      agents: [...this.state.agents.values()].map((a) => ({ id: a.id, team: a.team, stock: { ...a.stock } })),
      units: [...this.state.units.values()].map((u) => ({ ...u, pos: { ...u.pos }, dest: u.dest ? { ...u.dest } : null, maxHp: this.unitMaxHp(u.type, u.team) })),
      settlements: [...this.state.settlements.values()].map((s) => ({ ...s, pos: { ...s.pos }, claims: [...s.claims], maxHp: this.settlementMaxHp(s) })),
      tiles: [...this.state.tiles.values()].map((t) => ({ q: t.q, r: t.r, t: t.terrain })),
      offers: [...this.state.offers.values()],
      visible: Object.fromEntries(this.state.teams.map((t) => [t.id, [...this.visibleTo(t.id)]])),
    };
  }
}

export type Snapshot = ReturnType<Engine["snapshot"]>;

export function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
export function parseHex(k: string): Hex {
  const [q, r] = k.split(",").map(Number);
  return { q, r };
}
function singular(s = "") {
  return s.replace(/s$/, "");
}
function normRes(s = ""): Resource | null {
  const x = s.replace(/s$/, "");
  return (RESOURCES as readonly string[]).includes(x) ? (x as Resource) : null;
}
/** Parses "3 wood 2 ore" / "3 wood and 2 ore". */
export function parseBundle(tok: string[]): Bundle | string {
  const b: Bundle = {};
  const t = tok.filter((x) => x !== "and" && x !== "&" && x !== "+");
  if (!t.length) return "missing resources (e.g. 3 wood 2 ore)";
  for (let i = 0; i < t.length; i += 2) {
    const n = Number(t[i]);
    const r = normRes(t[i + 1]);
    if (!Number.isInteger(n) || n <= 0 || !r) return `could not read "${t.slice(i, i + 2).join(" ")}" (write amounts like: 3 wood 2 ore)`;
    b[r] = (b[r] ?? 0) + n;
  }
  return b;
}
