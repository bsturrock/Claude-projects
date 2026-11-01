import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Usage } from "../types.js";
export type { Usage };
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Players backed by the Claude Code CLI instead of the API. Each player is ONE long-running
 * `claude -p --input-format stream-json` process for the whole game: every decision is sent as a
 * new user message on stdin, so there is no per-turn process start-up or session reload.
 * It authenticates with whatever `claude` is logged in as (e.g. a Pro/Max subscription).
 */

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
/** Sessions live in their own directory so no project CLAUDE.md, hooks or settings leak in. */
export const WORK_DIR = path.join(os.tmpdir(), "shardlands-agents");
const TURN_TIMEOUT_MS = Number(process.env.SHARD_TURN_TIMEOUT_MS ?? 300000);

/** Every live child process, so they can all be killed when a game ends or the server exits. */
const live = new Set<ChildProcessWithoutNullStreams>();
function killAll() {
  for (const c of live) c.kill("SIGTERM");
  live.clear();
}
process.once("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    killAll();
    process.exit(130);
  });
}

export function claudeCliAvailable(): { ok: boolean; version?: string } {
  const r = spawnSync(CLAUDE_BIN, ["--version"], { encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? { ok: true, version: r.stdout.trim() } : { ok: false };
}

/**
 * Environment for child sessions: drop API credentials so the CLI uses the logged-in account,
 * and drop any inherited session id (set when this server itself runs inside Claude Code).
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.env.SHARD_CLI_USE_API_KEY !== "1") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}

export interface CliResult {
  output: unknown;
  thinking: string;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  costUsd: number;
}

interface SessionOptions {
  systemPromptFile: string;
  /** JSON schema for structured output. Omit for free-text (tool-using) sessions. */
  schema?: object;
  /** Built-in tools to enable, and the permission rules that pre-approve them (everything else is denied). */
  tools?: { enable: string[]; allow: string[] };
  /** Extra environment variables for the child (e.g. SHARD_URL / SHARD_TOKEN / PATH). */
  env?: Record<string, string>;
  model: string;
  effort: Effort;
  /** Persist the transcript so a crashed process can be resumed. One-shot calls don't need it. */
  persist: boolean;
}

function baseArgs(o: SessionOptions): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", o.model,
    "--effort", o.effort,
    "--system-prompt-file", o.systemPromptFile,
    ...(o.schema ? ["--json-schema", JSON.stringify(o.schema)] : []),
    ...(o.tools
      ? ["--tools", o.tools.enable.join(","), "--allowedTools", ...o.tools.allow, "--permission-mode", "dontAsk"]
      : ["--tools", ""]),
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
}

/**
 * One long-lived Claude Code process. Turns are strictly sequential: send() resolves when that
 * turn's `result` message arrives. If the process dies, the next send() restarts it with
 * --resume so the conversation (the player's memory) carries on.
 */
export class CliSession {
  readonly sessionId = randomUUID();
  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false; // a transcript exists on disk and can be resumed
  private buf = "";
  private stderr = "";
  private thinking: string[] = [];
  private pending: { resolve: (r: CliResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private lastCost = 0;
  private closed = false;

  constructor(private o: SessionOptions) {}

  private spawnChild() {
    mkdirSync(WORK_DIR, { recursive: true });
    const args = baseArgs(this.o);
    if (!this.o.persist) args.push("--no-session-persistence");
    else if (this.started) args.push("--resume", this.sessionId);
    else args.push("--session-id", this.sessionId);
    const child = spawn(CLAUDE_BIN, args, { cwd: WORK_DIR, env: { ...childEnv(), ...(this.o.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    live.add(child);
    this.child = child;
    this.buf = "";
    this.stderr = "";
    this.lastCost = 0; // total_cost_usd restarts with a new process
    child.stdout.on("data", (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        this.onLine(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)));
    child.on("error", (err) => this.fail(new Error(`could not start "${CLAUDE_BIN}": ${err.message}. Is Claude Code installed and on PATH?`)));
    child.on("close", (code) => {
      live.delete(child);
      if (this.child === child) this.child = null;
      this.fail(new Error(`claude process exited (${code}) mid-turn. ${this.stderr.slice(-400)}`));
    });
  }

  private fail(err: Error) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) if (b.type === "thinking" && b.thinking) this.thinking.push(b.thinking);
      return;
    }
    if (msg.type !== "result") return;
    this.started = true;
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (msg.is_error || msg.subtype !== "success") {
      p.reject(new Error(`claude error (${msg.subtype}): ${String(msg.result ?? "").slice(0, 400)}`));
      return;
    }
    let output = msg.structured_output;
    if (!this.o.schema) output = String(msg.result ?? "");
    else if (output === undefined && typeof msg.result === "string") {
      try {
        output = JSON.parse(msg.result);
      } catch {
        p.reject(new Error("claude returned no structured output"));
        return;
      }
    }
    // total_cost_usd is cumulative for the process; report this turn's share.
    const total = Number(msg.total_cost_usd ?? 0);
    const costUsd = Math.max(0, total - this.lastCost);
    this.lastCost = total;
    const u = msg.usage ?? {};
    p.resolve({
      output,
      thinking: this.thinking.join("\n").trim(),
      usage: {
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      },
      costUsd,
    });
  }

  send(prompt: string): Promise<CliResult> {
    if (this.closed) return Promise.reject(new Error("session closed"));
    if (this.pending) return Promise.reject(new Error("a turn is already in progress for this session"));
    if (!this.child) this.spawnChild();
    this.thinking = [];
    return new Promise<CliResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`claude turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
        this.child?.kill("SIGTERM"); // the next turn resumes from the saved transcript
      }, TURN_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      this.child!.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
    });
  }

  close() {
    this.closed = true;
    this.fail(new Error("session closed"));
    if (this.child) {
      this.child.stdin.end();
      const c = this.child;
      setTimeout(() => c.kill("SIGTERM"), 2000).unref();
      this.child = null;
    }
  }
}

/** One-shot call (used by the narrator): a fresh process that answers once and exits. */
export async function runClaude(call: { prompt: string } & Omit<SessionOptions, "persist">): Promise<CliResult> {
  const s = new CliSession({ ...call, persist: false });
  try {
    return await s.send(call.prompt);
  } finally {
    s.close();
  }
}

export function writeSystemPrompt(name: string, text: string): string {
  mkdirSync(WORK_DIR, { recursive: true });
  const file = path.join(WORK_DIR, `${name}-${randomUUID()}.txt`);
  writeFileSync(file, text);
  return file;
}


export function addUsage(u: Usage, r: CliResult) {
  u.calls++;
  u.input += r.usage.input;
  u.cacheRead += r.usage.cacheRead;
  u.cacheWrite += r.usage.cacheWrite;
  u.output += r.usage.output;
  u.usd = (u.usd ?? 0) + r.costUsd;
}
