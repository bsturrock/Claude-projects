import { runCommand } from "./commands/index.js";
import type { QueuedOrder } from "./commands/types.js";
import type { Engine } from "./engine.js";
import type { ObsContext } from "./observe.js";

export interface SessionLimits {
  /** Max commands per phase, to stop runaway loops. */
  commands: number;
  /** Max messages per phase. */
  messages: number;
  /** Max characters per message. */
  messageChars: number;
  /** Max characters of notes. */
  notesChars: number;
}

export const DEFAULT_LIMITS: SessionLimits = { commands: 60, messages: 4, messageChars: 1000, notesChars: 1500 };

/**
 * One agent's live connection to the game for one phase. Every way of acting (the `shard`
 * CLI over HTTP, the API tool loop, JSON agents and mock bots) goes through exec(), so they all
 * see the same commands, checks and messages.
 */
export class AgentSession {
  queue: QueuedOrder[] = [];
  said: { channel: string; text: string }[] = [];
  done = false;
  transcript: { cmd: string; out: string }[] = [];
  notes: string;
  commands = 0;
  /** Where the `shard` CLI reaches this session (set by the match). */
  endpoint?: { url: string; token: string };

  constructor(
    public eng: Engine,
    public agent: string,
    public phase: "council" | "orders",
    public ctx: ObsContext,
    public limits: SessionLimits = DEFAULT_LIMITS,
  ) {
    this.notes = ctx.notes;
  }

  get team() {
    return this.eng.teamOf(this.agent);
  }

  /** Runs one command line (already split into words) and returns what the CLI prints. */
  exec(argv: string[], nested = false): string {
    this.commands++;
    let out: string;
    if (this.commands > this.limits.commands) out = `Command limit for this phase reached (${this.limits.commands}). Run "shard done".`;
    else {
      try {
        out = runCommand(this, argv);
      } catch (err) {
        out = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (!nested) this.transcript.push({ cmd: argv.join(" "), out });
    return out;
  }
}
