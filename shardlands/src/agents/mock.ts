import { RESOURCES, type Resource, type UnitType } from "../config.js";
import type { Engine } from "../engine.js";
import { type Hex, dist, inRange, key, rng } from "../hex.js";
import { passableTerrain } from "../map.js";
import { foundingSites } from "../observe.js";
import { emptyDecision, type Agent, type Decision, type DecisionRequest, type Usage } from "../types.js";

/** Strategy knobs for heuristic bots. Mock teams "learn" by nudging these after each game. */
export interface MockStyle {
  expand: number; // target settlements per agent (1-6)
  military: number; // 0-1 share of production for army
  science: number; // 0-1 eagerness to research
  aggression: number; // 0-1 willingness to declare war
  wonder: number; // 0-1 eagerness for monuments/spire
}

export const DEFAULT_STYLE: MockStyle = { expand: 3, military: 0.35, science: 0.5, aggression: 0.4, wonder: 0.4 };

const TECH_PRIORITY: Record<string, string[]> = {
  military: ["bronze", "horsemanship", "tactics", "siegecraft", "steel"],
  science: ["cartography", "mining", "crystal_lore", "masonry", "astral_lore"],
  economy: ["irrigation", "forestry", "statecraft", "currency", "guilds"],
};

/**
 * Heuristic bot used for offline tests, demos and as a baseline. It reads the engine directly
 * (it is not an LLM, so fog of war is only loosely respected), but it plays by the same orders.
 */
export class MockAgent implements Agent {
  static delayMs = 0;
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  private rand: () => number;
  constructor(
    private eng: Engine,
    private id: string,
    private style: MockStyle,
    seed: number,
  ) {
    this.rand = rng(seed);
  }

  async decide(req: DecisionRequest): Promise<Decision> {
    this.usage.calls++;
    if (MockAgent.delayMs) await new Promise((r) => setTimeout(r, MockAgent.delayMs));
    const d = emptyDecision();
    const e = this.eng;
    const me = e.state.agents.get(this.id)!;
    const team = e.team(me.team);
    if (req.phase === "council") {
      if (this.wantsAttack() && this.rand() < 0.7) d.team_message = `Army is ready. Pushing toward ${this.enemyTeam().name}'s nearest town.`;
      else if (this.rand() < 0.4) d.team_message = `Expanding toward the open land. Shout if you need food.`;
      if (this.rand() < 0.1) d.public_message = this.rand() < 0.5 ? "Stay out of our half and nobody gets hurt." : "We have more soldiers than you think.";
      d.reasoning = "Heuristic bot: coordinate lightly.";
      return d;
    }
    const orders: string[] = [];
    const st = me.stock;
    const S = this.style;
    const mySettlements = e.settlementsOf(this.id);
    const myUnits = e.unitsOf(this.id);
    const enemies = e.fighting ? [this.enemyTeam().id] : [];
    const income = this.income();
    const upkeep = myUnits.length * e.rules.upkeepPerUnit;

    // --- support teammates ---
    for (const a of team.agents) {
      if (a === this.id) continue;
      const other = e.state.agents.get(a)!;
      if (other.stock.food < 2 && st.food > 12) orders.push(`give ${a} 4 food`);
    }

    // --- research ---
    if (this.rand() < 0.3 + S.science) {
      const pref = S.military > 0.5 ? "military" : S.science >= 0.5 ? "science" : "economy";
      const order = [...TECH_PRIORITY[pref], ...Object.values(TECH_PRIORITY).flat()];
      const tech = order.find((t) => !e.techAvailable(team.id, t) && RESOURCES.every((r) => st[r] >= (e.rules.techs[t].cost[r] ?? 0)));
      if (tech) {
        orders.push(`research ${tech}`);
      }
    }

    // --- builds ---
    const virtual = { ...st };
    const afford = (c: Partial<Record<Resource, number>>) => RESOURCES.every((r) => virtual[r] >= (c[r] ?? 0));
    const spend = (c: Partial<Record<Resource, number>>) => RESOURCES.forEach((r) => (virtual[r] -= c[r] ?? 0));
    const settlers = myUnits.filter((u) => u.type === "settler").length;
    const military = myUnits.filter((u) => e.isMilitary(u.type)).length;
    const foodOk = income.food - upkeep >= 1 || virtual.food > 8;
    for (const s of mySettlements) {
      let type: UnitType | null = null;
      if (mySettlements.length + settlers < S.expand && e.state.turn < e.rules.turns - 8 && settlers < 1) type = "settler";
      else if (!myUnits.some((u) => u.type === "scout") && e.state.turn < 6 && s === mySettlements[0]) type = "scout";
      else if (military < 1 + S.military * 8 * (enemies.length ? 1.6 : 1) && this.rand() < S.military + (enemies.length ? 0.3 : 0)) {
        type = e.hasTech(team.id, "siegecraft") && enemies.length && this.rand() < 0.3 ? "catapult" : e.hasTech(team.id, "horsemanship") && this.rand() < 0.4 ? "rider" : "soldier";
      }
      if (!type || !foodOk) continue;
      const c = e.unitCost(type, team.id);
      if (afford(c)) {
        orders.push(`build ${type} ${s.id}`);
        spend(c);
      }
    }
    // --- development ---
    for (const s of mySettlements) {
      if (enemies.length && !s.walls && afford(e.wallsCost(team.id)) && this.rand() < 0.5) {
        orders.push(`construct walls ${s.id}`);
        spend(e.wallsCost(team.id));
      }
      const up = e.upgradeCost(s);
      if (up && (s.level === "village" || e.hasTech(team.id, "masonry")) && afford(up) && this.rand() < 1 - S.military * 0.7) {
        orders.push(`upgrade ${s.id}`);
        spend(up);
      }
      if (!s.monument && e.hasTech(team.id, "masonry") && afford(e.rules.buildings.monument.cost) && this.rand() < S.wonder) {
        orders.push(`construct monument ${s.id}`);
        spend(e.rules.buildings.monument.cost);
      }
      if (!e.state.spireBuilt && s.level === "city" && e.hasTech(team.id, "astral_lore") && afford(e.rules.buildings.spire.cost)) {
        orders.push(`construct spire ${s.id}`);
        spend(e.rules.buildings.spire.cost);
      }
    }
    // --- bank surplus ---
    const rich = this.richest();
    if (virtual[rich] > 16) orders.push(`exchange ${e.bankRate(team.id) * 3} ${rich} for ${this.poorest(rich) === "crystal" ? (rich === "ore" ? "wood" : "ore") : this.poorest(rich)}`);

    // --- units ---
    for (const u of myUnits) {
      if (u.type === "settler") {
        const sites = foundingSites(e, team.id, u.pos);
        const best = sites[0];
        if (best && key(best.hex) === key(u.pos)) orders.push(`found ${u.id}`);
        else if (best && (!u.dest || this.rand() < 0.2)) orders.push(`move ${u.id} ${best.hex.q},${best.hex.r}`);
        else if (!best) {
          const anywhere = sites.length ? sites : [];
          if (!anywhere.length && !u.dest) orders.push(`move ${u.id} ${this.randomPassable(u.pos, 5)}`);
        }
      } else if (u.type === "scout") {
        if (u.dest) continue;
        const ruin = [...e.state.tiles.values()].filter((t) => t.terrain === "ruins" && team.explored.has(key(t))).sort((a, b) => dist(a, u.pos) - dist(b, u.pos))[0];
        if (ruin && dist(ruin, u.pos) <= 8) orders.push(`move ${u.id} ${ruin.q},${ruin.r}`);
        else orders.push(`move ${u.id} ${this.unexploredTarget(u.pos)}`);
      } else {
        const target = this.wantsAttack() ? this.attackTarget(u.pos, enemies) : null;
        const army = myUnits.filter((x) => e.isMilitary(x.type)).length;
        if (target && army >= 3) orders.push(`move ${u.id} ${target.q},${target.r}`);
        else if (!u.dest) {
          const home = [...mySettlements].sort((a, b) => e.unitsAt(a.pos).filter((x) => x.team === u.team && x.id !== u.id).length - e.unitsAt(b.pos).filter((x) => x.team === u.team && x.id !== u.id).length || dist(a.pos, u.pos) - dist(b.pos, u.pos))[0];
          if (home && dist(home.pos, u.pos) > 0) orders.push(`move ${u.id} ${home.pos.q},${home.pos.r}`);
        }
      }
    }
    d.orders = orders;
    d.reasoning = `Heuristic bot (expand ${S.expand.toFixed(1)}, military ${S.military.toFixed(2)}, aggression ${S.aggression.toFixed(2)}).`;
    return d;
  }

