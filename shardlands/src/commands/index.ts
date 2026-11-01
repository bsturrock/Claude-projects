import { RESOURCES, type Bundle } from "../config.js";
import { fmtBundle } from "../bundle.js";
import { findPath, fmt, key } from "../hex.js";
import { describeSettlement, describeUnit, foundingSites, observe, sectionText, SECTIONS, type Section } from "../observe.js";
import { rulesText } from "../rules.js";
import type { AgentSession } from "../session.js";
import { exchange, give, research } from "./orders-economy.js";
import { build, construct, upgrade } from "./orders-production.js";
import { disband, found, move, stop } from "./orders-units.js";
import { orderTokens, parseCoord, splitArgs, type InfoCommand, type OrderDef } from "./types.js";

/**
 * THE REGISTRY. To add a new order: write an OrderDef (see types.ts and the orders-*.ts files)
 * and append it here. To add a new query/utility command: append an InfoCommand to INFO.
 * Help output, the rules' order list and the CLI pick them up automatically.
 */
export const ORDERS: OrderDef[] = [move, stop, found, disband, build, upgrade, construct, research, exchange, give];

const order = (name: string) => ORDERS.find((d) => d.name === name || d.aliases?.includes(name));

// ---------- info / talk / turn commands ----------

const help: InfoCommand = {
  name: "help",
  group: "info",
  usage: "help [command]",
  summary: "List commands, or explain one.",
  run(s, args) {
    if (args[0]) {
      const name = args[0].toLowerCase();
      const o = order(name);
      if (o) return [`shard ${o.usage}`, o.summary, o.help ?? "", `(ORDER: queued now, resolved at the end of the turn; step: ${o.step})`].filter(Boolean).join("\n");
      const c = info(name);
      if (c) return [`shard ${c.usage}`, c.summary, c.help ?? ""].filter(Boolean).join("\n");
      return `No command "${name}". Run: shard help`;
    }
    const line = (u: string, d: string) => `  shard ${u.padEnd(44)} ${d}`;
    const out = [
      `shard: the Shardlands command line. You are ${s.agent}; it is the ${s.phase.toUpperCase()} phase of turn ${s.eng.state.turn}.`,
      "",
      "ORDERS (queued; the engine resolves everyone's orders together at the end of the turn):",
      ...ORDERS.map((o) => line(o.usage, o.summary)),
      "",
      "INFORMATION:",
      ...INFO.filter((c) => c.group === "info").map((c) => line(c.usage, c.summary)),
      "",
      "TALK AND MEMORY:",
      ...INFO.filter((c) => c.group === "talk").map((c) => line(c.usage, c.summary)),
      "",
      "YOUR TURN:",
      ...INFO.filter((c) => c.group === "turn").map((c) => line(c.usage, c.summary)),
      "",
      `Tips: ids are exact (u12, s3). Coordinates are "q,r". Run several commands at once with: shard do "build soldier s3" "move u7 2,-1"`,
    ];
    return out.join("\n");
  },
};

const status: InfoCommand = {
  name: "status",
  group: "info",
  usage: `status [${SECTIONS.join("|")}]`,
  summary: "Your full briefing, or one section of it.",
  run(s, args) {
    const only = args.filter((a) => (SECTIONS as readonly string[]).includes(a)) as Section[];
    if (args.length && !only.length) return `Unknown section. Sections: ${SECTIONS.join(", ")}`;
    return observe(s.eng, s.agent, { ...s.ctx, notes: s.notes }, only.length ? only : undefined) || "(nothing in that section right now)";
  },
};

const mapCmd: InfoCommand = {
  name: "map",
  group: "info",
  usage: "map [<q>,<r> [radius]]",
  summary: "The map as your team knows it, whole or around a hex.",
  run(s, args) {
    const t = orderTokens(args);
    const c = parseCoord(t);
    if (!c) return sectionText(s.eng, s.agent, s.ctx, "map");
    const radius = Number(t[2] ?? 3);
    return sectionText(s.eng, s.agent, s.ctx, "map", { center: c, radius: Number.isInteger(radius) ? radius : 3 });
  },
};

