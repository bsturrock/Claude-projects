import type { Ruleset, Terrain } from "./config.js";
import { type Hex, dist, findPath, inRange, key, neighbors, rng } from "./hex.js";
import type { Tile } from "./types.js";

/**
 * Capitals for the team in seat 0 (the north). Seat 1 gets the same positions rotated 180
 * degrees, so both teams face identical geography. Picked by search: every capital is at least
 * 9 hexes from every enemy capital and 5 from the Heart, and teammates sit 3-4 hexes apart.
 */
const SEAT0_CAPITALS: Hex[] = [
  { q: -5, r: -1 },
  { q: -2, r: -3 },
  { q: 0, r: -6 },
  { q: 3, r: -6 },
];

/** Fixed ring around every capital, so every agent starts with the same land. */
const START_RING: Terrain[] = ["plains", "forest", "plains", "hills", "forest", "plains"];

/** 180 degree rotation about the Heart. */
export const mirror = (h: Hex): Hex => ({ q: -h.q, r: -h.r });

export function capitalsForSeat(seat: number, perTeam: number): Hex[] {
  if (perTeam > SEAT0_CAPITALS.length) throw new Error(`at most ${SEAT0_CAPITALS.length} agents per team`);
  const caps = SEAT0_CAPITALS.slice(0, perTeam);
  return seat === 0 ? caps : caps.map(mirror);
}

export const passableTerrain = (t: Terrain) => t !== "mountain" && t !== "water";

/**
 * Builds a map with exact 180-degree rotational symmetry: terrain is chosen once per mirrored
 * pair, so both seats face identical geography. The centre hex is the Heart.
 */
export function generateMap(rules: Ruleset, seed: number): Map<string, Tile> {
  const caps = SEAT0_CAPITALS.slice(0, rules.agentsPerTeam);
  for (let attempt = 0; attempt < 300; attempt++) {
    const rand = rng(seed + attempt * 7919);
    const tiles = new Map<string, Tile>();
    const weights = Object.entries(rules.terrainWeights) as [Terrain, number][];
    const total = weights.reduce((a, [, w]) => a + w, 0);
    const roll = (): Terrain => {
      let x = rand() * total;
      for (const [t, w] of weights) if ((x -= w) < 0) return t;
      return "plains";
    };
    const set = (h: Hex, t: Terrain) => {
      tiles.set(key(h), { ...h, terrain: t });
      const m = mirror(h);
      tiles.set(key(m), { ...m, terrain: t });
    };
    for (const h of inRange({ q: 0, r: 0 }, rules.mapRadius)) if (!tiles.has(key(h))) set(h, roll());
    tiles.set("0,0", { q: 0, r: 0, terrain: "heart" });
    for (const cap of caps) {
      set(cap, "plains");
      neighbors(cap).forEach((n, i) => {
        if (tiles.has(key(n))) set(n, START_RING[i]);
      });
    }
    for (const n of neighbors({ q: 0, r: 0 })) if (!passableTerrain(tiles.get(key(n))!.terrain)) set(n, "plains");
    // Each side gets a crystal tile near home, or early tech would hinge on luck.
    const homeCrystal = [...tiles.values()].some((t) => t.terrain === "crystal" && caps.some((c) => dist(c, t) >= 2 && dist(c, t) <= 4));
    if (!homeCrystal) continue;
    // Everything passable must be connected.
    const passable = (h: Hex) => {
      const t = tiles.get(key(h));
      return !!t && passableTerrain(t.terrain);
    };
    const reach = new Set<string>([key(caps[0])]);
    let frontier = [caps[0]];
    while (frontier.length) {
      const next: Hex[] = [];
      for (const h of frontier)
        for (const n of neighbors(h))
          if (!reach.has(key(n)) && passable(n)) {
            reach.add(key(n));
            next.push(n);
          }
      frontier = next;
    }
    if ([...tiles.values()].filter((t) => passableTerrain(t.terrain)).length !== reach.size) continue;
    if (!findPath(caps[0], { q: 0, r: 0 }, passable)) continue;
    return tiles;
  }
  throw new Error("could not generate a valid map");
}
