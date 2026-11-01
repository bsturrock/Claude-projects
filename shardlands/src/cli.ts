import { League, MODELS, type Backend, type LeagueSettings } from "./league.js";
import { STYLE_KEYS } from "./metrics.js";
import { divergence, mean } from "./divergence.js";
import { claudeCliAvailable } from "./agents/cli.js";
import type { Effort } from "./agents/cli.js";

/**
 * npm run league -- init <name> [--teams 4] [--backend claude-code|api|mock] [--interface cli|json] [--model id]
 *                       [--debrief-model id] [--effort low] [--council 1] [--turns 30] [--concurrency 8] [--ruleset standard]
 * npm run league -- run <name> [--games 1]
 * npm run league -- status <name>
 * npm run league -- list
 */
const [cmd, name, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") ? "1" : (rest[++i] ?? "1");

function usage(): never {
  console.log(`Usage:
  npm run league -- init <name> [--teams 4] [--backend claude-code|api|mock] [--interface cli|json] [--model ${MODELS[0]}] [--effort low] [--council 1] [--turns 30]
  npm run league -- run <name> [--games 1]
  npm run league -- status <name>
  npm run league -- list`);
  process.exit(1);
}

function status(l: League) {
  const rows = l.results();
  const ratings = l.ratings();
  const s = l.file.settings;
  console.log(`League ${l.file.name}: ${rows.length} games, backend ${s.backend}${s.backend !== "mock" ? ` (${s.model}, effort ${s.effort}, interface ${s.interface ?? "cli"})` : ""}, council ${s.council ? "on" : "off"}`);
  console.log(`Spent ~$${rows.reduce((a, r) => a + r.usd, 0).toFixed(2)} API-equivalent.\n`);
  console.log("Team       Elo     Games  W-L-D     Avg VP  Avg VP against");
  const sorted = [...l.file.teams].sort((a, b) => ratings[b.id] - ratings[a.id]);
  for (const t of sorted) {
    const mine = rows.filter((r) => r.seats.includes(t.id));
    const w = mine.filter((r) => r.winner === t.id).length;
    const d = mine.filter((r) => r.draw).length;
    const vp = mean(mine.map((r) => r.scores[t.id].total));
    const vpa = mean(mine.map((r) => r.scores[r.seats.find((x) => x !== t.id)!].total));
    console.log(`${t.name.padEnd(10)} ${String(ratings[t.id]).padEnd(7)} ${String(mine.length).padEnd(6)} ${`${w}-${mine.length - w - d}-${d}`.padEnd(9)} ${vp.toFixed(1).padEnd(7)} ${vpa.toFixed(1)}`);
  }
  if (l.file.teams.length > 2) {
    console.log("\nHead to head (row's wins-losses against column):");
    console.log("".padEnd(11) + sorted.map((t) => t.name.slice(0, 8).padEnd(9)).join(""));
    for (const a of sorted)
      console.log(
        a.name.padEnd(11) +
          sorted
            .map((b) => {
              if (a === b) return "-".padEnd(9);
              const g = rows.filter((r) => r.seats.includes(a.id) && r.seats.includes(b.id));
              return `${g.filter((r) => r.winner === a.id).length}-${g.filter((r) => r.winner === b.id).length}`.padEnd(9);
            })
            .join(""),
      );
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
      interface: flags.interface === "json" ? "json" : "cli",
      council: flags.council !== "0",
      ruleset: flags.ruleset ?? "standard",
      turns: flags.turns ? Number(flags.turns) : undefined,
      concurrency: Number(flags.concurrency ?? 8),
    };
    const l = League.create(name, Number(flags.teams ?? 4), settings);
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
