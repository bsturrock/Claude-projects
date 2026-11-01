import {
  BREACHES_TO_WIN,
  BREACH_POWERS,
  DECK,
  HAND_SIZE,
  INFILTRATOR_DANGER_AT,
  MAX_ROUNDS,
  REPAIRS_TO_WIN,
  REPAIR_POWERS,
  UNREST_LIMIT,
} from "./rules.js";
import type { Agent, Card, Decision, DecisionKind, Player, UiEvent } from "./types.js";

export function shuffle<T>(arr: T[], rng = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface EngineOptions {
  players: Player[];
  agents: Agent[];
  emit: (e: Omit<UiEvent, "seq" | "t">) => void;
  /** Delay after each public speech, for readability. */
  paceMs?: number;
  /** Awaited between steps; lets the server pause / stop the game. */
  gate?: () => Promise<void>;
}

export type Winner = "crew" | "saboteurs" | "none";

export class Game {
  players: Player[];
  agents: Agent[];
  deck: Card[] = shuffle(DECK);
  discard: Card[] = [];
  repairs = 0;
  breaches = 0;
  unrest = 0;
  round = 0;
  captainSeat = -1;
  lastTeam: number[] = []; // [captain, second] of the last approved mission
  winner: Winner | null = null;
  winReason = "";
  phase = "setup";
  current: { captain?: number; second?: number } = {};
  private inbox: string[][];
  private emitRaw: EngineOptions["emit"];
  private paceMs: number;
  private gate: () => Promise<void>;

  constructor(opts: EngineOptions) {
    this.players = opts.players;
    this.agents = opts.agents;
    this.emitRaw = opts.emit;
    this.paceMs = opts.paceMs ?? 0;
    this.gate = opts.gate ?? (async () => {});
    this.inbox = this.players.map(() => []);
  }

  // ---------- helpers ----------
  alive() {
    return this.players.filter((p) => p.alive);
  }
  byName(name: string): Player | undefined {
    const n = name.trim().toLowerCase();
    return this.players.find((p) => p.name.toLowerCase() === n);
  }
  private emit(type: string, to: number[] | null, payload: Record<string, unknown> = {}) {
    this.emitRaw({ type, to, ...payload });
  }
  private snapshot() {
    this.emit("state", null, {
      state: structuredClone({
        round: this.round,
        phase: this.phase,
        repairs: this.repairs,
        breaches: this.breaches,
        unrest: this.unrest,
        deck: this.deck.length,
        discard: this.discard.length,
        captain: this.current.captain ?? null,
        second: this.current.second ?? null,
        lastTeam: this.lastTeam,
        winner: this.winner,
        winReason: this.winReason,
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          role: p.role,
          alive: p.alive,
          hand: p.hand,
          model: p.model,
          usage: this.agents[p.id].usage,
        })),
      }),
    });
  }
  /** Public narration: delivered to every living player's inbox and the UI. */
  private announce(text: string, extra: Record<string, unknown> = {}) {
    for (const p of this.players) if (p.alive) this.inbox[p.id].push(text);
    this.emit("system", null, { text, ...extra });
  }
  /** Private information for one player. */
  private tell(pid: number, text: string, extra: Record<string, unknown> = {}) {
    this.inbox[pid].push(`[PRIVATE] ${text}`);
    this.emit("private", [pid], { text, ...extra });
  }
  private draw(): Card {
    if (this.deck.length === 0) {
      this.deck = shuffle(this.discard);
      this.discard = [];
      this.announce("The discard pile is reshuffled into the deck.");
    }
    return this.deck.pop()!;
  }
  private fillHand(p: Player) {
    while (p.hand.length < HAND_SIZE) p.hand.push(this.draw());
  }

  private statusFor(p: Player): string {
    const alive = this.alive().map((x) => x.name).join(", ");
    const dead = this.players.filter((x) => !x.alive).map((x) => x.name);
    const cap = this.current.captain !== undefined ? this.players[this.current.captain].name : "-";
    const sec = this.current.second !== undefined ? this.players[this.current.second].name : "-";
    return [
      `Round ${this.round} | Repairs ${this.repairs}/${REPAIRS_TO_WIN} | Breaches ${this.breaches}/${BREACHES_TO_WIN} | Unrest ${this.unrest}/${UNREST_LIMIT}`,
      `Captain: ${cap} | Second: ${sec} | Last approved team: ${this.lastTeam.map((i) => this.players[i].name).join(" + ") || "none"}`,
      `Alive (seat order): ${alive}${dead.length ? ` | Ejected: ${dead.join(", ")}` : ""}`,
      `Your hand: ${p.hand.join(", ")}`,
    ].join("\n");
  }

  private async ask(
    pid: number,
    kind: DecisionKind,
    instruction: string,
    targets?: string[],
  ): Promise<Decision> {
    await this.gate();
    const p = this.players[pid];
    const events = this.inbox[pid];
    this.inbox[pid] = [];
    this.emit("thinking", null, { player: pid, kind });
    let d: Decision;
    try {
      d = await this.agents[pid].decide({ kind, instruction, status: this.statusFor(p), targets }, events);
    } catch (err) {
      this.emit("error", null, { player: pid, text: `Agent error (${p.name}): ${String(err)}` });
      d = { private_reasoning: "(agent error, default action)", say: "", target: "", vote: "none", card: "none" };
    }
    this.emit("reasoning", [pid], { player: pid, kind, text: d.private_reasoning });
    return d;
  }

  private say(pid: number, text: string, context: string) {
    const msg = text.trim().slice(0, 600);
    if (!msg) return;
    const name = this.players[pid].name;
    for (const p of this.players) if (p.alive && p.id !== pid) this.inbox[p.id].push(`${name}: "${msg}"`);
    this.inbox[pid].push(`You said: "${msg}"`);
    this.emit("chat", null, { player: pid, text: msg, context });
  }

  private pace() {
    return this.paceMs ? new Promise((r) => setTimeout(r, this.paceMs)) : Promise.resolve();
  }

  // ---------- discussion ----------
  /** Open table talk. Players who speak get re-queued; anyone named in a message jumps the queue. */
  private async discussion(label: string, maxPerPlayer: number, maxMessages: number, instruction: string) {
    this.phase = label;
    this.snapshot();
    const spoken = new Map<number, number>();
    let queue = shuffle(this.alive().map((p) => p.id));
    if (this.current.captain !== undefined) {
      queue = [this.current.captain, ...queue.filter((i) => i !== this.current.captain)];
    }
    let total = 0;
    while (queue.length && total < maxMessages) {
      const pid = queue.shift()!;
      if (!this.players[pid].alive) continue;
      const d = await this.ask(pid, "discuss", instruction);
      if (!d.say.trim()) {
        this.emit("pass", null, { player: pid });
        continue;
      }
      this.say(pid, d.say, label);
      total++;
      const n = (spoken.get(pid) ?? 0) + 1;
      spoken.set(pid, n);
      // Whoever is addressed (target field, or named in the text) gets to respond next.
      const named = this.alive()
        .filter((p) => p.id !== pid && (p.name === d.target || new RegExp(`\\b${p.name}\\b`).test(d.say)))
        .map((p) => p.id)
        .filter((id) => (spoken.get(id) ?? 0) < maxPerPlayer);
      queue = [...named, ...queue.filter((id) => !named.includes(id))];
      if (n < maxPerPlayer && !queue.includes(pid)) queue.push(pid);
      await this.pace();
    }
  }

  // ---------- main loop ----------
  async run(): Promise<Winner> {
    this.setup();
    while (!this.winner && this.round < MAX_ROUNDS) {
      await this.playRound();
    }
    if (!this.winner) this.end("none", `No winner after ${MAX_ROUNDS} rounds.`);
    return this.winner!;
  }

  private setup() {
    const sabs = this.players.filter((p) => p.role === "saboteur");
    const inf = this.players.find((p) => p.role === "infiltrator")!;
    for (const p of this.players) this.fillHand(p);
    this.announce(
      `Welcome aboard Meridian. Seat order: ${this.players.map((p) => p.name).join(", ")}. ` +
        `There are ${sabs.length} Saboteur(s) plus 1 Infiltrator among the ${this.players.length} of you.`,
    );
    for (const p of this.players) {
      if (p.role === "crew") this.tell(p.id, "Your role: CREW. You do not know who anyone else is.");
      if (p.role === "infiltrator")
        this.tell(p.id, "Your role: INFILTRATOR (Saboteur team). You do not know who the Saboteurs are, but they know you.");
      if (p.role === "saboteur") {
        const others = sabs.filter((s) => s.id !== p.id).map((s) => s.name);
        this.tell(
          p.id,
          `Your role: SABOTEUR. The Infiltrator is ${inf.name}.` +
            (others.length ? ` Your fellow Saboteur(s): ${others.join(", ")}.` : " You are the only regular Saboteur."),
        );
      }
    }
    this.captainSeat = Math.floor(Math.random() * this.players.length) - 1;
    this.snapshot();
  }

  private nextCaptain(): number {
    for (let k = 1; k <= this.players.length; k++) {
      const seat = (this.captainSeat + k + this.players.length) % this.players.length;
      if (this.players[seat].alive) {
        this.captainSeat = seat;
        return seat;
      }
    }
    throw new Error("no living players");
  }

  private eligibleSeconds(captain: number): Player[] {
    const barred = this.alive().length > 5 ? this.lastTeam : this.lastTeam.slice(1);
    return this.alive().filter((p) => p.id !== captain && !barred.includes(p.id));
  }

  private async playRound() {
    this.round++;
    const captain = this.nextCaptain();
    this.current = { captain };
    const cap = this.players[captain];
    this.emit("round", null, { round: this.round, captain });
    this.announce(`--- Round ${this.round}. ${cap.name} is Captain. ---`);

    await this.discussion(
      "briefing",
      2,
      this.alive().length * 2,
      `BRIEFING. Open discussion before ${cap.name} nominates a Second. Speak if you have something useful (accuse, defend, share or claim info, suggest a nominee), or leave "say" empty to stay quiet.`,
    );
    if (this.winner) return;

    // Nomination
    this.phase = "nomination";
    this.snapshot();
    const eligible = this.eligibleSeconds(captain);
    const names = eligible.map((p) => p.name);
    const nd = await this.ask(
      captain,
      "nominate",
      `You are Captain. Nominate your Second. Put their exact name in "target". Eligible: ${names.join(", ")}. Use "say" to justify your pick publicly.`,
      names,
    );
    let second = this.byName(nd.target);
    if (!second || !eligible.includes(second)) {
      second = eligible[Math.floor(Math.random() * eligible.length)];
      this.emit("error", null, { player: captain, text: `Invalid nominee "${nd.target}", picked ${second.name} at random.` });
    }
    this.current.second = second.id;
    this.announce(`${cap.name} nominates ${second.name} as Second.`, { kind: "nominate", captain, second: second.id });
    if (nd.say.trim()) this.say(captain, nd.say, "nomination");
    this.snapshot();

    await this.discussion(
      "debate",
      1,
      this.alive().length,
      `DEBATE. ${cap.name} has nominated ${second.name} as Second. Argue for or against this team before the vote, or leave "say" empty.`,
    );

    // Vote
    this.phase = "vote";
    this.snapshot();
    const voters = this.alive();
    const ballots = await Promise.all(
      voters.map((p) =>
        this.ask(
          p.id,
          "vote",
          `VOTE on the team Captain ${cap.name} + Second ${second!.name}. Set "vote" to "yes" or "no". Leave "say" empty (votes are silent).`,
        ),
      ),
    );
    const votes: Record<number, "yes" | "no"> = {};
    voters.forEach((p, i) => (votes[p.id] = ballots[i].vote === "yes" ? "yes" : "no"));
    const yes = Object.values(votes).filter((v) => v === "yes").length;
    const passed = yes > voters.length / 2;
    this.announce(
      `Votes: ${voters.map((p) => `${p.name} ${votes[p.id].toUpperCase()}`).join(", ")}. ` +
        `${passed ? "Team APPROVED" : "Team REJECTED"} (${yes}-${voters.length - yes}).`,
      { kind: "votes", votes, passed },
    );

    if (!passed) {
      this.unrest++;
      this.announce(`Unrest rises to ${this.unrest}/${UNREST_LIMIT}.`);
      if (this.unrest >= UNREST_LIMIT) {
        const card = this.draw();
        this.discard.push(card);
        this.unrest = 0;
        this.lastTeam = [];
        this.announce(`UNREST LIMIT. Emergency protocol logs the top card of the deck: ${card.toUpperCase()}. Nomination limits clear.`, {
          kind: "auto",
          card,
        });
        this.log(card, false);
      }
      this.current = {};
      this.snapshot();
      return;
    }

    this.unrest = 0;
    this.lastTeam = [captain, second.id];
    if (this.breaches >= INFILTRATOR_DANGER_AT && (cap.role === "infiltrator" || second.role === "infiltrator")) {
      const inf = cap.role === "infiltrator" ? cap : second;
      this.end("saboteurs", `${inf.name} was the Infiltrator and reached the core after ${this.breaches} Breaches.`);
      return;
    }

    // Mission
    this.phase = "mission";
    this.snapshot();
    const team = [cap, second];
    const plays = await Promise.all(
      team.map((p) =>
        this.ask(
          p.id,
          "play_card",
          `MISSION. You are on the team. Your hand: ${p.hand.join(", ")}. Set "card" to the card you play ("repair" or "breach"); it must be in your hand. Leave "say" empty.`,
        ),
      ),
    );
    const played: Card[] = team.map((p, i) => {
      let c = plays[i].card as Card;
      if (!p.hand.includes(c)) {
        c = p.hand[0];
        this.emit("error", null, { player: p.id, text: `${p.name} chose a card not in hand; played ${c}.` });
      }
      p.hand.splice(p.hand.indexOf(c), 1);
      this.emit("played", [p.id], { player: p.id, card: c });
      return c;
    });
    for (const c of played) this.discard.push(c);
    for (const p of team) this.fillHand(p);
    const nBreach = played.filter((c) => c === "breach").length;
    const result: Card = nBreach > 0 ? "breach" : "repair";
    this.announce(
      `Mission result: ${shuffle(played).map((c) => c.toUpperCase()).join(" + ")} -> ${result.toUpperCase()} logged (${nBreach} Breach card${nBreach === 1 ? "" : "s"}).`,
      { kind: "mission", cards: shuffle(played), result },
    );
    for (const p of team) this.tell(p.id, `You played ${played[team.indexOf(p)]}. Your hand is now: ${p.hand.join(", ")}.`);
    const power = this.log(result, true);
    this.snapshot();
    if (this.winner) return;

    // Debrief
    this.phase = "debrief";
    for (const p of team) {
      const d = await this.ask(
        p.id,
        "debrief",
        `DEBRIEF. Make your public statement about the mission (what you held / played, what you think happened). You may lie.`,
      );
      this.say(p.id, d.say || "No comment.", "debrief");
      await this.pace();
    }

    if (power) await this.usePower(captain, power);
    this.current = {};
    this.snapshot();
  }

  /** Record a logged card; returns the power the Captain earns, if any. */
  private log(card: Card, powersActive: boolean): "scan" | "eject" | undefined {
    if (card === "repair") this.repairs++;
    else this.breaches++;
    if (this.repairs >= REPAIRS_TO_WIN) this.end("crew", `${REPAIRS_TO_WIN} Repairs logged. The station is saved.`);
    else if (this.breaches >= BREACHES_TO_WIN) this.end("saboteurs", `${BREACHES_TO_WIN} Breaches logged. The station is lost.`);
    if (!powersActive || this.winner) return undefined;
    return card === "breach" ? BREACH_POWERS[this.breaches] : REPAIR_POWERS[this.repairs];
  }

  private async usePower(captain: number, power: "scan" | "eject") {
    this.phase = power;
    this.snapshot();
    const cap = this.players[captain];
    const targets = this.alive().filter((p) => p.id !== captain);
    const names = targets.map((p) => p.name);
    this.announce(`${cap.name} gains the ${power.toUpperCase()} power.`);
    const d = await this.ask(
      captain,
      power,
      power === "scan"
        ? `POWER: SCAN. Choose one player to learn their team privately. Put their exact name in "target". Options: ${names.join(", ")}. Leave "say" empty; you can share (or lie about) the result later.`
        : `POWER: EJECT. Choose one player to remove from the game. Put their exact name in "target". Options: ${names.join(", ")}. Use "say" to explain your choice publicly.`,
      names,
    );
    let t = this.byName(d.target);
    if (!t || !targets.includes(t)) {
      t = targets[Math.floor(Math.random() * targets.length)];
      this.emit("error", null, { player: captain, text: `Invalid target "${d.target}", picked ${t.name} at random.` });
    }
    if (power === "scan") {
      const team = t.role === "crew" ? "CREW" : "SABOTEUR";
      this.announce(`${cap.name} scans ${t.name}.`, { kind: "scan", captain, target: t.id });
      this.tell(captain, `Scan result: ${t.name} is on the ${team} team.`);
      if (d.say.trim()) this.say(captain, d.say, "power");
    } else {
      if (d.say.trim()) this.say(captain, d.say, "power");
      t.alive = false;
      this.announce(`${cap.name} ejects ${t.name} from the station.`, { kind: "eject", captain, target: t.id });
      if (t.role === "infiltrator") this.end("crew", `${t.name} was the Infiltrator. The crew wins.`);
      else this.announce(`${t.name} was not the Infiltrator.`);
    }
    this.snapshot();
  }

  private end(w: Winner, reason: string) {
    if (this.winner) return;
    this.winner = w;
    this.winReason = reason;
    this.phase = "over";
    this.announce(`GAME OVER. ${w === "crew" ? "CREW WINS" : w === "saboteurs" ? "SABOTEURS WIN" : "DRAW"}. ${reason}`);
    this.emit("gameover", null, {
      winner: w,
      reason,
      roles: this.players.map((p) => ({ name: p.name, role: p.role })),
    });
    this.snapshot();
  }
}
