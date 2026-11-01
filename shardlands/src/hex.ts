/** Axial hex coordinates (q, r); the third cube coordinate is s = -q - r. */
export interface Hex {
  q: number;
  r: number;
}

export const DIRS: Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export const key = (h: Hex) => `${h.q},${h.r}`;
export const fmt = (h: Hex) => `(${h.q},${h.r})`;
export function parseKey(k: string): Hex {
  const [q, r] = k.split(",").map(Number);
  return { q, r };
}

export function dist(a: Hex, b: Hex): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
}

export function neighbors(h: Hex): Hex[] {
  return DIRS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));
}

export function inRange(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  for (let q = -radius; q <= radius; q++)
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) out.push({ q: center.q + q, r: center.r + r });
  return out;
}

/** 120 degree rotation about the origin: (q, r, s) -> (s, q, r). */
export function rot120(h: Hex): Hex {
  return { q: -h.q - h.r, r: h.q };
}

export function rotate(h: Hex, times: number): Hex {
  let x = h;
  for (let i = 0; i < ((times % 3) + 3) % 3; i++) x = rot120(x);
  return x;
}

/** Mulberry32: small seeded PRNG so maps and loot are reproducible from a seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shortest path (excluding start) over passable hexes, or null. */
export function findPath(from: Hex, to: Hex, passable: (h: Hex) => boolean): Hex[] | null {
  const start = key(from);
  const goal = key(to);
  if (start === goal) return [];
  const prev = new Map<string, string>([[start, ""]]);
  let frontier = [from];
  while (frontier.length) {
    const next: Hex[] = [];
    for (const h of frontier) {
      // Prefer neighbours that head toward the goal, so ties break consistently.
      const ns = neighbors(h).sort((a, b) => dist(a, to) - dist(b, to));
      for (const n of ns) {
        const k = key(n);
        if (prev.has(k)) continue;
        if (k !== goal && !passable(n)) continue;
        if (k === goal && !passable(n)) return null;
        prev.set(k, key(h));
        if (k === goal) {
          const path: Hex[] = [];
          let c = goal;
          while (c !== start) {
            path.unshift(parseKey(c));
            c = prev.get(c)!;
          }
          return path;
        }
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}