  private seatIdx() {
    const team = this.eng.teamOf(this.id);
    return team.agents.indexOf(this.id);
  }

  private enemyTeam() {
    return this.eng.opponentOf(this.eng.teamOf(this.id).id);
  }

  /** Whether this bot's style says it is time to attack (same answer for the whole team). */
  private wantsAttack(): boolean {
    const e = this.eng;
    if (!e.fighting) return false;
    return e.state.turn >= Math.round(e.rules.truceTurns + 1 + (1 - this.style.aggression) * 14);
  }

  private attackTarget(from: Hex, enemies: string[]): Hex | null {
    const e = this.eng;
    const team = e.teamOf(this.id);
    let best: Hex | null = null;
    let bd = Infinity;
    for (const s of e.state.settlements.values()) {
      if (!enemies.includes(s.team) || !team.explored.has(key(s.pos))) continue;
      const d = dist(s.pos, from);
      if (d < bd) {
        bd = d;
        best = s.pos;
      }
    }
    return best;
  }

  private income() {
    const out: Record<Resource, number> = { food: 0, wood: 0, ore: 0, crystal: 0 };
    for (const s of this.eng.settlementsOf(this.id)) {
      const y = this.eng.settlementYield(s);
      for (const r of RESOURCES) out[r] += y[r];
    }
    return out;
  }
  private richest(): Resource {
    const st = this.eng.state.agents.get(this.id)!.stock;
    return (["food", "wood", "ore"] as Resource[]).sort((a, b) => st[b] - st[a])[0];
  }
  private poorest(not: Resource): Resource {
    const st = this.eng.state.agents.get(this.id)!.stock;
    return RESOURCES.filter((r) => r !== not).sort((a, b) => st[a] - st[b])[0];
  }
  private unexploredTarget(from: Hex): string {
    const e = this.eng;
    const team = e.teamOf(this.id);
    const cands = [...e.state.tiles.values()].filter((t) => !team.explored.has(key(t)) && passableTerrain(t.terrain));
    if (!cands.length) return this.randomPassable(from, 6);
    cands.sort((a, b) => dist(a, from) - dist(b, from));
    const pick = cands[Math.floor(this.rand() * Math.min(5, cands.length))];
    return `${pick.q},${pick.r}`;
  }
  private randomPassable(from: Hex, r: number): string {
    const e = this.eng;
    const c = inRange(from, r).filter((h) => {
      const t = e.state.tiles.get(key(h));
      return t && passableTerrain(t.terrain);
    });
    const h = c[Math.floor(this.rand() * c.length)] ?? from;
    return `${h.q},${h.r}`;
  }
}
