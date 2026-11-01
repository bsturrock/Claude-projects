/**
 * Headless runner. Plays games with mock agents (default) and checks rule invariants.
 *   npm run sim                         -> 200 mock games per ruleset, prints win rates
 *   npm run sim -- --claude [ruleset]   -> one game with Claude Code agents (BREACH_MODEL, default Haiku), printed to the terminal
 */
import { Game } from "./engine.js";
import { MockAgent } from "./agents/mock.js";
import { listRulesets } from "./ruleset.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { costOf, createGameParts, type GameConfig } from "./setup.js";
import type { UiEvent } from "./types.js";

const claude = process.argv.includes("--claude");
const rulesetArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const rulesets = rulesetArg ? [rulesetArg] : listRulesets().map((r) => r.id);
const gamesPer = claude ? 1 : 200;
MockAgent.delayMs = 0;
let seq = 0;

for (const ruleset of rulesets) {
  const tally: Record<string, number> = {};
  let rounds = 0;
  for (let g = 0; g < gamesPer; g++) {
    const n = claude ? Number(process.env.BREACH_PLAYERS ?? 5) : 5 + (g % 4);
    const cfg: GameConfig = {
      numPlayers: n,
      backend: claude ? "claude-code" : "mock",
      model: process.env.BREACH_MODEL ?? "claude-haiku-5-5",
      effort: "medium",
      ruleset,
      narrator: true,
    };
    const { rules, players, agents, narrator } = createGameParts(cfg);
    const events: UiEvent[] = [];
    const deckTotal = rules.deck.repair + rules.deck.breach;
    let summaries = 0;
    const game = new Game({
      rules,
      players,
      agents,
      narrator,
      emit: (e) => {
        const ev = { ...e, seq: seq++, t: Date.now() } as UiEvent;
        if (claude) events.push(structuredClone(ev));
        if (claude && (ev.type === "chat" || ev.type === "system")) {
          const who = ev.type === "chat" ? `${players[ev.player as number].name}: ` : "";
          console.log(`${who}${ev.text}`);
        }
        if (ev.type === "summary") summaries++;
        if (ev.type === "state") {
          const s = ev.state as {
            repairs: number; breaches: number; unrest: number; deck: number; discard: number;
            players: { hand: string[] }[];
          };
          const cards = s.deck + s.discard + s.players.reduce((a, p) => a + p.hand.length, 0);
          if (cards !== deckTotal) throw new Error(`card conservation broken: ${cards}/${deckTotal}`);
          if (s.repairs > rules.repairsToWin || s.breaches > rules.breachesToWin || s.unrest > rules.unrestLimit)
            throw new Error("track overflow");
          const minHand = rules.handSize;
          const maxHand =
            rules.missionMode === "split" || rules.missionMode === "paired"
              ? 1 + (rules.splitSecondDraw ?? 1)
              : rules.handSize + (rules.missionMode === "supply" ? rules.supplyCrateSize - 1 : 0);
          for (const p of s.players)
            if (p.hand.length < minHand || p.hand.length > maxHand) throw new Error(`hand size ${p.hand.length} at snapshot`);
        }
      },
    });
    let w: Awaited<ReturnType<Game["run"]>>;
    try {
      w = await game.run();
    } finally {
      for (const a of agents) a.close?.();
    }
    rounds += game.round;
    tally[`${n}p ${w}`] = (tally[`${n}p ${w}`] ?? 0) + 1;
    if (!game.winReason) throw new Error("game ended without a reason");
    if (summaries !== game.round + 1) throw new Error(`expected ${game.round + 1} summaries, got ${summaries}`);
    if (claude) {
      console.log(JSON.stringify(game.gameSummary, null, 2));
      // Same format as the web server's logs, so the game can be replayed in the UI (Saved games).
      const usd =
        players.reduce((a, p) => a + costOf(p.model, agents[p.id].usage), 0) + (narrator ? costOf(narrator.model, narrator.usage) : 0);
      const logsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "logs");
      mkdirSync(logsDir, { recursive: true });
      const file = path.join(logsDir, `game-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      writeFileSync(file, JSON.stringify({ config: cfg, ruleset: rules, winner: w, reason: game.winReason, summary: game.gameSummary, usd, events }));
      console.log(`Full log (including private reasoning) saved to ${file}`);
    }
  }
  console.log(ruleset, `avg rounds ${(rounds / gamesPer).toFixed(1)}`, tally);
}
