import { RESOURCES, UNIT_TYPES, type Resource } from "./config.js";
import { fmtBundle } from "./bundle.js";
import type { Engine } from "./engine.js";
import { type Hex, dist, fmt, inRange, key } from "./hex.js";
import { passableTerrain } from "./map.js";
import type { GameEvent, Message } from "./types.js";

const LETTER: Record<string, string> = { plains: "P", forest: "F", hills: "H", mountain: "M", water: "W", crystal: "C", ruins: "R", heart: "*" };

export interface ObsContext {
  phase: "council" | "orders";
  feedback: string[];
  events: GameEvent[];
  messages: Message[];
  notes: string;
}

export function channelLabel(ch: string): string {
  return ch === "public" ? "public" : "team";
}

/**
 * Everything one agent knows, as text, split into named sections. `shard status` prints the
 * full briefing; other commands print single sections. Only information the agent's team can
 * legitimately see is included.
 */
export const SECTIONS = ["overview", "empire", "team", "results", "events", "messages", "map", "enemy", "sites", "notes"] as const;
export type Section = (typeof SECTIONS)[number];

export function observe(eng: Engine, agentId: string, ctx: ObsContext, only?: Section[]): string {
  const out: string[] = [];
  for (const s of only ?? SECTIONS) {
    const lines = section(eng, agentId, ctx, s);
    if (lines.length) out.push(lines.join("\n"));
  }
  return out.join("\n\n");
}

