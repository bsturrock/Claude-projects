import type { League } from "./league.js";
import { STYLE_KEYS, styleDistance, type StyleVector } from "./metrics.js";

export function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Average pairwise style distance between teams, per block of games: is play diverging? */
export function divergence(league: League, block = 3): { games: string; distance: number }[] {
  const rows = league.results();
  const out: { games: string; distance: number }[] = [];
  for (let i = 0; i < rows.length; i += block) {
    const chunk = rows.slice(i, i + block);
    const byTeam = new Map<string, StyleVector[]>();
    for (const r of chunk) for (const [t, v] of Object.entries(r.styles)) byTeam.set(t, [...(byTeam.get(t) ?? []), v]);
    const avg = [...byTeam.entries()].map(([, vs]) => Object.fromEntries(STYLE_KEYS.map((k) => [k, mean(vs.map((v) => v[k]))])) as StyleVector);
    const ds: number[] = [];
    for (let a = 0; a < avg.length; a++) for (let b = a + 1; b < avg.length; b++) ds.push(styleDistance(avg[a], avg[b]));
    out.push({ games: `${chunk[0].game}-${chunk[chunk.length - 1].game}`, distance: Math.round(mean(ds) * 1000) / 1000 });
  }
  return out;
}

