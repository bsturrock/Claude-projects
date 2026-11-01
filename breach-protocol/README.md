# Breach Protocol

An original hidden-role social deduction game played entirely by Claude agents, with a live spectator UI. Agents talk openly at the table, nominate teams, vote, secretly play cards, lie, and use powers. The engine enforces every rule.

## Run it

```bash
cd breach-protocol
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # not needed for mock bots
npm start                              # http://localhost:3000
```

Pick player count (5-8), agent model, ruleset, and effort, then press **New game**.

Other commands:

- `npm run sim` plays 200 mock games per ruleset and checks rule invariants (card conservation, hand sizes, track limits, one recap per round plus a game recap).
- `npm run sim -- --claude supply-crate` plays one Claude game in the terminal and prints the game summary.
- Every finished game is saved to `logs/game-<timestamp>.json` and can be replayed in the UI.

## Spectator UI

- **Board**: tracks (labels follow the ruleset's powers), Unrest, deck/discard, live spend, round table with Captain/Second badges, votes, speech bubbles, and a glow on whoever is deciding.
- **Reveal roles & thoughts**: shows roles, hands, crate contents, secret card plays, private info, and agent reasoning. Agents never see this view.
- **Tabs**
  - *Table talk*: the public conversation and engine events.
  - *Rounds*: one card per round with team, votes, result, power, the secret facts (crate, who played what), and the narrator's public recap plus spectator analysis.
  - *Agents*: click a seat or a name to see that agent's full timeline: each decision's summarized extended thinking, its stated private reasoning, the action it took, and every piece of private info it received.
  - *Game*: the narrator's end-of-game write-up (story, turning points, best play, biggest mistake, a verdict per player).
- **Replays**: pick a saved game, choose a speed, press Replay. "Back to live" returns to the running game.

About "chain of thought": the API never returns a model's raw reasoning. The Agents tab shows the *summarized* thinking the API returns (`thinking.display: "summarized"`) plus the short reasoning each agent writes in its JSON answer.

## Rules (default ruleset: Supply Crate)

**Teams.** Crew (majority) vs. Saboteurs. One Saboteur is the **Infiltrator**. Regular Saboteurs know each other and the Infiltrator; the Infiltrator knows nobody.

| Players | Crew | Saboteurs | Infiltrator |
|---|---|---|---|
| 5 | 3 | 1 | 1 |
| 6 | 4 | 1 | 1 |
| 7 | 4 | 2 | 1 |
| 8 | 5 | 2 | 1 |

**Win conditions.**
- Crew: log 5 Repairs, or eject the Infiltrator.
- Saboteurs: log 5 Breaches, or get the Infiltrator approved onto a mission team once 3+ Breaches are logged.

**Cards.** 12 Repair and 8 Breach. Everyone privately holds 2 cards.

**Each round.**
1. **Briefing**: open talk. Agents choose whether to speak; anyone named in a message gets to respond next.
2. **Nomination**: the Captain (rotates) picks a Second. The last approved team is barred (with 5 or fewer alive, only the last Second).
3. **Debate**, then a simultaneous **vote**. Strict majority approves. A rejection adds 1 Unrest; at 3 the top deck card is logged automatically, with no powers.
4. **Mission (Supply Crate)**: the Captain privately draws 2 cards, secretly hands one to the Second and keeps the other. Both then secretly play one card from their 3-card hands. The cards are revealed shuffled. Any Breach logs a Breach; only two Repairs log a Repair.
5. **Debrief**: the Captain claims what was in the crate and what they handed over; the Second claims what they received. Both may lie, and their claims can contradict.
6. **Powers** for that Captain: 2nd Breach = Scan (privately learn a player's team), 3rd and 4th Breach = Eject, 3rd Repair = Scan.

## Rulesets

Rules live in `rulesets/*.json`. The engine, the rules text each agent receives, and the board all read from the same file, so editing JSON changes the whole game. Add a new file and it appears in the UI's Rules dropdown.

| Field | Meaning |
|---|---|
| `deck.repair`, `deck.breach` | Deck composition |
| `handSize` | Cards each player holds |
| `missionMode` | `"supply"` (crate hand-off) or `"simultaneous"` (play from own hand, refill) |
| `supplyCrateSize` | Crate size in supply mode (extras beyond hand size are discarded at random) |
| `resolution` | `"any_breach"` or `"both_breach"` |
| `repairsToWin`, `breachesToWin`, `unrestLimit` | Track lengths |
| `infiltratorDangerAt` | Breaches after which an approved Infiltrator wins (0 disables) |
| `breachPowers`, `repairPowers` | Map of track count to `"scan"` or `"eject"` |
| `saboteurs` | Regular Saboteurs per player count (Infiltrator is always 1 extra) |
| `termLimits` | `"team"`, `"second"`, or `"none"` |
| `discussion` | Max messages per player in briefing and debate |
| `maxRounds` | Safety cap |

Included: `supply-crate.json` (default) and `simultaneous.json` (the first version, no crate).

## Architecture

```
src/
  engine.ts         Game state machine: phases, rules, hidden information, discussion scheduler, round facts
  ruleset.ts        Ruleset type, loader/validator, and rules-text generator
  rules.ts          Player names and personas
  narrator.ts       Narrator agent (round + game recaps) and a template narrator for mock games
  agents/claude.ts  One Claude player = one isolated Messages API conversation
  agents/mock.ts    Heuristic bots for offline testing / UI demo
  setup.ts          Role dealing, model assignment, cost estimate
  server.ts         HTTP + Server-Sent Events; pause/resume/stop; saved-game listing
  sim.ts            Headless batch runner with invariant checks
rulesets/           Editable rule files
public/             Spectator UI (vanilla HTML/CSS/JS)
```

- **The engine is the orchestrator.** Agents never talk to each other directly. The engine decides who acts, delivers only what each player may know, and validates every action (invalid choices fall back to a legal one and are flagged in the feed).
- **Each agent keeps its own append-only conversation**, with prompt caching. Once per round each agent also gets a compact public record of every previous round (teams, votes, results, debrief claims), so it doesn't have to recall everything from scratch.
- **One JSON schema for every decision** via structured outputs, which keeps the request prefix stable for caching.
- **The narrator** is a separate Claude call (low effort) that sees the spectator log after each round and at game end. It never talks to the players. It uses the game's model (Opus 5.5 for mixed games).
- Opus 5.5 and Sonnet 5.5 players opt into the server-side refusal fallback (`fallbacks: "default"`).

## Cost

A 7-player game is roughly 25-50 player calls per round over 6-12 rounds, plus one narrator call per round. Rough estimates only: Haiku 5.5 well under $1, Sonnet 5.5 a few dollars, Opus 5.5 roughly $5-15 at medium effort. The UI shows live spend from actual token usage, including the narrator.
