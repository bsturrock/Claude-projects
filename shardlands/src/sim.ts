import { RESOURCES, loadRuleset } from "./config.js";
import { DEFAULT_STYLE, MockAgent, type MockStyle } from "./agents/mock.js";
import { Engine } from "./engine.js";
import { dist, key } from "./hex.js";
import { passableTerrain } from "./map.js";
import { Match } from "./match.js";
import { observe } from "./observe.js";
import { AgentSession } from "./session.js";

/** Plays many mock games, checking rule invariants after every turn. `npm run sim -- [games] [ruleset]` */
const games = Number(process.argv[2] ?? 60);
const rules = loadRuleset(process.argv[3] ?? "standard");
const N = rules.agentsPerTeam;

// ---------- command layer smoke test ----------
{
  const letters = "abcdefgh".slice(0, N).split("");
  const eng = new Engine(rules, [
    { id: "n", name: "North", agents: letters.map((x) => `n-${x}`) },
    { id: "s", name: "South", agents: letters.map((x) => `s-${x}`) },
  ], 7);
  const ctx = { phase: "orders" as const, feedback: [], events: [], messages: [], notes: "" };
  const s = new AgentSession(eng, "n-a", "orders", ctx);
  const my = eng.unitsOf("n-a");
  const settler = my.find((u) => u.type === "settler")!;
  const home = eng.settlementsOf("n-a")[0];
  const checks: [string[], RegExp][] = [
    [["help"], /ORDERS/],
    [["status", "empire"], /YOUR STOCK/],
    [["map", "0,0", "2"], /MAP/],
    [["tile", "0,0"], /heart/],
    [["techs"], /irrigation/],
    [["rules", "combat"], /COMBAT/],
    [["sites", settler.id], /distance/],
    [["path", settler.id, "0,0"], /steps/],
    [["build", "scout", home.id], /queued #1/],
    [["build", "dragon", home.id], /unknown unit type/],
    [["move", settler.id, "(0,", "-3)"], /queued #2|error/],
    [["move", eng.unitsOf("n-b")[0].id, "0,0"], /belongs to n-b/],
    [["exchange", "4", "food", "for", "crystal"], /does not sell crystal/],
    [["give", "s-a", "1", "food"], /only give to teammates/],
    [["do", "say team 'hello there'", "notes remember the east"], /Sent to team[\s\S]*Notes saved/],
    [["orders"], /#1 build scout/],
    [["cancel", "1"], /Cancelled #1/],
    [["frobnicate"], /Unknown command/],
    [["done"], /Done/],
  ];
  let bad = 0;
  for (const [argv, re] of checks) {
    const out = s.exec(argv);
    if (!re.test(out)) {
      bad++;
      console.error(`command check failed: shard ${argv.join(" ")}\n  got: ${out.slice(0, 300)}`);
    }
  }
  const council = new AgentSession(eng, "n-a", "council", { ...ctx, phase: "council" });
  if (!/only be given in the ORDERS phase/.test(council.exec(["build", "scout", home.id]))) bad++;
  console.log(`command layer: ${checks.length + 1 - bad}/${checks.length + 1} checks passed`);
  if (bad) process.exit(1);
}

// ---------- full mock games ----------
const STYLES: Record<string, MockStyle> = {
  balanced: DEFAULT_STYLE,
  warlord: { expand: 2, military: 0.75, science: 0.3, aggression: 0.9, wonder: 0.1 },
  builder: { expand: 5, military: 0.15, science: 0.6, aggression: 0.1, wonder: 0.8 },
};
const names = Object.keys(STYLES);
const pairs: [string, string][] = [];
for (const a of names) for (const b of names) if (a !== b) pairs.push([a, b]);

let failures = 0;
const fail = (g: number, t: number, msg: string) => {
  failures++;
  if (failures < 20) console.error(`game ${g} turn ${t}: ${msg}`);
};
const record: Record<string, { w: number; l: number; d: number }> = Object.fromEntries(names.map((n) => [n, { w: 0, l: 0, d: 0 }]));
const vpSources: Record<string, number> = {};
let totalTurns = 0;
let captures = 0;
let attacks = 0;
let obsChars = 0;
let obsCount = 0;
let orderErrors = 0;
let orders = 0;
const endings: Record<string, number> = {};
let northWins = 0;

for (let g = 0; g < games; g++) {
  const [sa, sb] = pairs[g % pairs.length];
  const letters = "abcdefgh".slice(0, N).split("");
  const teams = [sa, sb].map((style, i) => ({ id: `t${i}`, name: `${style}${i}`, agents: letters.map((x) => `t${i}-${x}`) }));
  const styleOf = (id: string) => STYLES[id.startsWith("t0") ? sa : sb];
  const m = new Match({
    id: `sim${g}`,
    rules,
    seed: 1000 + g,
    teams,
    council: false,
    backend: "mock",
    model: "mock",
    makeAgent: (id, eng) => new MockAgent(eng, id, styleOf(id), g * 31 + id.charCodeAt(id.length - 1)),
  });
  const eng = m.eng;
  const orig = eng.resolveTurn.bind(eng);
  eng.resolveTurn = (o) => {
    const r = orig(o);
    const t = eng.state.turn;
    for (const a of eng.state.agents.values()) for (const res of RESOURCES) if (a.stock[res] < 0) fail(g, t, `${a.id} has negative ${res}`);
    const stack = new Map<string, number>();
    for (const u of eng.state.units.values()) {
      const tile = eng.state.tiles.get(key(u.pos));
      if (!tile || !passableTerrain(tile.terrain)) fail(g, t, `${u.id} on bad tile ${key(u.pos)}`);
      if (u.hp <= 0 || u.hp > eng.unitMaxHp(u.type, u.team)) fail(g, t, `${u.id} hp ${u.hp}`);
      stack.set(`${u.team}@${key(u.pos)}`, (stack.get(`${u.team}@${key(u.pos)}`) ?? 0) + 1);
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
    if (t <= rules.truceTurns && r.events.some((e) => e.kind === "combat")) fail(g, t, "combat during the truce");
    if (t % 10 === 0) {
      obsChars += observe(eng, "t0-a", { phase: "orders", feedback: [], events: [], messages: [], notes: "" }).length;
      obsCount++;
    }
    return r;
  };
  const log = await m.run();
  const res = log.result!;
  totalTurns += res.turns;
  if (res.draw) {
    record[sa].d++;
    record[sb].d++;
  } else {
    const w = res.winner === "t0" ? sa : sb;
    const l = res.winner === "t0" ? sb : sa;
    record[w].w++;
    record[l].l++;
    if (res.winner === "t0") northWins++;
  }
  const end = log.turns.at(-1)!.events.find((e) => e.kind === "end")?.text ?? "";
  const why = /elimination/.test(end) ? "elimination" : /reaching/.test(end) ? "vp target" : /draw/.test(end) ? "draw" : "turn limit";
  endings[why] = (endings[why] ?? 0) + 1;
  for (const t of Object.values(res.scores)) for (const [k, v] of Object.entries(t)) if (k !== "total") vpSources[k] = (vpSources[k] ?? 0) + v;
  for (const s of Object.values(res.stats)) {
    captures += s.captures;
    attacks += s.attacks;
    orderErrors += s.orderErrors;
    orders += s.ordersIssued;
  }
}

console.log(`\n${games} games, ${failures} invariant failures`);
console.log(`avg length ${(totalTurns / games).toFixed(1)} turns; endings ${JSON.stringify(endings)}; attacks/game ${(attacks / games).toFixed(1)}; captures/game ${(captures / games).toFixed(2)}`);
console.log(`record by mock style (W-L-D):`, Object.fromEntries(Object.entries(record).map(([k, v]) => [k, `${v.w}-${v.l}-${v.d}`])));
console.log(`north seat won ${northWins} of ${games} (seat balance check)`);
console.log(`avg VP per team by source:`, Object.fromEntries(Object.entries(vpSources).map(([k, v]) => [k, +(v / games / 2).toFixed(1)])));
console.log(`mock order failure rate at resolution ${((orderErrors / Math.max(1, orders)) * 100).toFixed(1)}%`);
console.log(`avg briefing size ~${Math.round(obsChars / Math.max(1, obsCount))} chars`);
if (failures) process.exit(1);
