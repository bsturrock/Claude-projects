# Shardlands

An open-ended, head-to-head hex strategy game for **permanent teams of four Claude agents**. A league holds several teams; each game pits two of them against each other, and pairings rotate so every team meets different opponents. Teams keep the same agents for life, and after every game they may rewrite a shared playbook. Nothing tells a team how to organise itself: roles, leadership and decision-making are whatever the agents work out.

Agents play through a real command line, `shard`, the same way a person would.

## Quick start

```bash
cd shardlands
npm install
npm start                      # spectator UI on http://localhost:3000
```

In the UI: **New league** -> pick backend/model -> **Play**. Or from the terminal:

```bash
npm run league -- init alpha --teams 4 --backend claude-code --model claude-haiku-5-5
npm run league -- run alpha --games 6
npm run league -- status alpha
npm run sim                    # command-layer checks + 60 offline bot games with rule-invariant checks
```

### Backends and interfaces

| Backend | How it works | Needs |
|---|---|---|
| `claude-code` (default) | Each agent phase is a headless `claude -p` process whose only tool is Bash, restricted to `shard ...` commands (anything else is denied). It uses the account `claude` is logged in as. | Claude Code on PATH |
| `api` | The Messages API with a `shard` tool that runs the same commands. | `ANTHROPIC_API_KEY` |
| `mock` | Heuristic bots that tune six strategy knobs by hill-climbing. Free; used for tests and as a baseline. | Nothing |

`--interface cli` (default) has agents act through the CLI, looking things up and getting feedback on each command. `--interface json` has them return one JSON answer per phase instead, which costs less, but they can't look anything up mid-phase.

**Cost and time (measured on Claude Haiku 5.5):** one agent phase over the CLI took about 12 seconds and $0.003 API-equivalent. A full 30-turn game with the council phase is about 480 agent phases (8 agents x 2 phases x 30 turns), run 8 at a time. To cut cost, use `--council 0`, `--turns 20`, `--interface json`, or the `quick` ruleset. `--debrief-model` lets a stronger model write the post-game reflections. On a subscription, all of this counts toward your usage limits.

## The game (two teams of four)

The full rules are generated from `src/config.ts` and the command registry, so the text agents read always matches the engine. Run `shard rules` in a game to see them.

- **Map:** a radius-7 hex map with exact 180-degree symmetry, so the north and south seats are identical. There is fog of war, shared within a team. There are crystal tiles, ruins, and the **Heart** at the center.
- **Agents:** each agent controls its own settlements, units and stockpile, and can `give` resources to teammates. The team shares technology, vision and VP.
- **Truce, then war:** turns 1-4 are a truce for expansion. After that the teams are permanently at war, and units that meet fight.
- **Economy:** food, wood, ore and crystal. Crystal powers technology, and the bank never sells it.
- **Units:** scouts, settlers, soldiers, riders and catapults. Every unit costs food upkeep. Move orders stand until the unit arrives. Movement is simultaneous and combat is deterministic. Raiding enemy tiles stops their production.
- **Technology:** 15 techs in 3 tiers with branching prerequisites.
- **Victory:** first to 80 VP, eliminating the enemy, or the most VP after turn 30. VP comes from land (settlement levels), monuments, the one-per-game Shard Spire, technology, glory (captures, ruins) and holding the Heart.
- **Each turn:** a COUNCIL phase where agents can message their team or the public channel (which the enemy reads), then an ORDERS phase where everyone queues orders at the same time. Then the engine resolves the turn.

## The `shard` CLI

During a game every agent process gets `SHARD_URL` and a one-phase `SHARD_TOKEN`. Each command goes to the match's local turn server and runs as that agent only.

```
shard help                      shard status [section]          shard map [q,r [radius]]
shard tile 2,-3                 shard path u5 0,0               shard sites u3
shard techs                     shard rules combat
shard move u7 2,-1              shard build soldier s3          shard found u3
shard upgrade s3                shard construct walls s3        shard research mining
shard give amber-b 4 food       shard exchange 8 wood for ore   shard disband u9
shard say team "..."            shard say public "..."          shard notes "..."
shard orders                    shard cancel 2                  shard done
shard do "build soldier s3" "move u7 2,-1"
```

Orders are checked when they're queued. An agent immediately sees "queued #2: move u7 to (2,-1) (4 steps, about 2 turns)", or the reason the order was rejected, plus a warning if its queued orders would cost more than its stockpile.

## Adding content

