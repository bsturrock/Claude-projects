import { RESOURCES, loadRuleset } from "./config.js";
import { DEFAULT_STYLE, MockAgent, type MockStyle } from "./agents/mock.js";
import { dist, key } from "./hex.js";
import { passableTerrain } from "./map.js";
import { Match } from "./match.js";
import { observe } from "./observe.js";

/** Plays many mock games and checks rule invariants after every turn. `npm run sim -- [games] [ruleset]` */
const games = Number(process.argv[2] ?? 60);
const rules = loadRuleset(process.argv[3] ?? "standard");

const STYLES: Record<string, MockStyle> = {
  balanced: DEFAULT_STYLE,
  warlord: { expand: 2, military: 0.75, science: 0.3, aggression: 0.9, trade: 0.1, wonder: 0.1 },
  builder: { expand: 5, military: 0.15, science: 0.6, aggression: 0.1, trade: 0.6, wonder: 0.8 },
};
const names = Object.keys(STYLES);

let failures = 0;
const fail = (g: number, t: number, msg: string) => {
  failures++;
  if (failures < 20) console.error(`game ${g} turn ${t}: ${msg}`);
};
const wins: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
const vpSources: Record<string, number> = {};
let totalTurns = 0;
let wars = 0;
let captures = 0;
let obsChars = 0;
let obsCount = 0;
let orderErrors = 0;
let orders = 0;

for (let g = 0; g < games; g++) {
  const seats = [0, 1, 2].map((i) => names[(g + i) % names.length]);
  const teams = seats.map((style, i) => ({ id: `t${i}`, name: `${style}${i}`, agents: ["a", "b", "c"].map((x) => `t${i}-${x}`) }));
  const m = new Match({
    id: `sim${g}`,
    rules,
    seed: 1000 + g,
    teams,
    council: false,
    backend: "mock",
    model: "mock",
    makeAgent: (id, eng) => new MockAgent(eng, id, STYLES[seats[Number(id[1])]], g * 31 + id.charCodeAt(4)),
  });
  const eng = m.eng;
  const origResolve = eng.resolveTurn.bind(eng);
  eng.resolveTurn = (o) => {
    const r = origResolve(o);
    const t = eng.state.turn;
    for (const a of eng.state.agents.values()) for (const res of RESOURCES) if (a.stock[res] < 0) fail(g, t, `${a.id} has negative ${res}`);
    const stack = new Map<string, number>();
    for (const u of eng.state.units.values()) {
      const tile = eng.state.tiles.get(key(u.pos));
      if (!tile || !passableTerrain(tile.terrain)) fail(g, t, `${u.id} on bad tile ${key(u.pos)}`);
      if (u.hp <= 0 || u.hp > eng.unitMaxHp(u.type, u.team)) fail(g, t, `${u.id} hp ${u.hp}`);
      const k = `${u.team}@${key(u.pos)}`;
      stack.set(k, (stack.get(k) ?? 0) + 1);
    }
    for (const [k, n] of stack) if (n > rules.maxStack) fail(g, t, `stack ${k} = ${n}`);
    const ss = [...eng.state.settlements.values()];
    for (const a of ss) {
      for (const b of ss) if (a !== b && dist(a.pos, b.pos) < rules.minSettlementDistance) fail(g, t, `settlements ${a.id} ${b.id} too close`);
      if (a.hp < 0 || a.hp > eng.settlementMaxHp(a)) fail(g, t, `${a.id} hp ${a.hp}/${eng.settlementMaxHp(a)}`);
      if (eng.state.agents.get(a.owner)!.team !== a.team) fail(g, t, `${a.id} owner/team mismatch`);
    }
    const claims = ss.flatMap((s) => s.claims);
    if (new Set(claims).size !== claims.length) fail(g, t, "a tile is claimed twice");
    if (t % 10 === 0) {
      const o = observe(eng, "t0-a", { phase: "orders", feedback: [], events: [], messages: [], notes: "" });
      obsChars += o.length;
      obsCount++;
    }
    return r;
  };
  const log = await m.run();
  const res = log.result!;
  totalTurns += res.turns;
  wins[seats[Number(res.ranking[0][1])]]++;
  for (const t of Object.values(res.scores)) for (const [k, v] of Object.entries(t)) if (k !== "total") vpSources[k] = (vpSources[k] ?? 0) + v;
  for (const s of Object.values(res.stats)) {
    wars += s.warsDeclared;
    captures += s.captures;
    orderErrors += s.orderErrors;
    orders += s.ordersIssued;
  }
  if (g === 0) {
    console.log("Sample final scores:", Object.fromEntries(Object.entries(res.scores).map(([k, v]) => [k, v.total])));
  }
}

console.log(`\n${games} games, ${failures} invariant failures`);
console.log(`avg length ${(totalTurns / games).toFixed(1)} turns; wars/game ${(wars / games).toFixed(2)}; captures/game ${(captures / games).toFixed(2)}`);
console.log(`wins by mock style:`, wins);
console.log(`avg VP per team by source:`, Object.fromEntries(Object.entries(vpSources).map(([k, v]) => [k, +(v / games / 3).toFixed(1)])));
console.log(`mock order error rate ${((orderErrors / Math.max(1, orders)) * 100).toFixed(1)}%`);
console.log(`avg observation size ~${Math.round(obsChars / Math.max(1, obsCount))} chars`);
if (failures) process.exit(1);
