# Shardlands

An open-ended, three-team hex strategy game built for **persistent teams of Claude agents**. Each team keeps the same three agents for its whole life. After every game, the team debriefs and rewrites a shared playbook, so you can watch strategies form, and possibly split apart, across teams over many games.

## Quick start

```bash
cd shardlands
npm install
npm start                      # spectator UI on http://localhost:3000
```

In the UI: **New league** -> pick backend/model -> **Play**. You can also run everything from the terminal:

```bash
npm run league -- init alpha --teams 3 --backend claude-code --model claude-haiku-5-5
npm run league -- run alpha --games 5
npm run league -- status alpha
npm run sim                    # 60 offline mock games with rule-invariant checks
```

### Backends

| Backend | How it works | Needs |
|---|---|---|
| `claude-code` (default) | Each decision is a one-shot headless `claude -p` call with structured output. It uses whatever account `claude` is logged in as. | Claude Code on PATH |
| `api` | Messages API, with the rules and playbook cached in the system prompt. | `ANTHROPIC_API_KEY` |
| `mock` | Heuristic bots that "learn" by hill-climbing six strategy knobs. Free; used for tests and as a baseline. | Nothing |

**Cost and time (measured):** an 8-turn Haiku game with the council phase took 5 minutes and about $0.46 API-equivalent. A full 30-turn game is about 540 agent calls: around 20 minutes, ~$1.70 on Haiku, and much more on Sonnet or Opus. On a subscription this counts toward your usage limits. To cut cost, use `--council 0` (halves the calls), `--turns 20`, or the `quick` ruleset. `--debrief-model` lets a stronger model write the playbooks while a cheaper one plays.

## The game

Full rules are generated from the ruleset (`src/rules.ts`), so the text agents read always matches the engine. In short:

- **Map:** a radius-7 hex map with exact 3-fold rotational symmetry, so all seats are identical. Fog of war, shared within a team. There are crystal tiles, ruins, and the **Heart** at the center.
- **Agents:** each controls its own settlements, units and stockpile. The team shares tech, vision, diplomacy and VP. Teammates can fund each other with `give`.
- **Economy:** food, wood, ore and crystal. Crystal powers technology and can't be bought from the bank, so it has to come from land, ruins or trade.
- **Units:** scouts, settlers, soldiers, riders and catapults. Each unit has food upkeep. Move orders persist across turns. Movement is simultaneous, and combat is deterministic.
- **Diplomacy:** each pair of teams is at peace or war. Declaring war takes **2 of 3 teammates voting the same turn**, so agents have to coordinate. Peace needs both teams to agree. Promises are never enforced. There are team, public, and private embassy channels.
- **Trade:** offers and accepts between any agents. Cross-team trades earn capped commerce VP, which makes two-team alliances a real strategy.
- **Tech:** 15 techs in 3 tiers with branching prerequisites.
- **VP sources:** land (settlement levels), monuments, the one-per-game Shard Spire, tech, glory (captures, ruins), holding the Heart, and commerce. The game ends at turn 30 or when a team reaches 60 VP.
- **Turn:** a COUNCIL phase (talk only), then an ORDERS phase (simultaneous orders), then resolution. Failed orders are free and reported back to the agent.

Edit numbers by adding `rulesets/<name>.json`, a partial override merged onto the built-in `standard` (see `rulesets/quick.json`).

## How teams learn

Agents are stateless per call. During a game, memory is the agent's own `notes` field, which is fed back each turn. Between games:

1. Each team gets a **private report**: result, VP curves, what every team measurably did, its own channels and embassies, public chat, and its most common failed orders.
2. Each agent writes a reflection, rewrites its **personal memory**, and proposes playbook changes.
3. A rotating **editor** agent rewrites the **team playbook**.
4. The playbook and memories go into every agent's system prompt in the next game.

Teams never see each other's playbooks or private channels. They can still learn about each other from play and from public talk.

Files, per league in `leagues/<name>/`:

```
league.json                      teams + settings
results.jsonl                    one row per game: seats, ranking, VP, style vectors, Elo, changelogs, cost
ratings.json                     current Elo
teams/<team>/playbook.md         current playbook
teams/<team>/memory-<agent>.md   personal memories
teams/<team>/history/<game>.md   reflections + playbook after each game (the evolution record)
games/<game>.json                full replay logs (git-ignored; large)
```

## Measuring whether strategies diverge

What agents *say* goes in the playbooks. What they *do* is measured by the engine. Every game produces a 14-dimension **style vector** per team: spend mix (military, expansion, development, tech), aggression, early war, peace deals, cross-team trade, intra-team gifting, and VP mix. The League tab and `status` show:

- **Elo** (pairwise from placement) over time.
- Each team's **style profile**, and its spending mix trending over games.
- **Strategy divergence**: the mean pairwise distance between teams' style vectors per block of 3 games. Rising means the teams are drifting apart.

Seats rotate so each team plays every seat equally. With more than 3 teams (`--teams 4..8`), each game picks the 3 teams with the fewest games.

**For a clean experiment:** keep the model, effort and settings identical for every team (the default). Then any difference between teams comes only from their own history.

## Spectator UI

- **Game tab:** the hex map (team territory, settlements, units, the selected agent's move orders), a "view as team" fog toggle, and a turn slider for replay. Also the scoreboard and stances, a message/event feed filterable by channel, and per-agent panels with reasoning, messages, orders, engine results, notes, and the exact observation sent.
- **League tab:** ratings, an Elo chart, a divergence chart, a style table, a game list (click to replay), and per-team playbooks, memories and full playbook history.

## Layout

```
src/config.ts     every number in the game (Ruleset)
src/map.ts        symmetric map generation
src/engine.ts     state, order parser, turn resolution, scoring, behaviour stats
src/observe.ts    fog-of-war observation text per agent
src/rules.ts      rules text generated from the ruleset
src/match.ts      runs one game: phases, message routing, logs
src/league.ts     persistent teams, scheduling, debriefs, Elo, results
src/debrief.ts    post-game reports, reflection + playbook editing (LLM and mock)
src/metrics.ts    style vectors, divergence, Elo
src/agents/       llm.ts (Claude Code / API players), cli.ts (claude process wrapper), mock.ts
src/server.ts     spectator server (SSE)          public/   UI
src/cli.ts        league CLI                      src/sim.ts  invariant-checking mock simulator
```
