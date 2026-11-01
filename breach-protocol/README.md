# Breach Protocol

An original hidden-role social deduction game played entirely by Claude agents, with a live spectator UI. Agents talk openly at the table, nominate teams, vote, secretly play cards, lie, and use powers. The engine enforces every rule.

## Run it

```bash
cd breach-protocol
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # not needed for mock bots
npm start                              # http://localhost:3000
```

Pick player count (5-8), the agent model, and effort, then press **New game**. Turn on **Reveal roles & thoughts** to see roles, hands, secret card plays, private info, and each agent's private reasoning. Agents never see this view.

Other commands:

- `npm run sim` plays 200 games with mock bots and checks rule invariants (card conservation, track limits, every game ends with a reason).
- `npm run sim -- --claude` plays one Claude game in the terminal.
- Every finished game is saved to `logs/game-<timestamp>.json`.

## Rules

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

**Hands.** The deck has 12 Repair and 8 Breach cards. Every player privately holds 2 cards. This means an honest Crew member can be stuck with only Breach cards, and a Saboteur can play Repair to look clean.

**Each round.**
1. **Briefing**: open table talk. Agents choose whether to speak; anyone named in a message gets to respond next.
2. **Nomination**: the Captain (rotates each round) picks a Second. Members of the last approved team are barred (with 5 or fewer alive, only the previous Second).
3. **Debate**, then a simultaneous **vote**. Strict majority approves. A rejection adds 1 Unrest; at 3 Unrest the top deck card is logged automatically with no powers.
4. **Mission**: Captain and Second each secretly play one card. Cards are revealed shuffled. Any Breach logs a Breach; only two Repairs log a Repair.
5. **Debrief**: both team members make public claims (lies allowed).
6. **Powers** for that Captain: 2nd Breach = Scan (privately learn a player's team), 3rd and 4th Breach = Eject, 3rd Repair = Scan.

## Architecture

```
src/
  engine.ts        Game state machine: phases, rules, hidden information, discussion scheduler
  rules.ts         Constants and the rules text given to every agent
  agents/claude.ts One Claude player = one isolated Messages API conversation
  agents/mock.ts   Heuristic bots for offline testing / UI demo
  setup.ts         Role dealing, model assignment, cost estimate
  server.ts        HTTP + Server-Sent Events; pause/resume/stop
  sim.ts           Headless batch runner with invariant checks
public/            Spectator UI (vanilla HTML/CSS/JS)
```

- **The engine is the orchestrator.** Agents never talk to each other directly. The engine decides who acts, delivers to each agent only what that player is allowed to know (public events + their own private info), and validates every action (invalid nominees or cards fall back to a legal choice and are flagged in the feed).
- **Each agent keeps its own append-only conversation**, so it remembers the whole game from its own point of view. Requests use prompt caching, so the growing history is mostly billed at cache-read rates.
- **One JSON schema for every decision** (`private_reasoning`, `say`, `target`, `vote`, `card`) via structured outputs. Keeping a single schema keeps the request prefix stable for caching.
- Opus 5.5 and Sonnet 5.5 players opt into the server-side refusal fallback (`fallbacks: "default"`).
- Votes and card plays run in parallel; discussion is sequential.

## Cost

A 7-player game is roughly 25-50 API calls per round over 6-12 rounds. Rough estimates: Haiku 5.5 well under $1, Sonnet 5.5 a few dollars, Opus 5.5 roughly $5-15 at medium effort. The UI shows live spend from actual token usage.
