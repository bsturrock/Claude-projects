import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every number in the game lives here. The engine, the rules text the agents read, and the UI
 * all read the same Ruleset, so a JSON file in /rulesets can rebalance the whole game.
 */

export const RESOURCES = ["food", "wood", "ore", "crystal"] as const;
export type Resource = (typeof RESOURCES)[number];
export type Bundle = Partial<Record<Resource, number>>;

export const TERRAINS = ["plains", "forest", "hills", "mountain", "water", "crystal", "ruins", "heart"] as const;
export type Terrain = (typeof TERRAINS)[number];

export const UNIT_TYPES = ["scout", "settler", "soldier", "rider", "catapult"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const LEVELS = ["village", "town", "city"] as const;
export type Level = (typeof LEVELS)[number];

export interface UnitSpec {
  cost: Bundle;
  str: number;
  hp: number;
  move: number;
  sight: number;
  /** Damage multiplier against settlements. */
  siege?: number;
  requires?: string;
}

export interface TechSpec {
  name: string;
  tier: 1 | 2 | 3;
  cost: Bundle;
  /** Any one of these techs unlocks it (empty = no prerequisite). */
  requiresAny?: string[];
  /** All of these techs are required. */
  requiresAll?: string[];
  text: string;
}

export interface Ruleset {
  name: string;
  turns: number;
  vpTarget: number;
  mapRadius: number;
  /** Probability weights for random terrain (the start areas use a fixed template). */
  terrainWeights: Partial<Record<Terrain, number>>;
  /** Base yield of one claimed tile. */
  yields: Partial<Record<Terrain, Bundle>>;
  /** Extra yield per claimed producing tile for each level above village. */
  levelBonusPerTile: number;
  minSettlementDistance: number;
  start: { stock: Bundle; units: UnitType[] };
  units: Record<UnitType, UnitSpec>;
  settlement: {
    hp: Record<Level, number>;
    defense: Record<Level, number>;
    sight: number;
    upgradeCost: { town: Bundle; city: Bundle };
    cityRequires: string;
    regen: number;
  };
  buildings: {
    walls: { cost: Bundle; hp: number; defense: number };
    monument: { cost: Bundle; vp: number; requires: string };
    spire: { cost: Bundle; vp: number; requires: string; level: Level };
  };
  upkeepPerUnit: number;
  healPerTurn: number;
  hillsDefenseBonus: number;
  bankRate: number;
  currencyBankRate: number;
  ruinLoot: { min: number; max: number; vp: number };
  vp: {
    settlement: Record<Level, number>;
    capture: number;
    techTier: Record<1 | 2 | 3, number>;
    heartPerTurn: number;
    tradePerTurn: number;
    tradeCap: number;
    tradeMinValue: number;
  };
  offerTtl: number;
  maxOrdersPerTurn: number;
  maxStack: number;
  techs: Record<string, TechSpec>;
}

export const STANDARD: Ruleset = {
  name: "standard",
  turns: 30,
  vpTarget: 60,
  mapRadius: 7,
  terrainWeights: { plains: 30, forest: 22, hills: 17, mountain: 10, water: 9, crystal: 6, ruins: 6 },
  yields: {
    plains: { food: 2 },
    forest: { wood: 2 },
    hills: { ore: 2 },
    water: { food: 1 },
    crystal: { crystal: 1 },
    heart: { crystal: 3 },
    mountain: {},
    ruins: {},
  },
  levelBonusPerTile: 1,
  minSettlementDistance: 3,
  start: { stock: { food: 6, wood: 4, ore: 2, crystal: 0 }, units: ["scout", "settler"] },
  units: {
    scout: { cost: { food: 2 }, str: 1, hp: 1, move: 3, sight: 3 },
    settler: { cost: { food: 6, wood: 3 }, str: 0, hp: 1, move: 1, sight: 1 },
    soldier: { cost: { food: 3, ore: 3 }, str: 2, hp: 3, move: 1, sight: 1 },
    rider: { cost: { food: 3, ore: 2, wood: 2 }, str: 2, hp: 2, move: 2, sight: 2, requires: "horsemanship" },
    catapult: { cost: { wood: 3, ore: 4 }, str: 1, hp: 2, move: 1, sight: 1, siege: 3, requires: "siegecraft" },
  },
  settlement: {
    hp: { village: 4, town: 7, city: 10 },
    defense: { village: 1, town: 2, city: 3 },
    sight: 2,
    upgradeCost: { town: { wood: 10, ore: 6, food: 6 }, city: { wood: 16, ore: 12, food: 8, crystal: 3 } },
    cityRequires: "masonry",
    regen: 1,
  },
  buildings: {
    walls: { cost: { wood: 5, ore: 3 }, hp: 4, defense: 2 },
    monument: { cost: { ore: 12, wood: 8, crystal: 5 }, vp: 3, requires: "masonry" },
    spire: { cost: { ore: 24, wood: 20, crystal: 15 }, vp: 10, requires: "astral_lore", level: "city" },
  },
  upkeepPerUnit: 1,
  healPerTurn: 1,
  hillsDefenseBonus: 1,
  bankRate: 4,
  currencyBankRate: 3,
  ruinLoot: { min: 4, max: 9, vp: 1 },
  vp: {
    settlement: { village: 1, town: 2, city: 3 },
    capture: 2,
    techTier: { 1: 1, 2: 2, 3: 3 },
    heartPerTurn: 1,
    tradePerTurn: 1,
    tradeCap: 8,
    tradeMinValue: 4,
  },
  offerTtl: 2,
  maxOrdersPerTurn: 20,
  maxStack: 6,
  techs: {
    irrigation: { name: "Irrigation", tier: 1, cost: { crystal: 4, food: 6 }, text: "Plains tiles yield +1 food." },
    forestry: { name: "Forestry", tier: 1, cost: { crystal: 4, wood: 6 }, text: "Forest tiles yield +1 wood." },
    mining: { name: "Mining", tier: 1, cost: { crystal: 4, ore: 6 }, text: "Hills tiles yield +1 ore." },
    bronze: { name: "Bronze Working", tier: 1, cost: { crystal: 3, ore: 6 }, text: "Soldiers +1 strength." },
    horsemanship: { name: "Horsemanship", tier: 1, cost: { crystal: 3, food: 6 }, text: "Unlocks Riders." },
    cartography: { name: "Cartography", tier: 1, cost: { crystal: 3, wood: 5 }, text: "All units +1 sight; scouts +1 move." },
    masonry: { name: "Masonry", tier: 2, cost: { crystal: 7, ore: 10 }, requiresAny: ["mining", "forestry"], text: "Unlocks cities and Monuments. Walls cost half." },
    currency: { name: "Currency", tier: 2, cost: { crystal: 7, wood: 6, food: 6 }, requiresAny: ["irrigation", "forestry"], text: "Bank exchange rate improves from 4:1 to 3:1 for your team." },
    siegecraft: { name: "Siegecraft", tier: 2, cost: { crystal: 6, wood: 10 }, requiresAny: ["bronze"], text: "Unlocks Catapults (x3 damage against settlements)." },
    tactics: { name: "Tactics", tier: 2, cost: { crystal: 6, ore: 8, food: 6 }, requiresAny: ["bronze", "horsemanship"], text: "All military units +1 max HP; units heal 2 per turn." },
    crystal_lore: { name: "Crystal Lore", tier: 2, cost: { crystal: 6, food: 6 }, requiresAny: ["cartography", "mining"], text: "Crystal tiles yield +1 crystal; the Heart yields +2." },
    statecraft: { name: "Statecraft", tier: 2, cost: { crystal: 7, food: 10 }, requiresAny: ["irrigation", "cartography"], text: "Settlers and town upgrades cost 2 food and 2 wood less; settlements +2 HP." },
    astral_lore: { name: "Astral Lore", tier: 3, cost: { crystal: 14, ore: 12 }, requiresAll: ["crystal_lore", "masonry"], text: "Unlocks the Shard Spire wonder (only one in the game)." },
    steel: { name: "Steel", tier: 3, cost: { crystal: 12, ore: 16 }, requiresAll: ["tactics"], text: "Soldiers and Riders +1 strength." },
    guilds: { name: "Guilds", tier: 3, cost: { crystal: 12, wood: 12, food: 12 }, requiresAll: ["currency"], text: "Every settlement yields +1 of each resource it already produces; trade VP cap +4." },
  },
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const RULESETS_DIR = path.join(here, "..", "rulesets");

function deepMerge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)?.[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

export function listRulesets(): string[] {
  const names = existsSync(RULESETS_DIR) ? readdirSync(RULESETS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  return ["standard", ...names.filter((n) => n !== "standard")];
}

/** "standard" is built in; any /rulesets/<name>.json is a partial override merged onto it. */
export function loadRuleset(name = "standard"): Ruleset {
  if (name === "standard" && !existsSync(path.join(RULESETS_DIR, "standard.json"))) return structuredClone(STANDARD);
  const file = path.join(RULESETS_DIR, `${name}.json`);
  const over = JSON.parse(readFileSync(file, "utf8"));
  return { ...deepMerge(structuredClone(STANDARD), over), name };
}
