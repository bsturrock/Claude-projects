import { RESOURCES, type Bundle, type Resource } from "../config.js";
import type { Engine } from "../engine.js";
import type { Hex } from "../hex.js";
import type { AgentSession } from "../session.js";

/**
 * The command layer. Everything an agent can do is a command, run through the `shard` CLI
 * (or fed in from JSON/mock agents). There are two kinds:
 *
 * - InfoCommand: runs immediately and prints text (status, map, help, say, notes, done...).
 * - OrderDef: queued during the ORDERS phase and resolved by the engine at its `step`.
 *
 * To add content, write a new definition in one of the files in this folder and add it to
 * the lists in index.ts. Help text, the rules' order list and the CLI all pick it up.
 */

export type Phase = "council" | "orders";

export interface InfoCommand {
  name: string;
  aliases?: string[];
  group: "info" | "talk" | "turn";
  usage: string;
  summary: string;
  help?: string;
  run(s: AgentSession, args: string[]): string;
}

/** Resolution steps, in the order the engine runs them each turn. */
export const STEPS = ["diplomacy", "trade", "gift", "economy", "offer", "found", "movement"] as const;
export type Step = (typeof STEPS)[number];

export interface Preview {
  /** Rejected now: not queued. */
  error?: string;
  /** Resources this order will spend if it succeeds (used to warn about overspending the queue). */
  cost?: Bundle;
  /** Extra text shown when queued (e.g. "arrives in 3 turns"). */
  note?: string;
}

export interface ResolveCtx {
  /** Report a failure to the agent (counted in stats). */
  fail(agent: string, raw: string, why: string): void;
  /** Settlements that already queued a unit this turn. */
  builtAt: Set<string>;
}

export interface OrderDef<A = any> {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  help?: string;
  step: Step;
  /** Turn words into arguments, or return an error message. */
  parse(tok: string[], eng: Engine): A | string;
  /** Check at queue time against the current state (things can still change before resolution). */
  preview?(eng: Engine, agent: string, a: A): Preview;
  /** Short human description used in confirmations and order lists. */
  describe?(a: A): string;
  /** Resolve one order. Orders at the same step resolve agent by agent in queue order. */
  resolve?(eng: Engine, agent: string, a: A, raw: string, ctx: ResolveCtx): void;
  /** Resolve all orders of this kind together (e.g. war votes need to be counted). */
  resolveAll?(eng: Engine, items: { agent: string; a: A; raw: string }[], ctx: ResolveCtx): void;
}

export interface QueuedOrder {
  name: string;
  args: unknown;
  raw: string;
}

// ---------- parsing helpers ----------

/** Splits a command line like a shell would: spaces separate words, quotes group them. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let inToken = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) out.push(cur);
      cur = "";
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

/** Normalises order words: lowercase, "(q,r)" / "q,r" / "q, r" -> separate number tokens. */
export function orderTokens(words: string[]): string[] {
  return words
    .join(" ")
    .toLowerCase()
    .replace(/[(),:;]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function parseCoord(tok: string[]): Hex | null {
  const nums = tok.map(Number);
  if (nums.length < 2 || nums.slice(0, 2).some((n) => !Number.isInteger(n))) return null;
  return { q: nums[0], r: nums[1] };
}

export function normRes(s = ""): Resource | null {
  const x = s.replace(/s$/, "");
  return (RESOURCES as readonly string[]).includes(x) ? (x as Resource) : null;
}

/** Parses "3 wood 2 ore" / "3 wood and 2 ore". */
export function parseBundle(tok: string[]): Bundle | string {
  const b: Bundle = {};
  const t = tok.filter((x) => x !== "and" && x !== "&" && x !== "+");
  if (!t.length) return "missing resources (e.g. 3 wood 2 ore)";
  for (let i = 0; i < t.length; i += 2) {
    const n = Number(t[i]);
    const r = normRes(t[i + 1]);
    if (!Number.isInteger(n) || n <= 0 || !r) return `could not read "${t.slice(i, i + 2).join(" ")}" (write amounts like: 3 wood 2 ore)`;
    b[r] = (b[r] ?? 0) + n;
  }
  return b;
}

/** Drops filler words agents like to add ("at", "to", "in", "on"). */
export const noFiller = (tok: string[]) => tok.filter((x) => !["at", "to", "in", "on"].includes(x));
