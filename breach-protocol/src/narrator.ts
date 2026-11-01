import Anthropic from "@anthropic-ai/sdk";
import { runClaude, writeSystemPrompt } from "./agents/claudecode.js";
import type { GameSummary, Narrator, RoundSummary, Usage } from "./types.js";

const ROUND_SCHEMA = {
  type: "object",
  properties: {
    public_recap: {
      type: "string",
      description: "2-4 sentences on what happened, using only information the players could see. No spoilers.",
    },
    spectator_analysis: {
      type: "string",
      description: "2-4 sentences using the secret information: who lied, who played what, whose read was right or wrong.",
    },
  },
  required: ["public_recap", "spectator_analysis"],
  additionalProperties: false,
} as const;

const GAME_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One punchy line." },
    story: { type: "string", description: "A 1-2 paragraph narrative of the whole game." },
    turning_points: { type: "array", items: { type: "string" }, description: "3-5 key moments, each one sentence, with round numbers." },
    best_play: { type: "string" },
    biggest_mistake: { type: "string" },
    players: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, verdict: { type: "string", description: "One sentence on how they played." } },
        required: ["name", "verdict"],
        additionalProperties: false,
      },
    },
  },
  required: ["headline", "story", "turning_points", "best_play", "biggest_mistake", "players"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are the narrator and analyst for a hidden-role social deduction game called Breach Protocol, played by AI agents.
You receive the full spectator log, including secret information (roles, crate contents, which card each player played, private reasoning, scan results).
Write vivid but accurate recaps. Never invent events that are not in the log. Refer to players by name.`;

/** Separate Claude call that sees the spectator log and writes recaps. It never talks to the players. */
export class ClaudeNarrator implements Narrator {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  constructor(
    private client: Anthropic,
    public model: string,
    private rules: string,
  ) {}

  private async call<T>(prompt: string, schema: object): Promise<T> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: `${SYSTEM}\n\nRULES OF THE GAME:\n${this.rules}`,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort: "low", format: { type: "json_schema", schema: schema as Record<string, unknown> } },
    });
    const u = response.usage;
    this.usage.calls++;
    this.usage.input += u.input_tokens ?? 0;
    this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.usage.output += u.output_tokens ?? 0;
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      throw new Error(`narrator stopped: ${response.stop_reason}`);
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return JSON.parse(text) as T;
  }

  round(log: string) {
    return this.call<RoundSummary>(`Summarize this round.\n\nROUND LOG:\n${log}`, ROUND_SCHEMA);
  }
  game(log: string) {
    return this.call<GameSummary>(`Summarize the whole game.\n\nFULL GAME LOG:\n${log}`, GAME_SCHEMA);
  }
}

/** Template recaps for mock games, so the UI can be exercised without API calls. */
export class MockNarrator implements Narrator {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  model = "mock";
  async round(log: string): Promise<RoundSummary> {
    const lines = log.split("\n");
    const pub = lines.filter((l) => /nominates|Votes:|Mission result|ejects|scans|Emergency/.test(l));
    const secret = lines.filter((l) => l.startsWith("[secret") && /played|handed|Scan result/.test(l));
    return {
      public_recap: pub.join(" ") || "A quiet round.",
      spectator_analysis: secret.map((l) => l.replace(/^\[secret, to [^\]]+\] /, "")).join(" ") || "No secret actions.",
    };
  }
  async game(log: string): Promise<GameSummary> {
    const result = log.split("\n").find((l) => l.startsWith("RESULT:")) ?? "";
    const roles = (log.split("\n")[0] ?? "").replace("FINAL ROLES: ", "").split(", ");
    return {
      headline: result.replace("RESULT: ", ""),
      story: "Mock game: the narrator only writes prose when Claude agents are playing.",
      turning_points: log.split("\n").filter((l) => /Mission result|ejects/.test(l)).slice(0, 5),
      best_play: "-",
      biggest_mistake: "-",
      players: roles.map((r) => ({ name: r.split(":")[0], verdict: r })),
    };
  }
}

/** Narrator backed by one-shot Claude Code CLI calls (no API key; uses the logged-in account). */
export class ClaudeCodeNarrator implements Narrator {
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  private systemPromptFile: string;
  constructor(
    public model: string,
    rules: string,
  ) {
    this.systemPromptFile = writeSystemPrompt("narrator", `${SYSTEM}\n\nRULES OF THE GAME:\n${rules}`);
  }
  private async call<T>(prompt: string, schema: object): Promise<T> {
    const r = await runClaude({ prompt, systemPromptFile: this.systemPromptFile, schema, model: this.model, effort: "low" });
    this.usage.calls++;
    this.usage.input += r.usage.input;
    this.usage.cacheRead += r.usage.cacheRead;
    this.usage.cacheWrite += r.usage.cacheWrite;
    this.usage.output += r.usage.output;
    this.usage.usd = (this.usage.usd ?? 0) + r.costUsd;
    return r.output as T;
  }
  round(log: string) {
    return this.call<RoundSummary>(`Summarize this round.\n\nROUND LOG:\n${log}`, ROUND_SCHEMA);
  }
  game(log: string) {
    return this.call<GameSummary>(`Summarize the whole game.\n\nFULL GAME LOG:\n${log}`, GAME_SCHEMA);
  }
}
