import type { Ruleset } from "./ruleset.js";
import type { Agent, Card, Decision, DecisionKind, GameSummary, Narrator, Player, UiEvent } from "./types.js";

export function shuffle<T>(arr: T[], rng = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface EngineOptions {
  rules: Ruleset;
  players: Player[];
  agents: Agent[];
  narrator?: Narrator;
  emit: (e: Omit<UiEvent, "seq" | "t">) => void;
  /** Delay after each public speech, for readability. */
  paceMs?: number;
  /** Awaited between steps; lets the server pause / stop the game. */
  gate?: () => Promise<void>;
}

export type Winner = "crew" | "saboteurs" | "none";

/** Structured facts about one round, for the Rounds tab and the narrator. */
export interface RoundFacts {
  round: number;
  captain: number;
  second?: number;
  votes?: Record<number, "yes" | "no">;
  approved?: boolean;
  crate?: Card[];
  handed?: Card;
  secondDrew?: Card[];
  played?: { player: number; card: Card }[];
  result?: Card;
  auto?: Card;
  power?: { kind: "scan" | "eject"; target: number };
}

export class Game {
  rs: Ruleset;
  players: Player[];
  agents: Agent[];
  narrator?: Narrator;
  deck: Card[];
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
  facts: RoundFacts[] = [];
  /** Public record of every round, given to agents once per round so they don't have to recall it. */
  private record: string[] = [];
  private recordSeen: number[];
  /** Spectator-view log (everything, including secrets) for the narrator. */
  private roundLog: string[] = [];
  private gameLog: string[] = [];
  private summaries: Promise<void>[] = [];
  gameSummary: GameSummary | null = null;
  private inbox: string[][];
  private emitRaw: EngineOptions["emit"];
  private paceMs: number;
  private gate: () => Promise<void>;

  constructor(opts: EngineOptions) {
    this.rs = opts.rules;
    this.players = opts.players;
    this.agents = opts.agents;
    this.narrator = opts.narrator;
    this.emitRaw = opts.emit;
    this.paceMs = opts.paceMs ?? 0;
    this.gate = opts.gate ?? (async () => {});
    this.inbox = this.players.map(() => []);
    this.recordSeen = this.players.map(() => -1);
    this.deck = shuffle([
      ...Array<Card>(this.rs.deck.repair).fill("repair"),
      ...Array<Card>(this.rs.deck.breach).fill("breach"),
    ]);
  }

  // ---------- helpers ----------
  alive() {
    return this.players.filter((p) => p.alive);
  }
  name(id: number) {
    return this.players[id].name;
  }
  byName(name: string): Player | undefined {
    const n = name.trim().toLowerCase();
    return this.players.find((p) => p.name.toLowerCase() === n);
  }
  private emit(type: string, to: number[] | null, payload: Record<string, unknown> = {}) {
    this.emitRaw({ type, to, round: this.round, ...payload });
    const line = this.logLine(type, to, payload);
    if (line) {
      this.roundLog.push(line);
      this.gameLog.push(line);
    }
  }
  private logLine(type: string, to: number[] | null, p: Record<string, unknown>): string | null {
    const who = (k: string) => this.name(p[k] as number);
    switch (type) {
      case "system":
        return String(p.text);
      case "private":
        return `[secret, to ${to!.map((i) => this.name(i)).join(", ")}] ${p.text}`;
      case "chat":
        return `${who("player")} (${p.context}): "${p.text}"`;
      case "reasoning":
        return p.text ? `[${who("player")} privately, ${p.kind}] ${p.text}` : null;
      case "error":
        return `[engine] ${p.text}`;
      default:
        return null;
    }
  }
  private snapshot() {
    this.emit("state", null, {
      state: structuredClone({
        ruleset: this.rs.name,
        rules: {
          repairsToWin: this.rs.repairsToWin,
          breachesToWin: this.rs.breachesToWin,
          unrestLimit: this.rs.unrestLimit,
          infiltratorDangerAt: this.rs.infiltratorDangerAt,
          breachPowers: this.rs.breachPowers,
          repairPowers: this.rs.repairPowers,
        },
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
        narrator: this.narrator ? { model: this.narrator.model, usage: this.narrator.usage } : null,
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
    while (p.hand.length < this.rs.handSize) p.hand.push(this.draw());
  }

  private statusFor(p: Player): string {
    const rs = this.rs;
    const alive = this.alive().map((x) => x.name).join(", ");
    const dead = this.players.filter((x) => !x.alive).map((x) => x.name);
    const cap = this.current.captain !== undefined ? this.name(this.current.captain) : "-";
    const sec = this.current.second !== undefined ? this.name(this.current.second) : "-";
    const lines = [
      `Round ${this.round} | Repairs ${this.repairs}/${rs.repairsToWin} | Breaches ${this.breaches}/${rs.breachesToWin} | Unrest ${this.unrest}/${rs.unrestLimit}`,
      `Captain: ${cap} | Second: ${sec} | Last approved team: ${this.lastTeam.map((i) => this.name(i)).join(" + ") || "none"}`,
      `Alive (seat order): ${alive}${dead.length ? ` | Ejected: ${dead.join(", ")}` : ""}`,
    ];
    if (this.rs.handSize > 0) lines.push(`Your hand: ${p.hand.join(", ")}`);
    // The full public record is sent once per round per player, to keep histories compact.
    if (this.recordSeen[p.id] < this.round && this.record.length) {
      this.recordSeen[p.id] = this.round;
      lines.push(`PUBLIC RECORD OF PREVIOUS ROUNDS:\n${this.record.map((r) => `  ${r}`).join("\n")}`);
    }
    return lines.join("\n");
  }

  private async ask(pid: number, kind: DecisionKind, instruction: string, targets?: string[]): Promise<Decision> {
    await this.gate();
    const p = this.players[pid];
    const events = this.inbox[pid];
    this.inbox[pid] = [];
    this.emit("thinking", null, { player: pid, kind });
    let d: Decision;
    try {
      d = await this.agents[pid].decide({ kind, instruction, status: this.statusFor(p), targets }, events);
    } catch (err) {
      if (String(err).includes("stopped")) throw err;
      this.emit("error", null, { player: pid, text: `Agent error (${p.name}): ${String(err)}` });
      d = { private_reasoning: "(agent error, default action)", say: "", target: "", vote: "none", card: "none" };
    }
    this.emit("reasoning", [pid], {
      player: pid,
      kind,
      instruction,
      text: d.private_reasoning,
      thinking: d.thinking ?? "",
      decision: { say: d.say, target: d.target, vote: d.vote, card: d.card },
    });
    return d;
  }

  private say(pid: number, text: string, context: string) {
    const msg = text.trim().slice(0, 600);
    if (!msg) return;
    const name = this.name(pid);
    for (const p of this.players) if (p.alive && p.id !== pid) this.inbox[p.id].push(`${name}: "${msg}"`);
    this.inbox[pid].push(`You said: "${msg}"`);
    this.emit("chat", null, { player: pid, text: msg, context });
  }

  private pace() {
    return this.paceMs ? new Promise((r) => setTimeout(r, this.paceMs)) : Promise.resolve();
  }

  // ---------- discussion ----------
  /** Open table talk. Players who speak get re-queued; anyone named in a message jumps the queue. */
  private async discussion(
    label: string,
    maxPerPlayer: number,
    maxMessages: number,
    instruction: string,
    finalWord?: number,
  ) {
    this.phase = label;
    this.snapshot();
    const spoken = new Map<number, number>();
    // Anyone named in a message may answer once more even after using their messages, so a
    // player who is questioned is never silenced by the message cap.
    const replyUsed = new Set<number>();
    const canSpeak = (id: number) => (spoken.get(id) ?? 0) < maxPerPlayer;
    let queue = shuffle(this.alive().map((p) => p.id));
    if (this.current.captain !== undefined) {
      queue = [this.current.captain, ...queue.filter((i) => i !== this.current.captain)];
    }
    let total = 0;
    while (queue.length && total < maxMessages) {
      const pid = queue.shift()!;
      if (!this.players[pid].alive) continue;
      const isReply = !canSpeak(pid);
      const d = await this.ask(
        pid,
        "discuss",
        isReply ? `${instruction} You were just addressed directly: this is your one chance to reply.` : instruction,
      );
      if (isReply) replyUsed.add(pid);
      if (!d.say.trim()) {
        this.emit("pass", null, { player: pid });
        continue;
      }
      this.say(pid, d.say, label);
      total++;
      const n = (spoken.get(pid) ?? 0) + 1;
      spoken.set(pid, n);
      const named = this.alive()
        .filter((p) => p.id !== pid && (p.name === d.target || new RegExp(`\\b${p.name}\\b`).test(d.say)))
        .map((p) => p.id)
        .filter((id) => canSpeak(id) || !replyUsed.has(id));
      queue = [...named, ...queue.filter((id) => !named.includes(id))];
      if (canSpeak(pid) && !queue.includes(pid)) queue.push(pid);
      await this.pace();
    }
    // The Captain always gets the last word before the vote.
    if (finalWord !== undefined && this.players[finalWord].alive && !this.winner) {
      const d = await this.ask(
        finalWord,
        "discuss",
        `FINAL WORD before the vote. As Captain, answer any open questions about your nomination directly and concretely, or leave "say" empty.`,
      );
      if (d.say.trim()) {
        this.say(finalWord, d.say, `${label} (final word)`);
        await this.pace();
      } else this.emit("pass", null, { player: finalWord });
    }
  }

  // ---------- main loop ----------
  async run(): Promise<Winner> {
    this.setup();
    while (!this.winner && this.round < this.rs.maxRounds) {
      await this.playRound();
    }
    if (!this.winner) this.end("none", `No winner after ${this.rs.maxRounds} rounds.`);
    await Promise.all(this.summaries);
    await this.summarizeGame();
    return this.winner!;
  }

  private setup() {
    const sabs = this.players.filter((p) => p.role === "saboteur");
    const inf = this.players.find((p) => p.role === "infiltrator")!;
    for (const p of this.players) this.fillHand(p);
    this.announce(
      `Welcome aboard Meridian (ruleset: ${this.rs.name}). Seat order: ${this.players.map((p) => p.name).join(", ")}. ` +
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
    let barred: number[] = [];
    if (this.rs.termLimits === "team") barred = this.alive().length > 5 ? this.lastTeam : this.lastTeam.slice(1);
    if (this.rs.termLimits === "second") barred = this.lastTeam.slice(1);
    const ok = this.alive().filter((p) => p.id !== captain && !barred.includes(p.id));
    return ok.length ? ok : this.alive().filter((p) => p.id !== captain);
  }

  private async playRound() {
    this.round++;
    this.roundLog = [];
    const captain = this.nextCaptain();
    this.current = { captain };
    const facts: RoundFacts = { round: this.round, captain };
    this.facts.push(facts);
    const cap = this.players[captain];
    this.emit("round", null, { captain });
    this.announce(`--- Round ${this.round}. ${cap.name} is Captain. ---`);
    await this.roundBody(captain, facts);
    this.closeRound(facts);
  }

  private async roundBody(captain: number, facts: RoundFacts) {
    const cap = this.players[captain];
    await this.discussion(
      "briefing",
      this.rs.discussion.briefingPerPlayer,
      this.alive().length * this.rs.discussion.briefingPerPlayer,
      `BRIEFING. Open discussion before ${cap.name} nominates a Second. Speak if you have something useful (accuse, defend, share or claim info, suggest a nominee), or leave "say" empty to stay quiet.`,
    );

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
    facts.second = second.id;
    this.current.second = second.id;
    this.announce(`${cap.name} nominates ${second.name} as Second.`, { kind: "nominate", captain, second: second.id });
    if (nd.say.trim()) this.say(captain, nd.say, "nomination");
    this.snapshot();

    await this.discussion(
      "debate",
      this.rs.discussion.debatePerPlayer,
      this.alive().length * this.rs.discussion.debatePerPlayer,
      `DEBATE. ${cap.name} has nominated ${second.name} as Second. Argue for or against this team before the vote, or leave "say" empty.`,
      captain,
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
    facts.votes = votes;
    facts.approved = passed;
    const voteText = voters.map((p) => `${p.name} ${votes[p.id].toUpperCase()}`).join(", ");
    this.announce(`Votes: ${voteText}. ${passed ? "Team APPROVED" : "Team REJECTED"} (${yes}-${voters.length - yes}).`, {
      kind: "votes",
      votes,
      passed,
    });

    if (!passed) {
      this.unrest++;
      this.announce(`Unrest rises to ${this.unrest}/${this.rs.unrestLimit}.`);
      let tail = `REJECTED (${voteText})`;
      if (this.unrest >= this.rs.unrestLimit) {
        const card = this.draw();
        this.discard.push(card);
        this.unrest = 0;
        this.lastTeam = [];
        facts.auto = card;
        this.announce(
          `UNREST LIMIT. Emergency protocol logs the top card of the deck: ${card.toUpperCase()}. Nomination limits clear.`,
          { kind: "auto", card },
        );
        this.log(card, false);
        tail += `; emergency protocol logged ${card.toUpperCase()}`;
      }
      this.record.push(`R${this.round}: ${cap.name} nominated ${second.name}. ${tail}.`);
      this.current = {};
      this.snapshot();
      return;
    }

    this.unrest = 0;
    this.lastTeam = [captain, second.id];
    const dangerAt = this.rs.infiltratorDangerAt;
    if (dangerAt > 0 && this.breaches >= dangerAt && (cap.role === "infiltrator" || second.role === "infiltrator")) {
      const inf = cap.role === "infiltrator" ? cap : second;
      this.record.push(`R${this.round}: ${cap.name} + ${second.name} APPROVED (${voteText}). ${inf.name} was the Infiltrator.`);
      this.end("saboteurs", `${inf.name} was the Infiltrator and reached the core after ${this.breaches} Breaches.`);
      return;
    }

    // Mission
    this.phase = "mission";
    this.snapshot();
    const team = [cap, second];
    let result: Card;
    let rec: string;
    if (this.rs.missionMode === "split") {
      result = await this.splitMission(cap, second, facts);
      rec = `R${this.round}: ${cap.name} + ${second.name} APPROVED (${voteText}) -> ${second.name} played ${result.toUpperCase()}`;
    } else {
      if (this.rs.missionMode === "supply") await this.supplyCrate(cap, second, facts);
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
      facts.played = team.map((p, i) => ({ player: p.id, card: played[i] }));
      for (const c of played) this.discard.push(c);
      for (const p of team) {
        // Supply mode: a crate bigger than 2 leaves the Captain with extras, discarded at random.
        while (p.hand.length > this.rs.handSize) {
          const i = Math.floor(Math.random() * p.hand.length);
          this.discard.push(p.hand.splice(i, 1)[0]);
        }
        this.fillHand(p);
      }
      const nBreach = played.filter((c) => c === "breach").length;
      result = this.rs.resolution === "any_breach" ? (nBreach > 0 ? "breach" : "repair") : nBreach === 2 ? "breach" : "repair";
      const shown = shuffle(played);
      this.announce(
        `Mission result: ${shown.map((c) => c.toUpperCase()).join(" + ")} -> ${result.toUpperCase()} logged (${nBreach} Breach card${nBreach === 1 ? "" : "s"}).`,
        { kind: "mission", cards: shown, result },
      );
      for (const p of team) this.tell(p.id, `You played ${played[team.indexOf(p)]}. Your hand is now: ${p.hand.join(", ")}.`);
      rec = `R${this.round}: ${cap.name} + ${second.name} APPROVED (${voteText}) -> ${result.toUpperCase()} (${nBreach} Breach card${nBreach === 1 ? "" : "s"})`;
    }
    facts.result = result;
    const power = this.log(result, true);
    this.snapshot();
    if (this.winner) {
      this.record.push(rec + ".");
      return;
    }

    // Debrief
    this.phase = "debrief";
    this.snapshot();
    const claims: string[] = [];
    for (const p of team) {
      const d = await this.ask(
        p.id,
        "debrief",
        this.rs.missionMode === "split"
          ? p === cap
            ? `DEBRIEF. Make your public statement as Captain: what was in the crate and which card you passed to ${second.name}. You may lie.`
            : `DEBRIEF. Make your public statement as Second: what ${cap.name} passed you, what you drew, and why you played what you played. You may lie.`
          : this.rs.missionMode === "supply"
          ? `DEBRIEF. Make your public statement about the mission. Captain: what was in the crate, what you handed over and what you played. Second: what you received and what you played. You may lie.`
          : `DEBRIEF. Make your public statement about the mission (what you held / played, what you think happened). You may lie.`,
      );
      const text = d.say || "No comment.";
      this.say(p.id, text, "debrief");
      claims.push(`${p.name} claimed: "${text.slice(0, 160)}"`);
      await this.pace();
    }
    rec += `. ${claims.join(" ")}`;

    if (power) rec += await this.usePower(captain, power, facts);
    this.record.push(rec);
    this.current = {};
    this.snapshot();
  }

  /** Split Crate: Captain passes one of N crate cards; the Second adds their own draw and plays one. */
  private async splitMission(cap: Player, second: Player, facts: RoundFacts): Promise<Card> {
    const crate = Array.from({ length: this.rs.splitCaptainDraw ?? 2 }, () => this.draw());
    facts.crate = [...crate];
    this.announce(`${cap.name} opens a crate of ${crate.length} card${crate.length === 1 ? "" : "s"}.`, { kind: "crate" });
    this.tell(cap.id, `Crate contents: ${crate.join(", ")}.`);
    let give: Card = crate[0];
    if (new Set(crate).size > 1) {
      const d = await this.ask(
        cap.id,
        "supply",
        `SPLIT CRATE. The crate holds: ${crate.join(", ")}. Choose ONE card to pass secretly to ${second.name} by setting "card". The rest are discarded face down. Leave "say" empty.`,
      );
      if (d.card === "repair" || d.card === "breach") give = d.card;
    }
    crate.splice(crate.indexOf(give), 1);
    this.discard.push(...crate);
    facts.handed = give;
    this.tell(cap.id, `You passed ${second.name} a ${give}${crate.length ? ` and discarded ${crate.join(", ")}` : ""}.`);
    const own = Array.from({ length: this.rs.splitSecondDraw ?? 1 }, () => this.draw());
    facts.secondDrew = [...own];
    second.hand = [give, ...own];
    this.announce(`${cap.name} passes one card to ${second.name}, who draws ${own.length} more.`);
    this.tell(second.id, `${cap.name} passed you a ${give}.${own.length ? ` You drew: ${own.join(", ")}.` : ""} You now hold: ${second.hand.join(", ")}.`);
    this.snapshot();

    const d = await this.ask(
      second.id,
      "play_card",
      `MISSION. You hold: ${second.hand.join(", ")} (${give} was passed by ${cap.name}${own.length ? `, you drew ${own.join(", ")}` : ""}). Play ONE by setting "card" ("repair" or "breach"); the rest are discarded face down. Leave "say" empty.`,
    );
    let card = d.card as Card;
    if (!second.hand.includes(card)) {
      card = second.hand[0];
      this.emit("error", null, { player: second.id, text: `${second.name} chose a card they don't hold; played ${card}.` });
    }
    second.hand.splice(second.hand.indexOf(card), 1);
    this.discard.push(card, ...second.hand);
    second.hand = [];
    this.emit("played", [second.id], { player: second.id, card });
    facts.played = [{ player: second.id, card }];
    this.announce(`Mission result: ${second.name} plays ${card.toUpperCase()}. ${card.toUpperCase()} logged.`, {
      kind: "mission",
      cards: [card],
      result: card,
    });
    return card;
  }

  /** Captain draws the crate and secretly hands one card to the Second. */
  private async supplyCrate(cap: Player, second: Player, facts: RoundFacts) {
    const crate = Array.from({ length: this.rs.supplyCrateSize }, () => this.draw());
    facts.crate = [...crate];
    this.announce(`${cap.name} opens a supply crate of ${crate.length} cards.`, { kind: "crate" });
    this.tell(cap.id, `Crate contents: ${crate.join(", ")}.`);
    let give: Card = crate[0];
    if (new Set(crate).size > 1) {
      const d = await this.ask(
        cap.id,
        "supply",
        `SUPPLY CRATE. The crate holds: ${crate.join(", ")}. Choose ONE card to hand secretly to ${second.name} by setting "card". You keep the rest. Leave "say" empty.`,
      );
      if (d.card === "repair" || d.card === "breach") give = d.card;
    }
    crate.splice(crate.indexOf(give), 1);
    cap.hand.push(...crate);
    second.hand.push(give);
    facts.handed = give;
    this.announce(`${cap.name} hands ${second.name} one card from the crate.`);
    this.tell(cap.id, `You handed ${second.name} a ${give}. Your hand: ${cap.hand.join(", ")}.`);
    this.tell(second.id, `${cap.name} handed you a ${give}. Your hand: ${second.hand.join(", ")}.`);
    this.snapshot();
  }

  /** Record a logged card; returns the power the Captain earns, if any. */
  private log(card: Card, powersActive: boolean): "scan" | "eject" | undefined {
    if (card === "repair") this.repairs++;
    else this.breaches++;
    if (this.repairs >= this.rs.repairsToWin) this.end("crew", `${this.rs.repairsToWin} Repairs logged. The station is saved.`);
    else if (this.breaches >= this.rs.breachesToWin)
      this.end("saboteurs", `${this.rs.breachesToWin} Breaches logged. The station is lost.`);
    if (!powersActive || this.winner) return undefined;
    return card === "breach" ? this.rs.breachPowers[String(this.breaches)] : this.rs.repairPowers[String(this.repairs)];
  }

  private async usePower(captain: number, power: "scan" | "eject", facts: RoundFacts): Promise<string> {
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
        ? `POWER: SCAN. Choose one player to learn their team privately. Put their exact name in "target". Options: ${names.join(", ")}. Use "say" for any public comment; you can share (or lie about) the result.`
        : `POWER: EJECT. Choose one player to remove from the game. Put their exact name in "target". Options: ${names.join(", ")}. Use "say" to explain your choice publicly.`,
      names,
    );
    let t = this.byName(d.target);
    if (!t || !targets.includes(t)) {
      t = targets[Math.floor(Math.random() * targets.length)];
      this.emit("error", null, { player: captain, text: `Invalid target "${d.target}", picked ${t.name} at random.` });
    }
    facts.power = { kind: power, target: t.id };
    if (power === "scan") {
      const team = t.role === "crew" ? "CREW" : "SABOTEUR";
      this.announce(`${cap.name} scans ${t.name}.`, { kind: "scan", captain, target: t.id });
      this.tell(captain, `Scan result: ${t.name} is on the ${team} team.`);
      if (d.say.trim()) this.say(captain, d.say, "power");
      this.snapshot();
      return ` ${cap.name} scanned ${t.name}${d.say.trim() ? ` and said: "${d.say.trim().slice(0, 160)}"` : ""}.`;
    }
    if (d.say.trim()) this.say(captain, d.say, "power");
    t.alive = false;
    this.announce(`${cap.name} ejects ${t.name} from the station.`, { kind: "eject", captain, target: t.id });
    if (t.role === "infiltrator") this.end("crew", `${t.name} was the Infiltrator. The crew wins.`);
    else this.announce(`${t.name} was not the Infiltrator.`);
    this.snapshot();
    return ` ${cap.name} ejected ${t.name} (not the Infiltrator).`;
  }

  /** Emit round facts and kick off a narrator recap in the background. */
  private closeRound(facts: RoundFacts) {
    this.emit("roundfacts", null, { facts: structuredClone(facts) });
    const n = this.narrator;
    if (!n) return;
    const log = this.roundLog.join("\n");
    const round = facts.round;
    this.summaries.push(
      n
        .round(log)
        .then((s) => this.emit("summary", null, { scope: "round", forRound: round, summary: s }))
        .catch((err) => this.emit("error", null, { text: `Narrator failed for round ${round}: ${String(err)}` }))
        .finally(() => this.snapshot()),
    );
  }

  private async summarizeGame() {
    if (!this.narrator) return;
    this.emit("system", null, { text: "The narrator is writing the game summary..." });
    try {
      const roles = this.players.map((p) => `${p.name}: ${p.role}${p.alive ? "" : " (ejected)"}`).join(", ");
      this.gameSummary = await this.narrator.game(`FINAL ROLES: ${roles}\nRESULT: ${this.winReason}\n\n${this.gameLog.join("\n")}`);
      this.emit("summary", null, { scope: "game", summary: this.gameSummary });
    } catch (err) {
      this.emit("error", null, { text: `Narrator failed on the game summary: ${String(err)}` });
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