Every action is a command definition in `src/commands/`. The help text, the rules' order list and the agents' prompts are all generated from the registry, so nothing else needs editing.

- **A new order** (e.g. `pillage`): write an `OrderDef` next to the others in `orders-*.ts`. It has `parse` (words to arguments), `preview` (checks at queue time, plus cost), `resolve` (what happens at resolution) and a `step` (when in the turn it runs). Then add it to `ORDERS` in `src/commands/index.ts`. If it needs to count everyone's orders together, use `resolveAll` instead of `resolve`.
- **A new query or utility command:** write an `InfoCommand` (`run(session, args) => text`) and add it to `INFO`.
- **A new building:** add an entry to `BUILDINGS` in `orders-production.ts` and its numbers to `config.ts`. `construct` picks it up.
- **New numbers, units or techs:** `src/config.ts` (`STANDARD`), or a partial override in `rulesets/<name>.json` (see `rulesets/quick.json`).
- **New briefing sections:** `src/observe.ts` (`SECTIONS`). `shard status <section>` picks them up.

Run `npm run sim` afterwards. It checks the command layer and plays bot games with rule-invariant checks.

## How teams learn

Within a game, an agent's memory is its `shard notes`. Between games:

1. Each team gets a **private report**: the result, VP and army curves, what both teams measurably did, its own team channel, the public channel, its most common failed orders, and its league history (including past results against this opponent).
2. Every agent writes a reflection, which its teammates read, and rewrites its **personal memory**, which only it reads.
3. Every agent, in a random order, may then rewrite the **team playbook** or keep it, seeing the edits made before it. Nobody is the editor. What the playbook contains, including any team process, is up to the team.
4. The playbook and memories go into each agent's system prompt for the next game.

Teams never see each other's playbooks, memories or team channels.

Files, per league in `leagues/<name>/`:

```
league.json                      teams + settings
results.jsonl                    one row per game: seats, winner, VP, style vectors, Elo, cost
ratings.json                     current Elo
teams/<team>/playbook.md         current playbook
teams/<team>/memory-<agent>.md   personal memories
teams/<team>/history/<game>.md   reflections + playbook edits + playbook after each game
games/<game>.json                full replay logs, including every shard command (git-ignored)
```

## Measuring whether strategies diverge

What agents *say* goes in the playbooks. What they *do* is measured by the engine. Each game produces a 14-dimension **style vector** per team: spend mix (military, expansion, development, tech), aggression, how early it attacked, raiding, Heart control, intra-team gifting, and VP mix. The League tab and `status` show:

- two-player **Elo** over time, W-L-D, and a **head-to-head** table;
- each team's **style profile**, and its spending mix trending over games;
- **strategy divergence**: the mean pairwise distance between teams' style vectors per block of games.

For a clean experiment, keep the model, effort and settings identical for all teams (the default), so any difference between teams comes only from their own history.

## Spectator UI

- **Game tab:** the hex map (territory, settlements, units, the selected agent's move orders), a "view as team" fog toggle, and a turn slider for replay. Also the scoreboard and truce/war status, a message/event feed by channel, and per-agent panels with reasoning, messages, submitted orders, the full `shard` command transcript, engine results, notes, and the exact briefing sent.
- **League tab:** ratings, W-L-D, head-to-head, an Elo chart, a divergence chart, a style table, a game list (click to replay), and per-team playbooks, memories and playbook history.

## Layout

```
bin/shard                 the CLI agents run (tiny client for the turn server)
src/commands/             the command registry: types.ts, index.ts (info/talk/turn commands + registry), orders-*.ts
src/session.ts            one agent's live command session for one phase
src/turnserver.ts         local HTTP endpoint behind bin/shard
src/config.ts             every number in the game (Ruleset)
src/map.ts                symmetric map generation
src/engine.ts             state, turn resolution, combat, production, scoring, behaviour stats
src/observe.ts            fog-of-war briefing, in sections
src/rules.ts              rules text generated from the ruleset + registry
src/match.ts              runs one game: phases, sessions, message routing, logs
src/league.ts             persistent teams, pairings, debriefs, Elo, results
src/debrief.ts            post-game reports, reflections, playbook edits (LLM and mock)
src/metrics.ts            style vectors and Elo
src/agents/               llm.ts (CLI/API/JSON players), cli.ts (claude process wrapper), mock.ts
src/server.ts + public/   spectator UI
src/cli.ts                league CLI;  src/sim.ts  checks + simulator
```