const tile: InfoCommand = {
  name: "tile",
  group: "info",
  usage: "tile <q>,<r>",
  summary: "Everything you know about one hex.",
  run(s, args) {
    const h = parseCoord(orderTokens(args));
    if (!h) return "usage: tile <q>,<r>";
    const eng = s.eng;
    const t = eng.tile(h);
    if (!t) return `${fmt(h)} is off the map`;
    const team = s.team;
    if (!team.explored.has(key(h))) return `${fmt(h)}: unexplored`;
    const seen = eng.visibleTo(team.id).has(key(h));
    const y = eng.rules.yields[t.terrain] ?? {};
    const lines = [`${fmt(h)}: ${t.terrain}${seen ? "" : " (not in sight now)"}; base yield ${fmtBundle(y as Bundle)}; distance from (0,0): ${(Math.abs(h.q) + Math.abs(h.r) + Math.abs(h.q + h.r)) / 2}`];
    if (seen) {
      const st = eng.settlementAt(h);
      if (st) lines.push(describeSettlement(eng, st.id, st.owner === s.agent));
      const c = eng.claimOwner(key(h));
      if (c && c !== st) lines.push(`territory of ${c.id} ${c.name} (${c.owner})`);
      for (const u of eng.unitsAt(h)) lines.push(u.team === team.id ? describeUnit(eng, u.id) + ` [${u.owner}]` : `${u.id} ${u.type} of ${u.owner} (enemy) HP ${u.hp} str ${eng.unitStr(u)}`);
    } else if (team.memory.has(key(h))) lines.push(`last seen: ${team.memory.get(key(h))}`);
    return lines.join("\n");
  },
};

const path: InfoCommand = {
  name: "path",
  group: "info",
  usage: "path <unit> <q>,<r>",
  summary: "Preview a unit's route and how many turns it takes.",
  run(s, args) {
    const t = orderTokens(args);
    const to = parseCoord(t.slice(1).filter((x) => x !== "to"));
    if (!t[0] || !to) return "usage: path <unit> <q>,<r>";
    const u = s.eng.findUnit(s.agent, t[0]);
    if (typeof u === "string") return u;
    const p = findPath(u.pos, to, s.eng.passableFor(u));
    if (!p) return `No route from ${fmt(u.pos)} to ${fmt(to)}.`;
    const mv = s.eng.unitMove(u);
    return `${u.id} ${fmt(u.pos)} -> ${fmt(to)}: ${p.length} steps, ${Math.ceil(p.length / mv)} turn(s) at move ${mv}.\nRoute: ${p.map(fmt).join(" ")}`;
  },
};

const sites: InfoCommand = {
  name: "sites",
  group: "info",
  usage: "sites <settler> [range]",
  summary: "Best legal village sites near a settler, with yields.",
  run(s, args) {
    const u = s.eng.findUnit(s.agent, args[0] ?? "");
    if (typeof u === "string") return args[0] ? u : "usage: sites <settler> [range]";
    const list = foundingSites(s.eng, s.team.id, u.pos, Number(args[1] ?? 6)).slice(0, 10);
    if (!list.length) return "No legal sites known in range.";
    return list.map((x) => `${fmt(x.hex)} distance ${x.d}: ${x.text || "nothing"} per turn`).join("\n");
  },
};

const techs: InfoCommand = {
  name: "techs",
  group: "info",
  usage: "techs",
  summary: "Every technology: cost, prerequisites, effect, and whether you can research it now.",
  run(s) {
    const eng = s.eng;
    return Object.entries(eng.rules.techs)
      .map(([id, t]) => {
        const why = eng.techAvailable(s.team.id, id);
        const state = why === "already known" ? "KNOWN" : why ? `locked (${why})` : "AVAILABLE";
        return `${id.padEnd(13)} tier ${t.tier} ${state.padEnd(12)} cost ${fmtBundle(t.cost)}. ${t.text}`;
      })
      .join("\n");
  },
};

