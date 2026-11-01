import Anthropic from "@anthropic-ai/sdk";
import { emptyDecision, type Agent, type Decision, type DecisionRequest, type Usage } from "../types.js";
import { addUsage, runClaude, writeSystemPrompt, type Effort } from "./cli.js";

export const DECISION_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "Your private reasoning for this decision (a few sentences). Only you see it." },
    team_message: { type: "string", description: "Message to your team's private channel, or empty." },
    public_message: { type: "string", description: "Message everyone reads, or empty." },
    embassy: {
      type: "array",
      description: "Private messages to other teams (each goes to all three agents of that team, and your teammates see it).",
      items: {
        type: "object",
        properties: { team: { type: "string", description: "Team id" }, message: { type: "string" } },
        required: ["team", "message"],
        additionalProperties: false,
      },
    },
    orders: { type: "array", items: { type: "string" }, description: "Orders, one per string. Empty in the council phase." },
    notes: {
      type: "string",
      description: "Your private scratchpad, shown back to you next decision (plans, promises made, suspicions). Under 150 words. This is your only memory between decisions.",
    },
  },
  required: ["reasoning", "team_message", "public_message", "embassy", "orders", "notes"],
  additionalProperties: false,
} as const;

/** One call that returns JSON for an arbitrary schema; used by game agents and by debriefs. */
export interface Completer {
  usage: Usage;
  complete(system: string, prompt: string, schema: object, label: string): Promise<{ output: any; thinking: string }>;
}

export class CliCompleter implements Completer {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  private promptFiles = new Map<string, string>();
  constructor(
    private model: string,
    private effort: Effort,
  ) {}
  async complete(system: string, prompt: string, schema: object, label: string) {
    let file = this.promptFiles.get(system);
    if (!file) {
      file = writeSystemPrompt(label, system);
      this.promptFiles.set(system, file);
    }
    const r = await runClaude({ prompt, systemPromptFile: file, schema, model: this.model, effort: this.effort });
    addUsage(this.usage, r);
    return { output: r.output, thinking: r.thinking };
  }
}

/** Models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export class ApiCompleter implements Completer {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  constructor(
    private client: Anthropic,
    private model: string,
    private effort: Effort,
  ) {}
  async complete(system: string, prompt: string, schema: object) {
    const useFallback = FALLBACK_MODELS.has(this.model);
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: this.effort, format: { type: "json_schema", schema } },
      ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    } as any);
    const u = response.usage;
    this.usage.calls++;
    this.usage.input += u.input_tokens ?? 0;
    this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.usage.output += u.output_tokens ?? 0;
    const thinking = response.content
      .filter((b: any) => b.type === "thinking")
      .map((b: any) => b.thinking)
      .join("\n");
    const text = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") throw new Error(`no answer: ${response.stop_reason}`);
    return { output: JSON.parse(text), thinking };
  }
}

export function agentSystemPrompt(rules: string, agentId: string, teamName: string, playbook: string, memory: string): string {
  return `${rules}

=====
YOU ARE ${agentId}, one of three permanent members of team ${teamName}. You and your two teammates play many games of Shardlands together, against other permanent teams. Your team keeps a shared PLAYBOOK that you rewrite together after each game, and you keep personal MEMORY notes. Use them, test them, and improve them: the goal is for your team to get better over many games.

TEAM PLAYBOOK (written by your team after earlier games):
${playbook.trim() || "(empty: this is your team's first game. Work out your own approach.)"}

YOUR PERSONAL MEMORY:
${memory.trim() || "(empty)"}

Each decision you receive your current observation and answer with one JSON object. Every decision is a fresh call: anything you want to remember during this game must go in "notes".`;
}

/** A game player backed by any Completer. Stateless: each decision sends the full observation. */
export class LlmAgent implements Agent {
  constructor(
    private completer: Completer,
    private system: string,
    private label: string,
  ) {}
  get usage() {
    return this.completer.usage;
  }
  async decide(req: DecisionRequest): Promise<Decision> {
    const prompt = `${req.observation}\n\nAnswer with the JSON object only.`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { output, thinking } = await this.completer.complete(this.system, prompt, DECISION_SCHEMA, this.label);
        const d = { ...emptyDecision(), ...(output as Partial<Decision>), thinking };
        if (!Array.isArray(d.orders)) d.orders = [];
        if (!Array.isArray(d.embassy)) d.embassy = [];
        if (req.phase === "council") d.orders = [];
        return d;
      } catch (err) {
        lastErr = err;
      }
    }
    return { ...emptyDecision(), reasoning: `(no decision: ${String(lastErr).slice(0, 200)})` };
  }
}
