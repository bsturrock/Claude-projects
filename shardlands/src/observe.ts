import { RESOURCES, type Resource } from "./config.js";
import { type Engine, fmtBundle, parseHex } from "./engine.js";
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

export function channelLabel(ch: string, eng: Engine): string {
  if (ch === "public") return "public";
  if (ch.startsWith("team:")) return "team";
  const [a, b] = ch.slice(8).split("|");
  return `embassy ${eng.team(a).name}-${eng.team(b).name}`;
}

/** Everything one agent knows, as text. Only information its team can legitimately see. */
export function observe(eng: Engine, agentId: string, ctx: ObsContext): string {
  const S = eng.state;
  const R = eng.rules;
  const me = S.agents.get(agentId)!;
  const team = eng.team(me.team);
  const others = S.teams.filter((t) => t.id !== team.id);
  const vis = eng.visibleTo(team.id);
  const lines: string[] = [];
  const P = (s = "") => lines.push(s);

  P(`=== TURN ${S.turn} of ${R.turns}: ${ctx.phase.toUpperCase()} PHASE ===`);
  P(`You are ${agentId} of team ${team.name} (id "${team.id}"). Teammates: ${team.agents.filter((a) => a !== agentId).join(", ")}.`);
  P(`Other teams: ${others.map((t) => `${t.name} (id "${t.id}", agents ${t.agents.join(", ")})`).join("; ")}.`);
  P(`Diplomacy: ${others.map((t) => `${t.name}: ${eng.stance(team.id, t.id).toUpperCase()}`).join(" | ")}`);
  const offersPeace = [...S.peaceOffers.keys()].filter((k) => k.endsWith(`>${team.id}`)).map((k) => eng.team(k.split(">")[0]).name);
  if (offersPeace.length) P(`Peace offered to you by: ${offersPeace.join(", ")} (answer with "peace <team>" from 2 agents).`);
  const sc = eng.scores();
  P(`Scores (first to ${R.vpTarget} VP, or most VP after turn ${R.turns}):`);
  for (const t of S.teams) {
    const b = sc.get(t.id)!;
    P(`  ${t.name}${t.id === team.id ? " (you)" : ""}: ${b.total} VP [settlements ${b.settlements}, monuments ${b.monuments}, spire ${b.spire}, tech ${b.tech}, glory ${b.glory}, heart ${b.heart}, commerce ${b.commerce}/${eng.tradeCap(t.id)}]; techs: ${t.techs.join(", ") || "none"}; settlements: ${eng.teamSettlements(t.id).length}${eng.teamAlive(t.id) ? "" : " ELIMINATED"}`);
  }
  if (S.spireBuilt) P(`The Shard Spire has been built by ${eng.team(S.spireBuilt).name}.`);
  const avail = Object.keys(R.techs).filter((t) => !eng.techAvailable(team.id, t));
  P(`Researchable now: ${avail.map((t) => `${t} (${fmtBundle(R.techs[t].cost)})`).join("; ") || "none"}`);
  P();

  // ---- own empire ----
  const income: Record<Resource, number> = { food: 0, wood: 0, ore: 0, crystal: 0 };
  for (const s of eng.settlementsOf(agentId)) {
    const y = eng.settlementYield(s);
    for (const r of RESOURCES) income[r] += y[r];
  }
  const myUnits = eng.unitsOf(agentId);
  P(`YOUR STOCK: ${RESOURCES.map((r) => `${r} ${me.stock[r]}`).join(", ")}`);
  P(`Expected income: ${RESOURCES.map((r) => `+${income[r]} ${r}`).join(", ")}; unit upkeep -${myUnits.length * R.upkeepPerUnit} food.`);
  P(`YOUR SETTLEMENTS:`);
  for (const s of eng.settlementsOf(agentId)) P("  " + describeSettlement(eng, s.id, true));
  if (!eng.settlementsOf(agentId).length) P("  none");
  P(`YOUR UNITS (you can only command these, and your own settlements):`);
  for (const u of myUnits) P("  " + describeUnit(eng, u.id));
  if (!myUnits.length) P("  none");
  P(`Unit costs: ${(["scout", "settler", "soldier", "rider", "catapult"] as const).map((t) => `${t} ${fmtBundle(eng.unitCost(t, team.id))}`).join("; ")}. Walls ${fmtBundle(eng.wallsCost(team.id))}. Bank rate ${eng.bankRate(team.id)}:1.`);
  P();
  P(`TEAMMATES (they command their own units and settlements; coordinate through team_message, and use "give" to fund each other):`);
  for (const a of team.agents.filter((x) => x !== agentId)) {
    const st = S.agents.get(a)!;
    P(`  ${a}: stock ${RESOURCES.map((r) => `${r} ${st.stock[r]}`).join(", ")}`);
    for (const s of eng.settlementsOf(a)) P("    " + describeSettlement(eng, s.id, false));
    for (const u of eng.unitsOf(a)) P("    " + describeUnit(eng, u.id));
  }
  P();

  // ---- offers ----
  const mine = [...S.offers.values()].filter((o) => o.to === agentId || o.from === agentId);
  if (mine.length) {
    P(`OPEN TRADE OFFERS:`);
    for (const o of mine)
      P(o.to === agentId ? `  ${o.id} from ${o.from}: they give ${fmtBundle(o.give)}; you give ${fmtBundle(o.get)}` : `  ${o.id} to ${o.to}: you give ${fmtBundle(o.give)}; they give ${fmtBundle(o.get)}`);
    P();
  }

  // ---- what happened ----
  if (ctx.feedback.length) {
    P(`RESULTS OF YOUR LAST ORDERS:`);
    for (const f of ctx.feedback) P(`  ${f}`);
    P();
  }
  const evs = ctx.events.filter((e) => e.vis === null || e.vis === team.id);
  if (evs.length) {
    P(`EVENTS SINCE YOUR LAST DECISION:`);
    for (const e of evs) P(`  [t${e.turn}] ${e.text}`);
    P();
  }
  if (ctx.messages.length) {
    P(`MESSAGES SINCE YOUR LAST DECISION:`);
    for (const m of ctx.messages) P(`  [t${m.turn} ${m.phase} | ${channelLabel(m.channel, eng)}] ${m.from}: ${m.text}`);
    P();
  }

  // ---- map ----
  P(`MAP (known tiles). Each cell is terrain + marker, listed by row r from q=min to q=max.`);
  P(`Terrain: P plains, F forest, H hills, M mountain, W water, C crystal, R ruins, * Heart, ?? unexplored.`);
  P(`Marker: . nothing | S your settlement | T teammate settlement | E foreign settlement | m your unit(s) | t teammate unit(s) | x foreign unit(s) | + your team's territory | - foreign territory. Lowercase terrain = explored but not visible now.`);
  const Rr = R.mapRadius;
  for (let r = -Rr; r <= Rr; r++) {
    const q0 = Math.max(-Rr, -r - Rr);
    const q1 = Math.min(Rr, -r + Rr);
    const cells: string[] = [];
    for (let q = q0; q <= q1; q++) {
      const k = `${q},${r}`;
      if (!team.explored.has(k)) {
        cells.push("??");
        continue;
      }
      const t = S.tiles.get(k)!;
      const seen = vis.has(k);
      let terr = LETTER[t.terrain];
      if (!seen) terr = terr.toLowerCase();
      let mark = ".";
      const h = { q, r };
      const s = seen ? eng.settlementAt(h) : undefined;
      const units = seen ? eng.unitsAt(h) : [];
      if (s) mark = s.owner === agentId ? "S" : s.team === team.id ? "T" : "E";
      else if (!seen && team.memory.has(k)) mark = team.memory.get(k)!.includes(` of ${agentId}`) ? "S" : "E";
      else if (units.some((u) => u.team !== team.id)) mark = "x";
      else if (units.some((u) => u.owner === agentId)) mark = "m";
      else if (units.length) mark = "t";
      else if (seen) {
        const c = eng.claimOwner(k);
        if (c) mark = c.team === team.id ? "+" : "-";
      }
      cells.push(terr + mark);
    }
    P(`r=${String(r).padStart(2)} q=${String(q0).padStart(2)}..${String(q1).padStart(2)}: ${cells.join(" ")}`);
  }
  P();

  // ---- foreign things in sight ----
  const foreignS = [...S.settlements.values()].filter((s) => s.team !== team.id && vis.has(key(s.pos)));
  const foreignU = [...S.units.values()].filter((u) => u.team !== team.id && vis.has(key(u.pos)));
  P(`FOREIGN SETTLEMENTS IN SIGHT:`);
  for (const s of foreignS) P("  " + describeSettlement(eng, s.id, false));
  if (!foreignS.length) P("  none");
  const remembered = [...team.memory.entries()].filter(([k, v]) => !vis.has(k) && !team.agents.some((a) => v.endsWith(` of ${a}`)));
  if (remembered.length) P(`  last seen (not in sight now): ${remembered.map(([k, v]) => `${v} at (${k})`).join("; ")}`);
  P(`FOREIGN UNITS IN SIGHT:`);
  if (!foreignU.length) P("  none");
  else {
    const byHex = new Map<string, string[]>();
    for (const u of foreignU) {
      const k = key(u.pos);
      if (!byHex.has(k)) byHex.set(k, []);
      byHex.get(k)!.push(`${u.id} ${u.type} of ${u.owner} (HP ${u.hp})`);
    }
    for (const [k, list] of byHex) P(`  (${k}): ${list.join(", ")}`);
  }
  const ruins = [...S.tiles.values()].filter((t) => t.terrain === "ruins" && team.explored.has(key(t)));
  if (ruins.length) P(`UNEXPLORED RUINS YOU KNOW OF: ${ruins.map((t) => fmt(t)).join(" ")}`);

  // ---- founding sites near own settlers ----
  const settlers = myUnits.filter((u) => u.type === "settler");
  if (settlers.length) {
    P(`GOOD FOUNDING SITES NEAR YOUR SETTLERS (legal as far as your team knows; yield = per turn as a village):`);
    for (const u of settlers) {
      const sites = foundingSites(eng, team.id, u.pos).slice(0, 5);
      P(`  ${u.id} at ${fmt(u.pos)}: ${sites.map((x) => `${fmt(x.hex)} d${x.d} [${x.text}]`).join("; ") || "no legal sites known within 6 hexes"}`);
    }
  }
  P();
  if (ctx.notes) {
    P(`YOUR NOTES FROM YOUR LAST DECISION:`);
    P(ctx.notes);
    P();
  }
  if (ctx.phase === "council")
    P(`COUNCIL PHASE: talk to your team, the public, or an embassy. Orders are ignored in this phase (leave "orders" empty). Your teammates and other teams see your messages before the ORDERS phase of this same turn.`);
  else
    P(`ORDERS PHASE: submit this turn's orders. Messages you send now arrive next turn. Units with standing move orders keep moving without new orders.`);
  return lines.join("\n");
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

export function foundingSites(eng: Engine, team: string, from: Hex): { hex: Hex; d: number; text: string; value: number }[] {
  const T = eng.team(team);
  const known = [...eng.state.settlements.values()].filter((s) => T.explored.has(key(s.pos)) || s.team === team);
  const out: { hex: Hex; d: number; text: string; value: number }[] = [];
  for (const h of inRange(from, 6)) {
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

export { parseHex };
