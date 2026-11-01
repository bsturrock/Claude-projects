import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AgentSession } from "./session.js";

/**
 * Local HTTP endpoint behind the `shard` CLI. Each agent process gets its own one-phase token
 * in SHARD_TOKEN, so it can only act as itself, and only during the current phase.
 */
export class TurnServer {
  private server: Server;
  private sessions = new Map<string, AgentSession>();
  url = "";

  constructor() {
    this.server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/exec") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const c of req) body += c;
      let out = "";
      let code = 0;
      try {
        const { token, argv } = JSON.parse(body) as { token: string; argv: string[] };
        const s = this.sessions.get(token);
        if (!s) {
          out = "shard: this phase is over (or the token is invalid). Stop and wait for the next turn.";
          code = 3;
        } else out = s.exec(Array.isArray(argv) ? argv.map(String) : []);
      } catch (err) {
        out = `shard: bad request (${String(err)})`;
        code = 2;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ out, code }));
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    return this.url;
  }

  /** Registers a session for the current phase and returns its token. */
  open(s: AgentSession): string {
    const token = randomBytes(18).toString("hex");
    this.sessions.set(token, s);
    return token;
  }

  /** Invalidates every token (end of phase). */
  closeAll() {
    this.sessions.clear();
  }

  stop() {
    this.sessions.clear();
    this.server.close();
  }
}
