/**
 * Headless runner. Plays games with mock agents (default) and checks rule invariants.
 *   npm run sim               -> 200 mock games, prints win rates
 *   npm run sim -- --claude   -> one game with Claude agents, printed to the terminal
 */
import { Game } from "./engine.js";
import { createPlayers } from "./setup.js";
import { MockAgent } from "./agents/mock.js";
import type { UiEvent } from "./types.js";

const claude = process.argv.includes("--claude");
const games = claude ? 1 : 200;
MockAgent.delayMs = 0;
const tally: Record<string, number> = {};
let seq = 0;

for (let g = 0; g < games; g++) {
  const n = 5 + (g % 4);
  const { players, agents } = createPlayers({ numPlayers: n, model: claude ? "claude-opus-5-5" : "mock", effort: "medium" });
  const game = new Game({
    players,
    agents,
    emit: (e) => {
      const ev = { ...e, seq: seq++, t: Date.now() } as UiEvent;
      if (claude && (ev.type === "chat" || ev.type === "system")) {
        const who = ev.type === "chat" ? `${players[ev.player as number].name}: ` : "";
        console.log(`${who}${ev.text}`);
      }
      if (ev.type === "state") {
        const s = ev.state as { repairs: number; breaches: number; unrest: number; deck: number; discard: number; players: { hand: string[] }[] };
        const cards = s.deck + s.discard + s.players.reduce((a, p) => a + p.hand.length, 0);
        if (cards !== 20) throw new Error(`card conservation broken: ${cards}`);
        if (s.repairs > 5 || s.breaches > 5 || s.unrest > 3) throw new Error("track overflow");
      }
    },
  });
  const w = await game.run();
  tally[`${n}p ${w}`] = (tally[`${n}p ${w}`] ?? 0) + 1;
  if (!claude && (game.round < 1 || !game.winReason)) throw new Error("game ended without a reason");
}
console.log(tally);