const rules: InfoCommand = {
  name: "rules",
  group: "info",
  usage: "rules [topic]",
  summary: "The rules, or one section (e.g. rules combat).",
  run(s, args) {
    const text = rulesText(s.eng.rules);
    if (!args[0]) return text;
    const parts = text.split(/\n(?=[A-Z][A-Z ]+\n)/);
    const want = args.join(" ").toLowerCase();
    const hit = parts.filter((p) => p.split("\n")[0].toLowerCase().includes(want));
    return hit.length ? hit.join("\n\n") : `No section "${want}". Sections: ${parts.map((p) => p.split("\n")[0].toLowerCase()).join(", ")}`;
  },
};

const say: InfoCommand = {
  name: "say",
  group: "talk",
  usage: "say team|public <message>",
  summary: "Message your team (private) or everyone, including the enemy.",
  help: "Council-phase messages arrive before this turn's orders phase; orders-phase messages arrive next turn.",
  run(s, args) {
    const ch = (args[0] ?? "").toLowerCase();
    const text = args.slice(1).join(" ").trim();
    if (!["team", "public"].includes(ch) || !text) return 'usage: say team|public <message>  (quote the message: shard say team "hold the pass")';
    if (s.said.length >= s.limits.messages) return `Message limit for this phase reached (${s.limits.messages}).`;
    s.said.push({ channel: ch === "team" ? `team:${s.team.id}` : "public", text: text.slice(0, s.limits.messageChars) });
    return `Sent to ${ch}${text.length > s.limits.messageChars ? " (truncated)" : ""}. ${s.phase === "council" ? "It arrives before the orders phase." : "It arrives next turn."}`;
  },
};

const notes: InfoCommand = {
  name: "notes",
  group: "talk",
  usage: "notes [text]",
  summary: "Show or replace your private notes (your only memory between decisions).",
  run(s, args) {
    const text = args.join(" ").trim();
    if (!text) return s.notes ? `Your notes:\n${s.notes}` : "Your notes are empty.";
    s.notes = text.slice(0, s.limits.notesChars);
    return `Notes saved (${s.notes.length} chars).`;
  },
};

const ordersCmd: InfoCommand = {
  name: "orders",
  aliases: ["queue"],
  group: "turn",
  usage: "orders",
  summary: "List your queued orders and what they will cost.",
  run(s) {
    if (!s.queue.length) return "No orders queued.";
    const cost = queuedCost(s);
    const st = s.eng.state.agents.get(s.agent)!.stock;
    const short = s.eng.missing(s.agent, cost, st);
    return [
      ...s.queue.map((o, i) => `  #${i + 1} ${o.raw}`),
      `Total cost: ${fmtBundle(cost)}${short ? `; you are SHORT ${short}` : ""}.`,
    ].join("\n");
  },
};

const cancel: InfoCommand = {
  name: "cancel",
  group: "turn",
  usage: "cancel <n>",
  summary: "Remove queued order #n.",
  run(s, args) {
    const n = Number(args[0]);
    if (!Number.isInteger(n) || n < 1 || n > s.queue.length) return `usage: cancel <n> (1-${s.queue.length || 0})`;
    const [o] = s.queue.splice(n - 1, 1);
    return `Cancelled #${n}: ${o.raw}`;
  },
};

const clear: InfoCommand = {
  name: "clear",
  group: "turn",
  usage: "clear",
  summary: "Remove all queued orders.",
  run(s) {
    const n = s.queue.length;
    s.queue = [];
    return `Cleared ${n} order(s).`;
  },
};

const done: InfoCommand = {
  name: "done",
  aliases: ["end", "submit"],
  group: "turn",
  usage: "done",
  summary: "Finish this phase. Your queued orders and messages are final.",
  run(s) {
    s.done = true;
    return s.phase === "orders" ? `Done. ${s.queue.length} order(s) submitted.` : "Done talking for this phase.";
  },
};

