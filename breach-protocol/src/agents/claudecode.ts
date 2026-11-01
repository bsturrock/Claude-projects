import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, Decision, DecisionRequest, Usage } from "../types.js";
import { DECISION_SCHEMA, type Effort } from "./claude.js";

/**
 * Players backed by the Claude Code CLI (`claude -p`) instead of the API. Each player is one
 * persistent Claude Code session, resumed on every decision, so it remembers the whole game.
 * It authenticates with whatever `claude` is logged in as (e.g. a Pro/Max subscription).
 */

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
/** Sessions live in their own directory so no project CLAUDE.md, hooks or settings leak in. */
export const WORK_DIR = path.join(os.tmpdir(), "breach-protocol-agents");
/** Each `claude` process uses real memory; cap how many run at once (votes fan out to every player). */
const MAX_PARALLEL = Number(process.env.BREACH_MAX_PARALLEL ?? 4);

let running = 0;
const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (running >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

export function claudeCliAvailable(): { ok: boolean; version?: string } {
  const r = spawnSync(CLAUDE_BIN, ["--version"], { encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? { ok: true, version: r.stdout.trim() } : { ok: false };
}

/** Environment for child sessions: drop API credentials so the CLI uses the logged-in account. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.env.BREACH_CLI_USE_API_KEY !== "1") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

export interface CliResult {
  output: unknown;
  thinking: string;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  costUsd: number;
}

export interface CliCall {
  prompt: string;
  systemPromptFile: string;
  schema: object;
  model: string;
  effort: Effort;
  /** New session id (first call), or a session to resume. Omit both for a one-shot. */
  sessionId?: string;
  resume?: string;
  timeoutMs?: number;
}

export function runClaude(call: CliCall): Promise<CliResult> {
  mkdirSync(WORK_DIR, { recursive: true });
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", call.model,
    "--effort", call.effort,
    "--system-prompt-file", call.systemPromptFile,
    "--json-schema", JSON.stringify(call.schema),
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  if (call.sessionId) args.push("--session-id", call.sessionId);
  else if (call.resume) args.push("--resume", call.resume);
  else args.push("--no-session-persistence");

  return withSlot(
    () =>
      new Promise<CliResult>((resolve, reject) => {
        const child = spawn(CLAUDE_BIN, args, { cwd: WORK_DIR, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
        let buf = "";
        let stderr = "";
        const thinking: string[] = [];
        let result: Record<string, unknown> | null = null;
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`claude CLI timed out after ${(call.timeoutMs ?? 300000) / 1000}s`));
        }, call.timeoutMs ?? 300000);
        const onLine = (line: string) => {
          if (!line.trim()) return;
          let msg: Record<string, any>;
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          if (msg.type === "assistant") {
            for (const b of msg.message?.content ?? []) if (b.type === "thinking" && b.thinking) thinking.push(b.thinking);
          } else if (msg.type === "result") {
            result = msg;
          }
        };
        child.stdout.on("data", (d: Buffer) => {
          buf += d.toString();
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            onLine(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        });
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`could not start "${CLAUDE_BIN}": ${err.message}. Is Claude Code installed and on PATH?`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (buf) onLine(buf);
          const r = result as Record<string, any> | null;
          if (!r) return reject(new Error(`claude CLI exited ${code} without a result. ${stderr.slice(0, 400)}`));
          if (r.is_error || r.subtype !== "success") {
            return reject(new Error(`claude CLI error (${r.subtype}): ${String(r.result ?? stderr).slice(0, 400)}`));
          }
          let output = r.structured_output;
          if (output === undefined && typeof r.result === "string") {
            try {
              output = JSON.parse(r.result);
            } catch {
              return reject(new Error("claude CLI returned no structured output"));
            }
          }
          const u = r.usage ?? {};
          resolve({
            output,
            thinking: thinking.join("\n").trim(),
            usage: {
              input: u.input_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite: u.cache_creation_input_tokens ?? 0,
              output: u.output_tokens ?? 0,
            },
            costUsd: Number(r.total_cost_usd ?? 0),
          });
        });
        child.stdin.end(call.prompt);
      }),
  );
}

export function writeSystemPrompt(name: string, text: string): string {
  mkdirSync(WORK_DIR, { recursive: true });
  const file = path.join(WORK_DIR, `${name}-${randomUUID()}.txt`);
  writeFileSync(file, text);
  return file;
}

const EMPTY: Decision = { private_reasoning: "", say: "", target: "", vote: "none", card: "none" };

export class ClaudeCodeAgent implements Agent {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  readonly sessionId = randomUUID();
  private started = false;
  private systemPromptFile: string;

  constructor(
    private model: string,
    system: string,
    private effort: Effort,
    playerName: string,
  ) {
    this.systemPromptFile = writeSystemPrompt(playerName, system);
  }

  async decide(req: DecisionRequest, newEvents: string[]): Promise<Decision> {
    const prompt = [
      newEvents.length ? `NEW EVENTS SINCE YOUR LAST TURN:\n${newEvents.map((e) => `- ${e}`).join("\n")}` : "NEW EVENTS: none",
      `\nCURRENT STATUS:\n${req.status}`,
      `\nYOUR DECISION (${req.kind.toUpperCase()}): ${req.instruction}`,
      req.targets ? `Valid targets: ${req.targets.join(", ")}` : "",
      `Answer with the structured output only.`,
    ].join("\n");
    const r = await runClaude({
      prompt,
      systemPromptFile: this.systemPromptFile,
      schema: DECISION_SCHEMA,
      model: this.model,
      effort: this.effort,
      ...(this.started ? { resume: this.sessionId } : { sessionId: this.sessionId }),
    });
    this.started = true;
    this.usage.calls++;
    this.usage.input += r.usage.input;
    this.usage.cacheRead += r.usage.cacheRead;
    this.usage.cacheWrite += r.usage.cacheWrite;
    this.usage.output += r.usage.output;
    this.usage.usd = (this.usage.usd ?? 0) + r.costUsd;
    return { ...EMPTY, ...(r.output as Partial<Decision>), thinking: r.thinking };
  }
}
