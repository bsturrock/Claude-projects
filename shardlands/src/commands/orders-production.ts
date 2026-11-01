import { LEVELS, UNIT_TYPES, type UnitType } from "../config.js";
import type { Engine } from "../engine.js";
import type { Settlement } from "../types.js";
import type { OrderDef, Preview } from "./types.js";
import { noFiller } from "./types.js";

const settlementCheck = (eng: Engine, agent: string, ref: string): Settlement | Preview => {
  const s = eng.findSettlement(agent, ref);
  return typeof s === "string" ? { error: s } : s;
};
const isSettlement = (x: Settlement | Preview): x is Settlement => "pos" in x;

export const build: OrderDef<{ type: UnitType; at: string }> = {
  name: "build",
  aliases: ["train"],
  usage: "build <unit-type> <settlement>",
  summary: `Train a unit (${UNIT_TYPES.join(", ")}) at one of your settlements. One per settlement per turn.`,
  step: "economy",
  parse(tok) {
    const t = noFiller(tok);
    const type = (t[0] ?? "").replace(/s$/, "") as UnitType;
    if (!UNIT_TYPES.includes(type)) return `unknown unit type "${t[0] ?? ""}" (types: ${UNIT_TYPES.join(", ")})`;
    if (!t[1]) return "usage: build <unit-type> <settlement>";
    return { type, at: t[1] };
  },
  preview(eng, agent, a) {
    const s = settlementCheck(eng, agent, a.at);
    if (!isSettlement(s)) return s;
    const req = eng.rules.units[a.type].requires;
    if (req && !eng.hasTech(s.team, req)) return { error: `${a.type}s need ${req}` };
    return { cost: eng.unitCost(a.type, s.team) };
  },
  describe: (a) => `build ${a.type} at ${a.at}`,
  resolve(eng, agent, a, raw, ctx) {
    const s = eng.findSettlement(agent, a.at);
    if (typeof s === "string") return ctx.fail(agent, raw, s);
    const req = eng.rules.units[a.type].requires;
    if (req && !eng.hasTech(s.team, req)) return ctx.fail(agent, raw, `${a.type}s need ${req}`);
    if (ctx.builtAt.has(s.id)) return ctx.fail(agent, raw, `${s.id} already builds a unit this turn (one per settlement per turn)`);
    const cost = eng.unitCost(a.type, s.team);
    if (!eng.canAfford(agent, cost)) return ctx.fail(agent, raw, `you lack ${eng.missing(agent, cost)}`);
    const here = eng.unitsAt(s.pos).filter((u) => u.team === s.team).length;
    if (here >= eng.rules.maxStack) return ctx.fail(agent, raw, `${s.id} is full (max ${eng.rules.maxStack} units per hex per team); move units out first`);
    eng.pay(agent, cost, a.type === "settler" || a.type === "scout" ? "expansion" : "military");
    ctx.builtAt.add(s.id);
    eng.stats.get(s.team)!.unitsBuilt[a.type]++;
    eng.pendingSpawns.push({ owner: agent, type: a.type, settlement: s.id, cost });
    eng.fb(agent, `OK building ${a.type} at ${s.id} (appears at end of turn)`);
  },
};

export const upgrade: OrderDef<{ at: string }> = {
  name: "upgrade",
  usage: "upgrade <settlement>",
  summary: "Village -> town -> city. Each level adds +1 food/wood/ore per producing tile and more VP.",
  step: "economy",
  parse: (tok) => (noFiller(tok)[0] ? { at: noFiller(tok)[0] } : "usage: upgrade <settlement>"),
  preview(eng, agent, a) {
    const s = settlementCheck(eng, agent, a.at);
    if (!isSettlement(s)) return s;
    const cost = eng.upgradeCost(s);
    if (!cost) return { error: `${s.id} is already a city` };
    if (s.level === "town" && !eng.hasTech(s.team, eng.rules.settlement.cityRequires)) return { error: `cities need ${eng.rules.settlement.cityRequires}` };
    return { cost };
  },
  describe: (a) => `upgrade ${a.at}`,
  resolve(eng, agent, a, raw, ctx) {
    const s = eng.findSettlement(agent, a.at);
    if (typeof s === "string") return ctx.fail(agent, raw, s);
    const cost = eng.upgradeCost(s);
    if (!cost) return ctx.fail(agent, raw, `${s.id} is already a city`);
    if (s.level === "town" && !eng.hasTech(s.team, eng.rules.settlement.cityRequires)) return ctx.fail(agent, raw, `cities need ${eng.rules.settlement.cityRequires}`);
    if (!eng.canAfford(agent, cost)) return ctx.fail(agent, raw, `you lack ${eng.missing(agent, cost)}`);
    eng.pay(agent, cost, "development");
    const before = eng.settlementMaxHp(s);
    s.level = LEVELS[LEVELS.indexOf(s.level) + 1];
    s.hp += eng.settlementMaxHp(s) - before;
    eng.fb(agent, `OK ${s.id} is now a ${s.level}`);
    eng.log(s.team, "upgrade", `${agent} upgraded ${s.name} (${s.id}) to a ${s.level}.`);
  },
};

