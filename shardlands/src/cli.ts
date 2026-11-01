import { League, MODELS, type Backend, type LeagueSettings } from "./league.js";
import { STYLE_KEYS } from "./metrics.js";
import { divergence, mean } from "./divergence.js";
import { claudeCliAvailable } from "./agents/cli.js";
import type { Effort } from "./agents/cli.js";

/**
 * npm run league -- init <name> [--teams 3] [--backend claude-code|api|mock] [--model id] [--debrief-model id]
 *                       [--effort low] [--council 1] [--turns 30] [--concurrency 9] [--ruleset standard]
 * npm run league -- run <name> [--games 1]
 * npm run league -- status <name>
 * npm run league -- list
 */
const [cmd, name, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") ? "1" : (rest[++i] ?? "1");

function usage(): never {
  console.log(`Usage:
  npm run league -- init <name> [--teams 3] [--backend claude-code|api|mock] [--model ${MODELS[0]}] [--effort low] [--council 1] [--turns 30]
  npm run league -- run <name> [--games 1]
  npm run league -- status <name>
  npm run league -- list`);
  process.exit(1);
}

function status(l: League) {
  const rows = l.results();
  const ratings = l.ratings();
  const s = l.file.settings;
  console.log(`League ${l.file.name}: ${rows.length} games, backend ${s.backend}${s.backend !== "mock" ? ` (${s.model}, effort ${s.effort})` : ""}, council ${s.council ? "on" : "off"}`);
  console.log(`Spent ~$${rows.reduce((a, r) => a + r.usd, 0).toFixed(2)} API-equivalent.\n`);
  console.log("Team       Elo    Games  Wins  Avg place  Avg VP");
  for (const t of [...l.file.teams].sort((a, b) => ratings[b.id] - ratings[a.id])) {
    const mine = rows.filter((r) => r.seats.includes(t.id));
    const wins = mine.filter((r) => r.ranking[0] === t.id).length;
    const place = mean(mine.map((r) => r.ranking.indexOf(t.id) + 1));
    const vp = mean(mine.map((r) => r.scores[t.id].total));
    console.log(`${t.name.padEnd(10)} ${String(ratings[t.id]).padEnd(6)} ${String(mine.length).padEnd(6)} ${String(wins).padEnd(5)} ${place.toFixed(2).padEnd(10)} ${vp.toFixed(1)}`);
  }
  console.log("\nStyle (average over the team's last 5 games):");
  console.log("Team       " + STYLE_KEYS.map((k) => k.slice(0, 9).padEnd(10)).join(""));
  for (const t of l.file.teams) {
    const vs = rows.filter((r) => r.styles[t.id]).slice(-5).map((r) => r.styles[t.id]);
    if (!vs.length) continue;
    console.log(t.name.padEnd(11) + STYLE_KEYS.map((k) => mean(vs.map((v) => v[k])).toFixed(2).padEnd(10)).join(""));
  }
  const div = divergence(l);
  if (div.length) console.log(`\nStrategy divergence (mean pairwise style distance per 3 games): ${div.map((d) => `${d.games}: ${d.distance}`).join(" | ")}`);
}

async function main() {
  if (cmd === "list") {
    for (const n of League.list()) console.log(n);
    return;
  }
  if (!name) usage();
  if (cmd === "init") {
    const backend = (flags.backend ?? "claude-code") as Backend;
    if (!["claude-code", "api", "mock"].includes(backend)) usage();
    const settings: LeagueSettings = {
      backend,
      model: flags.model ?? MODELS[0],
      debriefModel: flags["debrief-model"],
      effort: (flags.effort ?? "low") as Effort,
      council: flags.council !== "0",
      ruleset: flags.ruleset ?? "standard",
      turns: flags.turns ? Number(flags.turns) : undefined,
      concurrency: Number(flags.concurrency ?? 9),
    };
    const l = League.create(name, Number(flags.teams ?? 3), settings);
    console.log(`Created league "${name}" in ${l.dir} with teams ${l.file.teams.map((t) => t.name).join(", ")}.`);
    return;
  }
  const l = League.open(name);
  if (cmd === "status") return status(l);
  if (cmd === "run") {
    if (l.file.settings.backend === "claude-code" && !claudeCliAvailable().ok) throw new Error("claude CLI not found on PATH");
    if (l.file.settings.backend === "api" && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    const n = Number(flags.games ?? 1);
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      const row = await l.playGame({ log: (s) => console.log(s), seed: flags.seed ? Number(flags.seed) + i : undefined });
      console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)}s, ~$${row.usd})`);
    }
    console.log("");
    status(l);
    return;
  }
  usage();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
