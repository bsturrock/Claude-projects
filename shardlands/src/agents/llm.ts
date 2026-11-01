import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandReference } from "../commands/index.js";
import { splitArgs } from "../commands/types.js";
import { emptyDecision, type Agent, type Decision, type DecisionRequest, type Usage } from "../types.js";
import { addUsage, runClaude, writeSystemPrompt, type Effort } from "./cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Directory holding the `shard` executable; prepended to PATH for Claude Code agents. */
export const SHARD_BIN_DIR = path.join(here, "..", "..", "bin");

/** How an LLM agent acts: "cli" = runs the shard CLI as a tool; "json" = returns one JSON answer per phase (cheaper). */
export type AgentInterface = "cli" | "json";

export function agentSystemPrompt(rules: string, agentId: string, teamName: string, teamSize: number, playbook: string, memory: string, iface: AgentInterface): string {
  const howTo =
    iface === "cli"
      ? `HOW YOU PLAY
You act only through the \`shard\` command-line tool, which you run with your Bash tool (only commands starting with "shard" are allowed). Each phase you get a briefing; then:
- you can look things up (shard map, shard tile 2,-3, shard path u5 0,0, shard sites u3, shard techs, shard rules combat),
- queue orders (ORDERS phase only), send messages (shard say team|public "..."), and save notes (shard notes "..."),
- end the phase with \`shard done\`. Your final reply is kept as your private reasoning for this phase.
Each command's reply says at once whether it was accepted. Several commands can run in one call: shard do "build soldier s3" "move u7 2,-1".

COMMANDS
${commandReference()}`
      : `HOW YOU PLAY
Each phase you get a briefing and answer with one JSON object. "orders" holds shard command lines without the "shard" prefix (e.g. "move u3 2,-1", "build soldier s4"); they are queued in order and checked like CLI commands. Orders are ignored in the COUNCIL phase.

COMMANDS
${commandReference()}`;
  return `${rules}

=====
YOU ARE ${agentId}, one of ${teamSize} permanent members of team ${teamName}. Your team plays many games against different opponent teams. Your team has a shared PLAYBOOK that any of you can rewrite after each game, and you have a personal MEMORY that only you read and write.

TEAM PLAYBOOK:
${playbook.trim() || "(empty: this is your team's first game. Work out your own approach.)"}

YOUR PERSONAL MEMORY:
${memory.trim() || "(empty)"}

${howTo}

Every phase is a fresh start: anything you want to remember later in this game must go in your notes.`;
}

function phaseInstructions(req: DecisionRequest, iface: AgentInterface): string {
  if (iface === "json")
    return req.phase === "council"
      ? `COUNCIL PHASE: messages only (team_message is private to your team; public_message is also read by the enemy). Leave "orders" empty. Answer with the JSON object only.`
      : `ORDERS PHASE: list this turn's orders. Units with standing move orders keep moving without new orders. Messages you send now arrive next turn. Answer with the JSON object only.`;
  return req.phase === "council"
    ? `COUNCIL PHASE: messages only (shard say team "..." is private to your team; shard say public "..." is also read by the enemy). Orders are not accepted in this phase. End with: shard done`
    : `ORDERS PHASE: queue this turn's orders. Units with standing move orders keep moving without new orders. Messages sent now arrive next turn. End with: shard done`;
}

// ---------- JSON mode (one structured answer per phase) ----------

export const DECISION_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "Your private reasoning for this decision (a few sentences)." },
    team_message: { type: "string", description: "Message to your team's private channel, or empty." },
    public_message: { type: "string", description: "Message both teams read, or empty." },
    orders: { type: "array", items: { type: "string" }, description: 'shard command lines without the "shard" prefix. Empty in the council phase.' },
    notes: { type: "string", description: "Your private notes, shown back to you next decision. Under 150 words." },
  },
  required: ["reasoning", "team_message", "public_message", "orders", "notes"],
  additionalProperties: false,
} as const;

/** One call that returns JSON for a schema; used by JSON-mode agents and debriefs. */
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
    if (!file) this.promptFiles.set(system, (file = writeSystemPrompt(label, system)));
    const r = await runClaude({ prompt, systemPromptFile: file, schema, model: this.model, effort: this.effort });
    addUsage(this.usage, r);
    return { output: r.output, thinking: r.thinking };
  }
}