function section(eng: Engine, agentId: string, ctx: ObsContext, s: Section, mapOpts?: { center?: Hex; radius?: number }): string[] {
  const S = eng.state;
  const R = eng.rules;
  const me = S.agents.get(agentId)!;
  const team = eng.team(me.team);
  const enemy = eng.opponentOf(team.id);
  const L: string[] = [];
  const P = (x = "") => L.push(x);
  switch (s) {
    case "overview": {
      P(`=== TURN ${S.turn} of ${R.turns}: ${ctx.phase.toUpperCase()} PHASE ===`);
      P(`You are ${agentId} of team ${team.name} (id "${team.id}"). Teammates: ${team.agents.filter((a) => a !== agentId).join(", ")}.`);
      P(`Opponent: ${enemy.name} (id "${enemy.id}", agents ${enemy.agents.join(", ")}).`);
      P(eng.fighting ? `STATUS: AT WAR. Units that meet enemy units or settlements fight.` : `STATUS: TRUCE until the end of turn ${R.truceTurns}. No combat yet; enemy settlements cannot be entered.`);
      const sc = eng.scores();
      P(`Scores (first to ${R.vpTarget} VP wins, or most VP after turn ${R.turns}; eliminating the enemy wins at once):`);
      for (const t of S.teams) {
        const b = sc.get(t.id)!;
        P(`  ${t.name}${t.id === team.id ? " (you)" : ""}: ${b.total} VP [settlements ${b.settlements}, monuments ${b.monuments}, spire ${b.spire}, tech ${b.tech}, glory ${b.glory}, heart ${b.heart}]; techs: ${t.techs.join(", ") || "none"}; settlements: ${eng.teamSettlements(t.id).length}`);
      }
      if (S.spireBuilt) P(`The Shard Spire has been built by ${eng.team(S.spireBuilt).name}.`);
      const avail = Object.keys(R.techs).filter((t) => !eng.techAvailable(team.id, t));
      P(`Researchable now: ${avail.map((t) => `${t} (${fmtBundle(R.techs[t].cost)})`).join("; ") || "none"}`);
      break;
    }
    case "empire": {
      const income: Record<Resource, number> = { food: 0, wood: 0, ore: 0, crystal: 0 };
      for (const st of eng.settlementsOf(agentId)) {
        const y = eng.settlementYield(st);
        for (const r of RESOURCES) income[r] += y[r];
      }
      const myUnits = eng.unitsOf(agentId);
      P(`YOUR STOCK: ${RESOURCES.map((r) => `${r} ${me.stock[r]}`).join(", ")}`);
      P(`Expected income: ${RESOURCES.map((r) => `+${income[r]} ${r}`).join(", ")}; unit upkeep -${myUnits.length * R.upkeepPerUnit} food.`);
      P(`YOUR SETTLEMENTS:`);
      for (const st of eng.settlementsOf(agentId)) P("  " + describeSettlement(eng, st.id, true));
      if (!eng.settlementsOf(agentId).length) P("  none");
      P(`YOUR UNITS (you can only command these, and your own settlements):`);
      for (const u of myUnits) P("  " + describeUnit(eng, u.id));
      if (!myUnits.length) P("  none");
      P(`Unit costs: ${UNIT_TYPES.map((t) => `${t} ${fmtBundle(eng.unitCost(t, team.id))}`).join("; ")}. Walls ${fmtBundle(eng.wallsCost(team.id))}. Bank rate ${eng.bankRate(team.id)}:1.`);
      break;
    }
    case "team": {
      P(`TEAMMATES (each commands their own units and settlements):`);
      for (const a of team.agents.filter((x) => x !== agentId)) {
        const st = S.agents.get(a)!;
        P(`  ${a}: stock ${RESOURCES.map((r) => `${r} ${st.stock[r]}`).join(", ")}`);
        for (const x of eng.settlementsOf(a)) P("    " + describeSettlement(eng, x.id, false));
        for (const u of eng.unitsOf(a)) P("    " + describeUnit(eng, u.id));
      }
      break;
    }
    case "results":
      if (ctx.feedback.length) {
        P(`RESULTS OF YOUR LAST ORDERS:`);
        for (const f of ctx.feedback) P(`  ${f}`);
      }
      break;
    case "events": {
      const evs = ctx.events.filter((e) => e.vis === null || e.vis === team.id);
      if (evs.length) {
        P(`EVENTS SINCE YOUR LAST DECISION:`);
        for (const e of evs) P(`  [t${e.turn}] ${e.text}`);
      }
      break;
    }
    case "messages":
      if (ctx.messages.length) {
        P(`MESSAGES SINCE YOUR LAST DECISION:`);
        for (const m of ctx.messages) P(`  [t${m.turn} ${m.phase} | ${channelLabel(m.channel)}] ${m.from}: ${m.text}`);
      }
      break;
    case "map":
      L.push(...mapLines(eng, agentId, mapOpts?.center, mapOpts?.radius));
      break;
    case "enemy": {
      const vis = eng.visibleTo(team.id);
      const foreignS = [...S.settlements.values()].filter((x) => x.team !== team.id && vis.has(key(x.pos)));
      const foreignU = [...S.units.values()].filter((u) => u.team !== team.id && vis.has(key(u.pos)));
      P(`ENEMY SETTLEMENTS IN SIGHT:`);
      for (const x of foreignS) P("  " + describeSettlement(eng, x.id, false));
      if (!foreignS.length) P("  none");
      const remembered = [...team.memory.entries()].filter(([k, v]) => !vis.has(k) && !team.agents.some((a) => v.endsWith(` of ${a}`)));
      if (remembered.length) P(`  last seen (not in sight now): ${remembered.map(([k, v]) => `${v} at (${k})`).join("; ")}`);
      P(`ENEMY UNITS IN SIGHT:`);
      if (!foreignU.length) P("  none");
      const byHex = new Map<string, string[]>();
      for (const u of foreignU) byHex.set(key(u.pos), [...(byHex.get(key(u.pos)) ?? []), `${u.id} ${u.type} of ${u.owner} (HP ${u.hp}, str ${eng.unitStr(u)})`]);
      for (const [k, list] of byHex) P(`  (${k}): ${list.join(", ")}`);
      const ruins = [...S.tiles.values()].filter((t) => t.terrain === "ruins" && team.explored.has(key(t)));
      if (ruins.length) P(`UNEXPLORED RUINS YOU KNOW OF: ${ruins.map((t) => fmt(t)).join(" ")}`);
      break;
    }
    case "sites": {
      const settlers = eng.unitsOf(agentId).filter((u) => u.type === "settler");
      if (!settlers.length) break;
      P(`GOOD FOUNDING SITES NEAR YOUR SETTLERS (legal as far as your team knows; yield = per turn as a village):`);
      for (const u of settlers) {
        const sites = foundingSites(eng, team.id, u.pos).slice(0, 5);
        P(`  ${u.id} at ${fmt(u.pos)}: ${sites.map((x) => `${fmt(x.hex)} d${x.d} [${x.text}]`).join("; ") || "no legal sites known within 6 hexes"}`);
      }
      break;
    }
    case "notes":
      if (ctx.notes) {
        P(`YOUR NOTES (from your last decision):`);
        P(ctx.notes);
      }
      break;
  }
  return L;
}

