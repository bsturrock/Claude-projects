import Anthropic from "@anthropic-ai/sdk";
import type { Agent, Decision, DecisionRequest, Usage } from "../types.js";

export const DECISION_SCHEMA = {
  type: "object",
  properties: {
    private_reasoning: {
      type: "string",
      description: "Your private reasoning for this decision (1-3 sentences). Never shown to other players.",
    },
    say: {
      type: "string",
      description: "Public message to the table. Empty string to stay silent.",
    },
    target: {
      type: "string",
      description: "Exact player name when the decision needs one (nominee, scan/eject target, or who you are addressing). Otherwise empty.",
    },
    vote: { type: "string", enum: ["yes", "no", "none"] },
    card: { type: "string", enum: ["repair", "breach", "none"] },
  },
  required: ["private_reasoning", "say", "target", "vote", "card"],
  additionalProperties: false,
} as const;

/** Models that accept the server-side `fallbacks: "default"` refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5"]);

const EMPTY: Decision = { private_reasoning: "", say: "", target: "", vote: "none", card: "none" };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * One Claude player. Each agent owns an isolated, append-only conversation, so it only ever
 * sees what the engine delivers to it: public events plus its own private information.
 */
export class ClaudeAgent implements Agent {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  private messages: Anthropic.Beta.BetaMessageParam[] = [];

  constructor(
    private client: Anthropic,
    private model: string,
    private system: string,
    private effort: Effort,
  ) {}

  async decide(req: DecisionRequest, newEvents: string[]): Promise<Decision> {
    const text = [
      newEvents.length ? `NEW EVENTS SINCE YOUR LAST TURN:\n${newEvents.map((e) => `- ${e}`).join("\n")}` : "NEW EVENTS: none",
      `\nCURRENT STATUS:\n${req.status}`,
      `\nYOUR DECISION (${req.kind.toUpperCase()}): ${req.instruction}`,
      req.targets ? `Valid targets: ${req.targets.join(", ")}` : "",
      `Respond with the JSON object only.`,
    ].join("\n");
    this.messages.push({ role: "user", content: text });

    const useFallback = FALLBACK_MODELS.has(this.model);
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: this.system,
      messages: this.messages,
      cache_control: { type: "ephemeral" },
      // "summarized" returns a readable summary of the model's reasoning for the spectator UI.
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: this.effort, format: { type: "json_schema", schema: DECISION_SCHEMA } },
      ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    const u = response.usage;
    this.usage.calls++;
    this.usage.input += u.input_tokens ?? 0;
    this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.usage.output += u.output_tokens ?? 0;

    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      // Drop the unanswered turn so history stays a clean user/assistant alternation.
      this.messages.pop();
      return { ...EMPTY, private_reasoning: `(no decision: ${response.stop_reason})` };
    }

    // Append the full content (thinking blocks included) unchanged: history stays append-only.
    this.messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

    const thinking = response.content
      .filter((b): b is Anthropic.Beta.BetaThinkingBlock => b.type === "thinking")
      .map((b) => b.thinking)
      .join("\n")
      .trim();
    const out = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      return { ...EMPTY, ...(JSON.parse(out) as Decision), thinking };
    } catch {
      return { ...EMPTY, private_reasoning: "(unparseable response)", thinking };
    }
  }
}

export function buildSystemPrompt(rules: string, name: string, persona: string): string {
  return `${rules}

YOU ARE: ${name}. Personality: ${persona}.
Your secret role arrives as a [PRIVATE] event at the start of the game. Play to win for your team.
- Crew: reason carefully from votes, mission results and claims; share honest information.
- Saboteurs and the Infiltrator: deceive convincingly, deflect suspicion, and push the table toward your goals.
Every turn you receive new events, the board status, and one decision to make. Reply with a single JSON object matching the schema.
Fields not used by the current decision should be "" or "none".`;
}