/**
 * Buildings. Each entry is one thing `construct` can build; add a new building here
 * (plus its numbers in config.ts and its effect wherever it applies) to extend the game.
 */
interface BuildingDef {
  check(eng: Engine, s: Settlement): string | null;
  cost(eng: Engine, s: Settlement): import("../config.js").Bundle;
  category: "military" | "development";
  apply(eng: Engine, agent: string, s: Settlement): void;
}

export const BUILDINGS: Record<string, BuildingDef> = {
  walls: {
    check: (_e, s) => (s.walls ? `${s.id} already has walls` : null),
    cost: (e, s) => e.wallsCost(s.team),
    category: "military",
    apply(e, agent, s) {
      s.walls = true;
      s.hp += e.rules.buildings.walls.hp;
      e.fb(agent, `OK walls built at ${s.id}`);
    },
  },
  monument: {
    check: (e, s) => (s.monument ? `${s.id} already has a monument` : !e.hasTech(s.team, e.rules.buildings.monument.requires) ? `monuments need ${e.rules.buildings.monument.requires}` : null),
    cost: (e) => e.rules.buildings.monument.cost,
    category: "development",
    apply(e, agent, s) {
      s.monument = true;
      e.fb(agent, `OK monument built at ${s.id} (+${e.rules.buildings.monument.vp} VP while you hold it)`);
      e.log(null, "monument", `${e.team(s.team).name} built a Monument in ${s.name} (${s.id}).`);
    },
  },
  spire: {
    check(e, s) {
      const B = e.rules.buildings.spire;
      if (e.state.spireBuilt) return "the Shard Spire has already been built";
      if (!e.hasTech(s.team, B.requires)) return `the Spire needs ${B.requires}`;
      if (LEVELS.indexOf(s.level) < LEVELS.indexOf(B.level)) return `the Spire must be built in a ${B.level}`;
      return null;
    },
    cost: (e) => e.rules.buildings.spire.cost,
    category: "development",
    apply(e, agent, s) {
      s.spire = true;
      e.state.spireBuilt = s.team;
      e.fb(agent, `OK the Shard Spire rises in ${s.id}`);
      e.log(null, "spire", `${e.team(s.team).name} completed the SHARD SPIRE in ${s.name} (${s.id})! (+${e.rules.buildings.spire.vp} VP while held)`);
    },
  },
};

export const construct: OrderDef<{ what: string; at: string }> = {
  name: "construct",
  usage: `construct ${Object.keys(BUILDINGS).join("|")} <settlement>`,
  summary: "Build a building in one of your settlements.",
  step: "economy",
  parse(tok) {
    const t = noFiller(tok);
    const what = t[0] === "wall" ? "walls" : t[0];
    if (!BUILDINGS[what]) return `usage: construct ${Object.keys(BUILDINGS).join("|")} <settlement>`;
    if (!t[1]) return `usage: construct ${what} <settlement>`;
    return { what, at: t[1] };
  },
  preview(eng, agent, a) {
    const s = settlementCheck(eng, agent, a.at);
    if (!isSettlement(s)) return s;
    const B = BUILDINGS[a.what];
    const why = B.check(eng, s);
    return why ? { error: why } : { cost: B.cost(eng, s) };
  },
  describe: (a) => `construct ${a.what} at ${a.at}`,
  resolve(eng, agent, a, raw, ctx) {
    const s = eng.findSettlement(agent, a.at);
    if (typeof s === "string") return ctx.fail(agent, raw, s);
    const B = BUILDINGS[a.what];
    const why = B.check(eng, s);
    if (why) return ctx.fail(agent, raw, why);
    const cost = B.cost(eng, s);
    if (!eng.canAfford(agent, cost)) return ctx.fail(agent, raw, `you lack ${eng.missing(agent, cost)}`);
    eng.pay(agent, cost, B.category);
    B.apply(eng, agent, s);
  },
};
