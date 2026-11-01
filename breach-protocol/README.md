# Breach Protocol

An original hidden-role social deduction game played entirely by Claude agents, with a live spectator UI. Agents talk openly at the table, nominate teams, vote, secretly play cards, lie, and use powers. The engine enforces every rule.

## Run it

```bash
cd breach-protocol
npm install
npm start          # http://localhost:3000
```

Pick player count (5-8), agents, model, ruleset, and effort, then press **New game**.

### Agent backends

| Backend | How it works | Needs |
|---|---|---|
| **Claude Code sessions** (default) | Each player is one long-running headless Claude Code process for the whole game (`claude -p --input-format stream-json`); each decision is a new message to it. It uses whatever account `claude` is logged in as, e.g. your Pro or Max subscription. | Claude Code installed and logged in on the machine running the server |
| Anthropic API | Each player is a Messages API conversation. | `ANTHROPIC_API_KEY` |
| Mock bots | Offline heuristic bots, for testing and UI demos. | Nothing |

Notes on the Claude Code backend:
- The server removes `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the child processes so they always use your login (set `BREACH_CLI_USE_API_KEY=1` to opt out).
- Sessions run in a scratch directory (`$TMPDIR/breach-protocol-agents`) with no tools, no settings sources, no MCP servers and no slash commands, so your projects, hooks and CLAUDE.md files don't leak in.
- Games count toward your plan's usage limits. A 5-player game is a few hundred calls; Haiku is the lightest. The board shows the API-equivalent cost Claude Code reports, which is not billed on a subscription.
- One `claude` process per player stays open for the whole game (plus a short-lived one per narrator recap), so a turn takes roughly 1-3 seconds with Haiku. If a process dies, the next turn restarts it and resumes the same session, so the player keeps its memory. Processes are closed when the game ends or is stopped. Turn timeout: `BREACH_TURN_TIMEOUT_MS` (default 300000).
- Claude Code doesn't return thinking summaries in this mode, so the Agents tab shows each agent's stated reasoning and actions.

Other commands:

- `npm run sim` plays 200 mock games per ruleset and checks rule invariants (card conservation, hand sizes, track limits, one recap per round plus a game recap).
- `BREACH_MODEL=claude-haiku-5-5 npm run sim -- --claude split-crate` plays one game with Claude Code agents in the terminal and prints the game summary.
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

## Rules (default ruleset: Split Crate)

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

**Cards.** 12 Repair and 8 Breach in a shared deck. Nobody holds cards between missions.

**Each round.**
1. **Briefing**: open talk. Agents choose whether to speak; anyone named in a message gets to respond next.
2. **Nomination**: the Captain (rotates) picks a Second. The last approved team is barred (with 5 or fewer alive, only the last Second).
3. **Debate**, then a simultaneous **vote**. Strict majority approves. A rejection adds 1 Unrest; at 3 the top deck card is logged automatically, with no powers.
4. **Mission (Split Crate)**: the Captain privately draws 2 cards, secretly passes one to the Second and discards the other face down. The Second draws 1 more card, then plays one of the 2 cards they hold; the other is discarded face down. The played card is logged.
5. **Debrief**: the Captain claims what was in the crate and what they passed; the Second claims what they were passed and what they drew. Both may lie, and their claims can contradict.
6. **Powers** for that Captain: 2nd Breach = Scan (privately learn a player's team), 3rd and 4th Breach = Eject, 3rd Repair = Scan.

## Rulesets

Rules live in `rulesets/*.json`. The engine, the rules text each agent receives, and the board all read from the same file, so editing JSON changes the whole game. Add a new file and it appears in the UI's Rules dropdown.

| Field | Meaning |
|---|---|
| `deck.repair`, `deck.breach` | Deck composition |
| `handSize` | Cards each player holds between missions (0 in split mode) |
| `missionMode` | `"split"` (no hands; Captain passes one crate card, Second adds a draw and plays one), `"supply"` (crate hand-off, both play from hands), or `"simultaneous"` (both play from own hand, refill) |
| `splitCaptainDraw`, `splitSecondDraw` | Cards the Captain and Second draw in split mode |
| `supplyCrateSize` | Crate size in supply mode (extras beyond hand size are discarded at random) |
| `resolution` | `"any_breach"` or `"both_breach"` (two-card modes only) |
| `repairsToWin`, `breachesToWin`, `unrestLimit` | Track lengths |
| `infiltratorDangerAt` | Breaches after which an approved Infiltrator wins (0 disables) |
| `breachPowers`, `repairPowers` | Map of track count to `"scan"` or `"eject"` |
| `saboteurs` | Regular Saboteurs per player count (Infiltrator is always 1 extra) |
| `termLimits` | `"team"`, `"second"`, or `"none"` |
| `discussion` | Max messages per player in briefing and debate |
| `maxRounds` | Safety cap |

Included: `split-crate.json` (default, no hands), `supply-crate.json` (hands + crate hand-off), and `simultaneous.json` (the first version).

## Architecture

```
src/
  engine.ts         Game state machine: phases, rules, hidden information, discussion scheduler, round facts
  ruleset.ts        Ruleset type, loader/validator, and rules-text generator
  rules.ts          Player names and personas
  narrator.ts       Narrator agent (round + game recaps) and a template narrator for mock games
  agents/claudecode.ts  One Claude player = one persistent headless Claude Code session
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
