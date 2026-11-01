import { RESOURCES, type Bundle, type Resource } from "../config.js";
import { bundleValue, fmtBundle } from "../bundle.js";
import type { OrderDef } from "./types.js";
import { normRes, parseBundle } from "./types.js";

export const research: OrderDef<{ tech: string }> = {
  name: "research",
  usage: "research <tech-id>",
  summary: "Buy a technology for your whole team (you pay the full cost).",
  help: "Run `shard techs` to see every tech, its cost, prerequisites and whether your team can research it now.",
  step: "economy",
  parse(tok, eng) {
    const want = tok.join("_");
    const id = Object.keys(eng.rules.techs).find((k) => k === want || eng.rules.techs[k].name.toLowerCase().replace(/ /g, "_") === want);
    return id ? { tech: id } : `unknown tech "${tok.join(" ")}" (see: shard techs)`;
  },
  preview(eng, agent, a) {
    const team = eng.state.agents.get(agent)!.team;
    const why = eng.techAvailable(team, a.tech);
    return why ? { error: why } : { cost: eng.rules.techs[a.tech].cost };
  },
  describe: (a) => `research ${a.tech}`,
  resolve(eng, agent, a, raw, ctx) {
    const team = eng.state.agents.get(agent)!.team;
    const why = eng.techAvailable(team, a.tech);
    if (why) return ctx.fail(agent, raw, why);
    const t = eng.rules.techs[a.tech];
    if (!eng.canAfford(agent, t.cost)) return ctx.fail(agent, raw, `you lack ${eng.missing(agent, t.cost)}`);
    eng.pay(agent, t.cost, "tech");
    eng.team(team).techs.push(a.tech);
    eng.stats.get(team)!.techs.push(a.tech);
    eng.log(null, "tech", `${eng.team(team).name} discovered ${t.name}.`, { team, tech: a.tech });
    eng.fb(agent, `OK researched ${t.name}`);
  },
};

export const exchange: OrderDef<{ res: Resource; n: number; want: Resource }> = {
  name: "exchange",
  aliases: ["bank"],
  usage: "exchange <n> <resource> for <resource>",
  summary: "Trade with the bank at your team's rate (default 4:1). The bank never sells crystal.",
  step: "economy",
  parse(tok) {
    const i = tok.indexOf("for");
    if (i < 0) return "usage: exchange <n> <resource> for <resource>";
    const give = parseBundle(tok.slice(0, i));
    const want = normRes(tok[i + 1]);
    if (typeof give === "string") return give;
    const gr = RESOURCES.filter((r) => give[r]);
    if (gr.length !== 1 || !want) return "usage: exchange <n> <resource> for <resource>";
    if (want === gr[0]) return "cannot exchange a resource for itself";
    if (want === "crystal") return "the bank does not sell crystal (get it from crystal tiles, the Heart, ruins or trade)";
    return { res: gr[0], n: give[gr[0]]!, want };
  },
  preview(eng, agent, a) {
    const rate = eng.bankRate(eng.state.agents.get(agent)!.team);
    const n = Math.floor(a.n / rate) * rate;
    if (n <= 0) return { error: `the bank rate is ${rate}:1; offer at least ${rate}` };
    return { cost: { [a.res]: n } as Bundle, note: `you get ${n / rate} ${a.want}${n !== a.n ? ` (only ${n} ${a.res} used)` : ""}` };
  },
  describe: (a) => `exchange ${a.n} ${a.res} for ${a.want}`,
  resolve(eng, agent, a, raw, ctx) {
    const team = eng.state.agents.get(agent)!.team;
    const rate = eng.bankRate(team);
    const n = Math.floor(a.n / rate) * rate;
    if (n <= 0) return ctx.fail(agent, raw, `the bank rate is ${rate}:1`);
    const cost = { [a.res]: n } as Bundle;
    if (!eng.canAfford(agent, cost)) return ctx.fail(agent, raw, `you lack ${eng.missing(agent, cost)}`);
    eng.pay(agent, cost);
    eng.gain(agent, { [a.want]: n / rate } as Bundle);
    eng.stats.get(team)!.exchanges++;
    eng.fb(agent, `OK exchanged ${n} ${a.res} for ${n / rate} ${a.want}`);
  },
};

export const give: OrderDef<{ to: string; bundle: Bundle }> = {
  name: "give",
  aliases: ["send"],
  usage: "give <agent> <n> <resource> [<n> <resource> ...]",
  summary: "Transfer resources to a teammate. Gifts resolve before anyone's purchases, so you can fund a teammate's order this turn.",
  step: "gift",
  parse(tok) {
    const b = parseBundle(tok.slice(1).filter((x) => x !== "to"));
    if (!tok[0]) return "usage: give <agent> <n> <resource> ...";
    return typeof b === "string" ? b : { to: tok[0], bundle: b };
  },
  preview(eng, agent, a) {
    const to = eng.state.agents.get(a.to);
    if (!to) return { error: `no agent "${a.to}"` };
    if (a.to === agent) return { error: "cannot give to yourself" };
    if (to.team !== eng.state.agents.get(agent)!.team) return { error: "you can only give to teammates" };
    return { cost: a.bundle };
  },
  describe: (a) => `give ${fmtBundle(a.bundle)} to ${a.to}`,
  resolve(eng, agent, a, raw, ctx) {
    const to = eng.state.agents.get(a.to);
    if (!to) return ctx.fail(agent, raw, `no agent "${a.to}"`);
    if (to.id === agent) return ctx.fail(agent, raw, "cannot give to yourself");
    const mine = eng.state.agents.get(agent)!.team;
    if (to.team !== mine) return ctx.fail(agent, raw, "you can only give to teammates");
    if (!eng.canAfford(agent, a.bundle)) return ctx.fail(agent, raw, `you lack ${eng.missing(agent, a.bundle)}`);
    eng.pay(agent, a.bundle);
    eng.gain(to.id, a.bundle);
    eng.stats.get(mine)!.giftsTeamValue += bundleValue(a.bundle);
    eng.fb(agent, `OK gave ${fmtBundle(a.bundle)} to ${to.id}`);
    eng.fb(to.id, `RECEIVED ${fmtBundle(a.bundle)} from ${agent}`);
  },
};
