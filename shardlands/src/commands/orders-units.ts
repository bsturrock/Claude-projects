import { dist, findPath, fmt, type Hex } from "../hex.js";
import { passableTerrain } from "../map.js";
import type { OrderDef } from "./types.js";
import { noFiller, parseCoord } from "./types.js";

export const move: OrderDef<{ unit: string; to: Hex }> = {
  name: "move",
  aliases: ["goto"],
  usage: "move <unit> <q>,<r>",
  summary: "Standing order: the unit walks toward the hex every turn until it arrives.",
  help: "The unit takes the shortest path and uses its full move each turn. It stops early if it enters a hex with units or a settlement of a team you are at war with. Use `shard path <unit> <q>,<r>` to preview the route.",
  step: "movement",
  parse(tok) {
    const t = noFiller(tok);
    const to = parseCoord(t.slice(1));
    if (!t[0] || !to) return "usage: move <unit> <q>,<r>";
    return { unit: t[0], to };
  },
  preview(eng, agent, a) {
    const u = eng.findUnit(agent, a.unit);
    if (typeof u === "string") return { error: u };
    const t = eng.tile(a.to);
    if (!t) return { error: `${fmt(a.to)} is off the map` };
    if (!passableTerrain(t.terrain)) return { error: `${fmt(a.to)} is ${t.terrain} (impassable)` };
    const path = findPath(u.pos, a.to, eng.passableFor(u));
    if (!path) return { error: `no route from ${fmt(u.pos)} to ${fmt(a.to)} (blocked by terrain or closed borders)` };
    const turns = Math.ceil(path.length / eng.unitMove(u));
    return { note: `${path.length} steps, about ${turns} turn${turns === 1 ? "" : "s"}` };
  },
  describe: (a) => `move ${a.unit} to ${fmt(a.to)}`,
  resolve(eng, agent, a, raw, ctx) {
    const u = eng.findUnit(agent, a.unit);
    if (typeof u === "string") return ctx.fail(agent, raw, u);
    const t = eng.tile(a.to);
    if (!t) return ctx.fail(agent, raw, `${fmt(a.to)} is off the map`);
    if (!passableTerrain(t.terrain)) return ctx.fail(agent, raw, `${fmt(a.to)} is ${t.terrain} (impassable)`);
    u.dest = { ...a.to };
  },
};

export const stop: OrderDef<{ unit: string }> = {
  name: "stop",
  aliases: ["hold"],
  usage: "stop <unit>",
  summary: "Cancel a unit's standing move order; it holds its position.",
  step: "movement",
  parse: (tok) => (tok[0] ? { unit: tok[0] } : "usage: stop <unit>"),
  preview(eng, agent, a) {
    const u = eng.findUnit(agent, a.unit);
    return typeof u === "string" ? { error: u } : {};
  },
  describe: (a) => `stop ${a.unit}`,
  resolve(eng, agent, a, raw, ctx) {
    const u = eng.findUnit(agent, a.unit);
    if (typeof u === "string") return ctx.fail(agent, raw, u);
    u.dest = null;
    eng.fb(agent, `OK ${u.id} holds position`);
  },
};

export const found: OrderDef<{ unit: string }> = {
  name: "found",
  aliases: ["settle"],
  usage: "found <settler>",
  summary: "The settler founds a village on the hex it stands on (before it moves this turn).",
  help: "Must be at least the minimum distance from every settlement, on passable land, not on unexplored ruins, and with no enemy units present. Use `shard sites <settler>` to find good legal spots.",
  step: "found",
  parse: (tok) => (tok[0] ? { unit: tok[0] } : "usage: found <settler>"),
  preview(eng, agent, a) {
    const u = eng.findUnit(agent, a.unit);
    if (typeof u === "string") return { error: u };
    if (u.type !== "settler") return { error: `${u.id} is a ${u.type}, not a settler` };
    const why = foundProblem(eng, u.pos, u.team, true);
    return why ? { error: why } : {};
  },
  describe: (a) => `found a village with ${a.unit}`,
  resolve(eng, agent, a, raw, ctx) {
    const u = eng.findUnit(agent, a.unit);
    if (typeof u === "string") return ctx.fail(agent, raw, u);
    if (u.type !== "settler") return ctx.fail(agent, raw, `${u.id} is a ${u.type}, not a settler`);
    const why = foundProblem(eng, u.pos, u.team, false);
    if (why) return ctx.fail(agent, raw, why);
    eng.state.units.delete(u.id);
    const s = eng.foundSettlement(agent, u.pos);
    eng.fb(agent, `OK founded ${s.name} (${s.id}) at ${fmt(s.pos)}`);
    eng.log(null, "found", `${agent} (${eng.team(u.team).name}) founded ${s.name} (${s.id}) at ${fmt(s.pos)}.`, { team: u.team });
  },
};

/** Why a village cannot be founded here. With `known`, only settlements the team has seen count. */
function foundProblem(eng: import("../engine.js").Engine, pos: Hex, team: string, known: boolean): string | null {
  const t = eng.tile(pos)!;
  if (!passableTerrain(t.terrain) || t.terrain === "ruins") return `cannot found on ${t.terrain}`;
  const T = eng.team(team);
  const near = [...eng.state.settlements.values()].find(
    (s) => dist(s.pos, pos) < eng.rules.minSettlementDistance && (!known || s.team === team || T.explored.has(`${s.pos.q},${s.pos.r}`)),
  );
  if (near) return `too close to ${near.id} at ${fmt(near.pos)} (minimum distance ${eng.rules.minSettlementDistance})`;
  if (eng.unitsAt(pos).some((x) => eng.atWar(x.team, team))) return "enemy units are on this hex";
  return null;
}

export const disband: OrderDef<{ unit: string }> = {
  name: "disband",
  usage: "disband <unit>",
  summary: "Remove one of your units (saves its food upkeep).",
  step: "economy",
  parse: (tok) => (tok[0] ? { unit: tok[0] } : "usage: disband <unit>"),
  preview(eng, agent, a) {
    const u = eng.findUnit(agent, a.unit);
    return typeof u === "string" ? { error: u } : {};
  },
  describe: (a) => `disband ${a.unit}`,
  resolve(eng, agent, a, raw, ctx) {
    const u = eng.findUnit(agent, a.unit);
    if (typeof u === "string") return ctx.fail(agent, raw, u);
    eng.state.units.delete(u.id);
    eng.fb(agent, `OK disbanded ${u.id}`);
  },
};
