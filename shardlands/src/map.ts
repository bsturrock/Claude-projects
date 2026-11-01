import type { Ruleset, Terrain } from "./config.js";
import { type Hex, dist, findPath, inRange, key, neighbors, rng, rotate } from "./hex.js";
import type { Tile } from "./types.js";

/** Capitals for the team in seat 0. Seats 1 and 2 are the same positions rotated 120 and 240 degrees. */
const SEAT0_CAPITALS: Hex[] = [
  { q: -6, r: 0 },
  { q: -4, r: 1 },
  { q: -6, r: 4 },
];

/** Fixed ring around every capital (then rotated), so every agent starts with the same land. */
const START_RING: Terrain[] = ["plains", "forest", "plains", "hills", "forest", "plains"];

export function capitalsForSeat(seat: number): Hex[] {
  return SEAT0_CAPITALS.map((h) => rotate(h, seat));
}

const passableTerrain = (t: Terrain) => t !== "mountain" && t !== "water";

/**
 * Builds a map with exact 3-fold rotational symmetry: terrain is chosen once per rotation orbit,
 * so all three seats face identical geography. The centre hex is the Heart.
 */
export function generateMap(rules: Ruleset, seed: number): Map<string, Tile> {
  for (let attempt = 0; attempt < 200; attempt++) {
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
      for (let k = 0; k < 3; k++) {
        const x = rotate(h, k);
        tiles.set(key(x), { ...x, terrain: t });
      }
    };
    for (const h of inRange({ q: 0, r: 0 }, rules.mapRadius)) {
      if (tiles.has(key(h))) continue;
      set(h, roll());
    }
    tiles.set("0,0", { q: 0, r: 0, terrain: "heart" });
    // Start areas: capital on plains with a fixed ring, and no ruins/crystal within reach of turn 1.
    for (const cap of SEAT0_CAPITALS) {
      set(cap, "plains");
      neighbors(cap).forEach((n, i) => set(n, START_RING[i]));
    }
    // Ring of hexes next to the heart is always passable so it can be reached.
    for (const n of neighbors({ q: 0, r: 0 })) {
      const t = tiles.get(key(n))!;
      if (!passableTerrain(t.terrain)) set(n, "plains");
    }
    // Ensure each seat gets a crystal tile near home (else early tech would hinge on luck).
    const homeCrystal = [...tiles.values()].some(
      (t) => t.terrain === "crystal" && SEAT0_CAPITALS.some((c) => dist(c, t) >= 2 && dist(c, t) <= 4),
    );
    if (!homeCrystal) continue;
    // Everything passable must be reachable from every capital.
    const passable = (h: Hex) => {
      const t = tiles.get(key(h));
      return !!t && passableTerrain(t.terrain);
    };
    const reach = new Set<string>([key(SEAT0_CAPITALS[0])]);
    let frontier = [SEAT0_CAPITALS[0]];
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
    const allPassable = [...tiles.values()].filter((t) => passableTerrain(t.terrain));
    if (allPassable.length !== reach.size) continue;
    if (!findPath(SEAT0_CAPITALS[0], { q: 0, r: 0 }, passable)) continue;
    return tiles;
  }
  throw new Error("could not generate a valid map");
}

export { passableTerrain };
