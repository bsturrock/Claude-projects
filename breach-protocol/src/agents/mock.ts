import type { Agent, Decision, DecisionRequest, Player, Usage } from "../types.js";

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

const LINES = {
  crew: [
    "I played Repair last time I was out. Watch who keeps landing on Breach teams.",
    "{t}, your votes have been odd. Explain yourself.",
    "I'd trust {t} with the next mission.",
    "Two breach cards means two liars, or one very unlucky hand.",
  ],
  sab: [
    "I don't trust {t}. Something about their last debrief felt rehearsed.",
    "Let's not panic. One breach can be bad luck with the deck.",
    "{t} seems solid to me, I'd back them.",
    "I'm Crew, for what it's worth. Scan me if you want.",
  ],
};

/** Heuristic bot used for offline testing and for demoing the UI without API calls. */
export class MockAgent implements Agent {
  static delayMs = 30;
  usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
  constructor(private self: Player, private all: Player[]) {}

  async decide(req: DecisionRequest): Promise<Decision> {
    this.usage.calls++;
    await new Promise((r) => setTimeout(r, MockAgent.delayMs));
    const evil = this.self.role !== "crew";
    const others = this.all.filter((p) => p.alive && p.id !== this.self.id).map((p) => p.name);
    const d: Decision = { private_reasoning: "", say: "", target: "", vote: "none", card: "none" };
    switch (req.kind) {
      case "discuss":
        if (Math.random() < 0.55) {
          const t = pick(others);
          d.say = pick(evil ? LINES.sab : LINES.crew).replace("{t}", t);
          d.target = t;
        }
        d.private_reasoning = evil ? "Keep blending in." : "Looking for inconsistent stories.";
        break;
      case "nominate":
      case "scan":
      case "eject": {
        const opts = req.targets ?? others;
        const friendly = this.all.filter((p) => opts.includes(p.name) && (p.role === "crew") !== evil);
        d.target = (req.kind === "nominate" && friendly.length ? pick(friendly) : pick(this.all.filter((p) => opts.includes(p.name)))).name;
        if (req.kind !== "scan") d.say = `I'm going with ${d.target}.`;
        d.private_reasoning = `Chose ${d.target}.`;
        break;
      }
      case "vote":
        d.vote = Math.random() < (evil ? 0.6 : 0.65) ? "yes" : "no";
        break;
      case "play_card":
        d.card = evil && this.self.hand.includes("breach") && Math.random() < 0.8 ? "breach" : this.self.hand.includes("repair") ? "repair" : "breach";
        d.private_reasoning = `Playing ${d.card}.`;
        break;
      case "debrief":
        d.say = evil ? "I played a Repair. Not sure about my partner." : `I played ${this.self.hand.includes("repair") ? "Repair" : "what I could"}.`;
        break;
    }
    return d;
  }
}
