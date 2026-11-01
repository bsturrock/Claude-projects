import type { TeamStats } from "./engine.js";
import type { VpBreakdown } from "./types.js";

/**
 * A team's behaviour in one game as a fixed vector, so strategies can be compared across teams
 * and over time. Every component is roughly 0-1. What agents say they do lives in the playbooks;
 * this is what they actually did.
 */
export const STYLE_KEYS = [
  "military_spend",
  "expansion_spend",
  "development_spend",
  "tech_spend",
  "aggression",
  "early_war",
  "diplomacy",
  "trade",
  "team_support",
  "vp_land",
  "vp_tech",
  "vp_glory",
  "vp_wonders",
  "vp_commerce",
] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];
export type StyleVector = Record<StyleKey, number>;

export function styleVector(st: TeamStats, vp: VpBreakdown, turns: number): StyleVector {
  const spend = st.spend.military + st.spend.expansion + st.spend.development + st.spend.tech || 1;
  const vpTotal = vp.total || 1;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return {
    military_spend: st.spend.military / spend,
    expansion_spend: st.spend.expansion / spend,
    development_spend: st.spend.development / spend,
    tech_spend: st.spend.tech / spend,
    aggression: clamp((st.warsDeclared + st.captures * 0.5) / 4),
    early_war: st.firstWarTurn === null ? 0 : clamp(1 - st.firstWarTurn / Math.max(1, turns)),
    diplomacy: clamp(st.peacesMade / 3),
    trade: clamp((st.tradesCross + st.giftsCrossValue / 10) / 10),
    team_support: clamp(st.giftsTeamValue / 60),
    vp_land: vp.settlements / vpTotal,
    vp_tech: vp.tech / vpTotal,
    vp_glory: vp.glory / vpTotal,
    vp_wonders: (vp.monuments + vp.spire) / vpTotal,
    vp_commerce: vp.commerce / vpTotal,
  };
}

export function styleDistance(a: StyleVector, b: StyleVector): number {
  return Math.sqrt(STYLE_KEYS.reduce((s, k) => s + (a[k] - b[k]) ** 2, 0));
}

/** One-line description of the dominant traits in a style vector. */
export function describeStyle(v: StyleVector): string {
  const top = [...STYLE_KEYS].sort((a, b) => v[b] - v[a]).slice(0, 4);
  return top.map((k) => `${k} ${(v[k] * 100).toFixed(0)}%`).join(", ");
}

/** Pairwise Elo update from a finishing order (index 0 = winner). */
export function updateElo(ratings: Record<string, number>, ranking: string[], k = 24): Record<string, number> {
  const out = { ...ratings };
  for (const t of ranking) out[t] ??= 1500;
  const delta: Record<string, number> = Object.fromEntries(ranking.map((t) => [t, 0]));
  for (let i = 0; i < ranking.length; i++)
    for (let j = i + 1; j < ranking.length; j++) {
      const a = ranking[i];
      const b = ranking[j];
      const ea = 1 / (1 + 10 ** ((out[b] - out[a]) / 400));
      delta[a] += (k / (ranking.length - 1)) * (1 - ea);
      delta[b] -= (k / (ranking.length - 1)) * (1 - ea);
    }
  for (const t of ranking) out[t] = Math.round((out[t] + delta[t]) * 10) / 10;
  return out;
}
