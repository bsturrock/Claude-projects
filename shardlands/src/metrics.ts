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
  "early_attack",
  "raiding",
  "heart_control",
  "team_support",
  "vp_land",
  "vp_tech",
  "vp_glory",
  "vp_wonders",
  "vp_heart",
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
    aggression: clamp((st.attacks / 40 + st.captures / 8) / 2),
    early_attack: st.firstAttackTurn === null ? 0 : clamp(1 - st.firstAttackTurn / Math.max(1, turns)),
    raiding: clamp(st.raidTileTurns / 40),
    heart_control: clamp(st.heartTurns / Math.max(1, turns)),
    team_support: clamp(st.giftsTeamValue / 80),
    vp_land: vp.settlements / vpTotal,
    vp_tech: vp.tech / vpTotal,
    vp_glory: vp.glory / vpTotal,
    vp_wonders: (vp.monuments + vp.spire) / vpTotal,
    vp_heart: vp.heart / vpTotal,
  };
}

export function styleDistance(a: StyleVector, b: StyleVector): number {
  return Math.sqrt(STYLE_KEYS.reduce((s, k) => s + ((a[k] ?? 0) - (b[k] ?? 0)) ** 2, 0));
}

/** The four strongest traits in a style vector. */
export function describeStyle(v: StyleVector): string {
  const top = [...STYLE_KEYS].sort((a, b) => v[b] - v[a]).slice(0, 4);
  return top.map((k) => `${k} ${(v[k] * 100).toFixed(0)}%`).join(", ");
}

/** Two-player Elo. `score` is 1 if a won, 0.5 for a draw, 0 if b won. */
export function updateElo(ratings: Record<string, number>, a: string, b: string, score: number, k = 24): Record<string, number> {
  const out = { ...ratings };
  out[a] ??= 1500;
  out[b] ??= 1500;
  const ea = 1 / (1 + 10 ** ((out[b] - out[a]) / 400));
  const d = k * (score - ea);
  out[a] = Math.round((out[a] + d) * 10) / 10;
  out[b] = Math.round((out[b] - d) * 10) / 10;
  return out;
}