/** The known-terrain map, optionally limited to a window around a hex. */
export function mapLines(eng: Engine, agentId: string, center?: Hex, radius?: number): string[] {
  const S = eng.state;
  const team = eng.teamOf(agentId);
  const vis = eng.visibleTo(team.id);
  const L: string[] = [];
  L.push(`MAP (known tiles). Each cell is terrain + marker, listed by row r from q=min to q=max.`);
  L.push(`Terrain: P plains, F forest, H hills, M mountain, W water, C crystal, R ruins, * Heart, ?? unexplored.`);
  L.push(`Marker: . nothing | S your settlement | T teammate settlement | E enemy settlement | m your unit(s) | t teammate unit(s) | x enemy unit(s) | + your team's territory | - enemy territory. Lowercase terrain = explored but not visible now.`);
  const Rr = eng.rules.mapRadius;
  for (let r = -Rr; r <= Rr; r++) {
    let q0 = Math.max(-Rr, -r - Rr);
    let q1 = Math.min(Rr, -r + Rr);
    if (center && radius !== undefined) {
      if (Math.abs(r - center.r) > radius) continue;
      q0 = Math.max(q0, center.q - radius - Math.min(0, r - center.r));
      q1 = Math.min(q1, center.q + radius - Math.max(0, r - center.r));
      if (q0 > q1) continue;
    }
    const cells: string[] = [];
    for (let q = q0; q <= q1; q++) {
      const k = `${q},${r}`;
      if (!team.explored.has(k)) {
        cells.push("??");
        continue;
      }
      const t = S.tiles.get(k)!;
      const seen = vis.has(k);
      const terr = seen ? LETTER[t.terrain] : LETTER[t.terrain].toLowerCase();
      let mark = ".";
      const h = { q, r };
      const st = seen ? eng.settlementAt(h) : undefined;
      const units = seen ? eng.unitsAt(h) : [];
      if (st) mark = st.owner === agentId ? "S" : st.team === team.id ? "T" : "E";
      else if (!seen && team.memory.has(k)) mark = team.memory.get(k)!.endsWith(` of ${agentId}`) ? "S" : team.agents.some((a) => team.memory.get(k)!.endsWith(` of ${a}`)) ? "T" : "E";
      else if (units.some((u) => u.team !== team.id)) mark = "x";
      else if (units.some((u) => u.owner === agentId)) mark = "m";
      else if (units.length) mark = "t";
      else if (seen) {
        const c = eng.claimOwner(k);
        if (c) mark = c.team === team.id ? "+" : "-";
      }
      cells.push(terr + mark);
    }
    L.push(`r=${String(r).padStart(2)} q=${String(q0).padStart(2)}..${String(q1).padStart(2)}: ${cells.join(" ")}`);
  }
  return L;
}

export function sectionText(eng: Engine, agentId: string, ctx: ObsContext, s: Section, mapOpts?: { center?: Hex; radius?: number }): string {
  return section(eng, agentId, ctx, s, mapOpts).join("\n");
}

export function describeSettlement(eng: Engine, id: string, own: boolean): string {
  const s = eng.state.settlements.get(id)!;
  const y = eng.settlementYield(s);
  const yt = RESOURCES.filter((r) => y[r]).map((r) => `${y[r]} ${r}`).join(" ");
  const extras = [s.walls && "walls", s.monument && "monument", s.spire && "SPIRE"].filter(Boolean).join(", ");
  let line = `${s.id} ${s.name} (${s.owner}) ${s.level} at ${fmt(s.pos)} HP ${s.hp}/${eng.settlementMaxHp(s)} def ${eng.settlementDefense(s)}${extras ? ` [${extras}]` : ""} yields ${yt || "nothing"}/turn`;
  if (own) {
    const up = eng.upgradeCost(s);
    if (up) line += `; upgrade: ${fmtBundle(up)}${s.level === "town" ? ` (needs ${eng.rules.settlement.cityRequires})` : ""}`;
  }
  return line;
}

export function describeUnit(eng: Engine, id: string): string {
  const u = eng.state.units.get(id)!;
  return `${u.id} ${u.type} at ${fmt(u.pos)} HP ${u.hp}/${eng.unitMaxHp(u.type, u.team)} str ${eng.unitStr(u)} move ${eng.unitMove(u)}${u.dest ? ` -> moving to ${fmt(u.dest)}` : " (idle)"}`;
}

export function foundingSites(eng: Engine, team: string, from: Hex, range = 6): { hex: Hex; d: number; text: string; value: number }[] {
  const T = eng.team(team);
  const known = [...eng.state.settlements.values()].filter((s) => T.explored.has(key(s.pos)) || s.team === team);
  const out: { hex: Hex; d: number; text: string; value: number }[] = [];
  for (const h of inRange(from, range)) {
    const k = key(h);
    const t = eng.state.tiles.get(k);
    if (!t || !T.explored.has(k) || !passableTerrain(t.terrain) || t.terrain === "ruins") continue;
    if (known.some((s) => dist(s.pos, h) < eng.rules.minSettlementDistance)) continue;
    const y: Record<string, number> = {};
    let value = 0;
    for (const n of inRange(h, 1)) {
      const nk = key(n);
      const nt = eng.state.tiles.get(nk);
      if (!nt || !T.explored.has(nk) || eng.claimOwner(nk)) continue;
      for (const [r, v] of Object.entries(eng.rules.yields[nt.terrain] ?? {})) {
        y[r] = (y[r] ?? 0) + v!;
        value += r === "crystal" ? v! * 3 : v!;
      }
    }
    const d = dist(from, h);
    out.push({ hex: h, d, value: value - d * 0.8, text: Object.entries(y).map(([r, v]) => `${v} ${r}`).join(" ") });
  }
  return out.sort((a, b) => b.value - a.value);
}