/** Models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
const fallbackParams = (model: string) => (FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {});

function addApiUsage(u: Usage, r: Anthropic.Beta.BetaUsage) {
  u.calls++;
  u.input += r.input_tokens ?? 0;
  u.cacheRead += r.cache_read_input_tokens ?? 0;
  u.cacheWrite += r.cache_creation_input_tokens ?? 0;
  u.output += r.output_tokens ?? 0;
}

export class ApiCompleter implements Completer {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  constructor(
    private client: Anthropic,
    private model: string,
    private effort: Effort,
  ) {}
  async complete(system: string, prompt: string, schema: object) {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: this.effort, format: { type: "json_schema", schema } },
      ...fallbackParams(this.model),
    } as any);
    addApiUsage(this.usage, response.usage);
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") throw new Error(`no answer: ${response.stop_reason}`);
    const thinking = response.content.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking).join("\n");
    const text = response.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    return { output: JSON.parse(text), thinking };
  }
}

/** JSON-mode player: one structured answer per phase; its order lines go through the command layer. */
export class JsonAgent implements Agent {
  constructor(
    private completer: Completer,
    private system: string,
    private label: string,
  ) {}
  get usage() {
    return this.completer.usage;
  }
  async decide(req: DecisionRequest): Promise<Decision> {
    const prompt = `${req.observation}\n\n${phaseInstructions(req, "json")}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { output, thinking } = await this.completer.complete(this.system, prompt, DECISION_SCHEMA, this.label);
        const d = { ...emptyDecision(), ...(output as Partial<Decision>), thinking };
        if (!Array.isArray(d.orders)) d.orders = [];
        return d;
      } catch (err) {
        lastErr = err;
      }
    }
    return { ...emptyDecision(), reasoning: `(no decision: ${String(lastErr).slice(0, 200)})` };
  }
}

// ---------- CLI mode: Claude Code runs the real `shard` executable ----------

/**
 * A Claude Code process per phase with only one tool: Bash, restricted to `shard ...`
 * (anything else is denied). The process talks to this match's turn server as this agent.
 */
export class ClaudeCodeCliAgent implements Agent {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  private promptFile: string;
  constructor(
    private model: string,
    private effort: Effort,
    system: string,
    label: string,
  ) {
    this.promptFile = writeSystemPrompt(label, system);
  }
  async decide(req: DecisionRequest): Promise<Decision> {
    const ep = req.session.endpoint;
    if (!ep) throw new Error("no turn server endpoint");
    const r = await runClaude({
      prompt: `${req.observation}\n\n${phaseInstructions(req, "cli")}`,
      systemPromptFile: this.promptFile,
      model: this.model,
      effort: this.effort,
      tools: { enable: ["Bash"], allow: ["Bash(shard:*)"] },
      env: { SHARD_URL: ep.url, SHARD_TOKEN: ep.token, PATH: `${SHARD_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    addUsage(this.usage, r);
    return { ...emptyDecision(), reasoning: String(r.output ?? "").trim(), thinking: r.thinking };
  }
}

// ---------- CLI mode over the API: the same commands as a `shard` tool ----------

const SHARD_TOOL = {
  name: "shard",
  description:
    'Run one Shardlands command, exactly as on the shard command line but without the word "shard". Examples: "help", "map 0,-3 3", "build soldier s3", "move u7 2,-1", "say team \\"I take the east\\"", "done". Returns the command\'s output.',
  input_schema: {
    type: "object" as const,
    properties: { command: { type: "string", description: "The command line, e.g. move u7 2,-1" } },
    required: ["command"],
    additionalProperties: false,
  },
  strict: true,
};

export class ApiCliAgent implements Agent {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  constructor(
    private client: Anthropic,
    private model: string,
    private effort: Effort,
    private system: string,
    private maxSteps = 25,
  ) {}
  async decide(req: DecisionRequest): Promise<Decision> {
    const s = req.session;
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: `${req.observation}\n\n${phaseInstructions(req, "cli").replace(/shard done/g, "done").replace(/shard /g, "")}\n(Use the shard tool for every command.)` },
    ];
    const thinking: string[] = [];
    let finalText = "";
    for (let step = 0; step < this.maxSteps && !s.done; step++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        tools: [SHARD_TOOL],
        messages,
        cache_control: { type: "ephemeral" },
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: this.effort },
        ...fallbackParams(this.model),
      } as any);
      addApiUsage(this.usage, response.usage);
      for (const b of response.content as any[]) {
        if (b.type === "thinking" && b.thinking) thinking.push(b.thinking);
        if (b.type === "text") finalText = b.text;
      }
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") break;
      messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
      const uses = (response.content as any[]).filter((b) => b.type === "tool_use");
      if (!uses.length) break;
      messages.push({
        role: "user",
        content: uses.map((u) => {
          const cmd = typeof u.input?.command === "string" ? u.input.command : "";
          return { type: "tool_result" as const, tool_use_id: u.id, content: cmd ? s.exec(splitArgs(cmd)) : "error: missing command" };
        }),
      });
    }
    return { ...emptyDecision(), reasoning: finalText.trim(), thinking: thinking.join("\n") };
  }
}