const doCmd: InfoCommand = {
  name: "do",
  group: "turn",
  usage: 'do "<command>" "<command>" ...',
  summary: "Run several commands in one go.",
  run(s, args) {
    if (!args.length) return 'usage: shard do "build soldier s3" "move u7 2,-1"';
    return args.map((line) => `> ${line}\n${s.exec(splitArgs(line), true)}`).join("\n");
  },
};

export const INFO: InfoCommand[] = [help, status, mapCmd, tile, path, sites, techs, rules, say, notes, ordersCmd, cancel, clear, done, doCmd];
const info = (name: string) => INFO.find((c) => c.name === name || c.aliases?.includes(name));

function queuedCost(s: AgentSession): Bundle {
  const total: Bundle = {};
  for (const q of s.queue) {
    const def = ORDERS.find((d) => d.name === q.name)!;
    const c = def.preview?.(s.eng, s.agent, q.args).cost ?? {};
    for (const r of RESOURCES) if (c[r]) total[r] = (total[r] ?? 0) + c[r]!;
  }
  return total;
}

/** Entry point for every command, whatever the source. */
export function runCommand(s: AgentSession, argv: string[]): string {
  let words = argv.filter((w) => w !== "");
  if (words[0] === "shard") words = words.slice(1);
  if (!words.length) return info("help")!.run(s, []);
  const name = words[0].toLowerCase();
  const c = info(name);
  if (c) return c.run(s, words.slice(1));
  const def = order(name);
  if (!def) return `Unknown command "${words[0]}". Run: shard help`;
  if (s.phase !== "orders") return `"${def.name}" is an order; orders can only be given in the ORDERS phase. This is the COUNCIL phase: talk with "shard say", then "shard done".`;
  if (s.done) return `You already ran "shard done" for this phase.`;
  const raw = [def.name, ...words.slice(1)].join(" ");
  const a = def.parse(orderTokens(words.slice(1)), s.eng);
  if (typeof a === "string") return `error: ${a}\nusage: shard ${def.usage}`;
  const p = def.preview?.(s.eng, s.agent, a) ?? {};
  if (p.error) return `error: ${p.error}`;
  // A new move/stop/found for the same unit replaces the old one.
  const unit = (a as { unit?: string }).unit;
  let replaced = "";
  if (unit && ["move", "stop"].includes(def.name)) {
    const i = s.queue.findIndex((q) => ["move", "stop"].includes(q.name) && (q.args as { unit?: string }).unit === unit);
    if (i >= 0) replaced = ` (replaces #${i + 1}: ${s.queue.splice(i, 1)[0].raw})`;
  }
  if (s.queue.length >= s.eng.rules.maxOrdersPerTurn) return `error: you can queue at most ${s.eng.rules.maxOrdersPerTurn} orders per turn`;
  s.queue.push({ name: def.name, args: a, raw });
  let msg = `queued #${s.queue.length}: ${def.describe ? def.describe(a) : raw}${p.note ? ` (${p.note})` : ""}${replaced}`;
  if (p.cost && Object.keys(p.cost).length) {
    const short = s.eng.missing(s.agent, queuedCost(s));
    msg += `\ncost ${fmtBundle(p.cost)}.${short ? ` WARNING: your queued orders now exceed your stock by ${short}; the last ones will fail unless a teammate gives you resources this turn.` : ""}`;
  }
  return msg;
}

/** Every command with usage and summary, for system prompts and docs. */
export function commandReference(): string {
  const line = (u: string, d: string) => `shard ${u.padEnd(46)} ${d}`;
  return [
    "Orders:",
    ...ORDERS.map((o) => line(o.usage, o.summary)),
    "Information:",
    ...INFO.filter((c) => c.group === "info").map((c) => line(c.usage, c.summary)),
    "Talk and memory:",
    ...INFO.filter((c) => c.group === "talk").map((c) => line(c.usage, c.summary)),
    "Your turn:",
    ...INFO.filter((c) => c.group === "turn").map((c) => line(c.usage, c.summary)),
  ].join("\n");
}

/** Order list for the rules text. */
export function ordersReference(): string {
  return ORDERS.map((o) => `${o.usage.padEnd(48)} ${o.summary}`).join("\n");
}
