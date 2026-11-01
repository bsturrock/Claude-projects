import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Role } from "./types.js";

/**
 * Every tunable rule lives in a JSON file under /rulesets. The engine, the agents' rules text,
 * and the UI all read from the same Ruleset, so editing a JSON file changes the whole game.
 */
export interface Ruleset {
  name: string;
  description: string;
  deck: { repair: number; breach: number };
  handSize: number;
  /**
   * "simultaneous": Captain and Second each play one card from their hand, then refill.
   * "supply": Captain draws N crate cards, secretly hands one to the Second and keeps the rest;
   *           then both play one card from their hand (no refill needed).
   * "split":  No hands. Captain draws splitCaptainDraw cards and secretly passes one to the Second
   *           (the rest are discarded face down). The Second draws splitSecondDraw more, then plays
   *           ONE of the cards they hold; that card is logged.
   * "paired": No hands. Captain draws splitCaptainDraw cards, keeps ONE and secretly passes ONE to the
   *           Second (any others are discarded). The Second draws splitSecondDraw more. Both secretly play
   *           one card; the two are revealed shuffled and resolved like a two-card mission.
   */
  missionMode: "simultaneous" | "supply" | "split" | "paired";
  supplyCrateSize: number;
  splitCaptainDraw?: number;
  splitSecondDraw?: number;
  /** "any_breach": one Breach card logs a Breach. "both_breach": both cards must be Breach. */
  resolution: "any_breach" | "both_breach";
  repairsToWin: number;
  breachesToWin: number;
  unrestLimit: number;
  /** Breaches logged after which an approved Infiltrator wins for the Saboteurs. 0 disables. */
  infiltratorDangerAt: number;
  breachPowers: Record<string, "scan" | "eject">;
  repairPowers: Record<string, "scan" | "eject">;
  /** Saboteurs (excluding the Infiltrator) per player count. */
  saboteurs: Record<string, number>;
  /** "team": last Captain and Second barred from Second (only last Second when <=5 alive). "second": only last Second. "none". */
  termLimits: "team" | "second" | "none";
  discussion: { briefingPerPlayer: number; debatePerPlayer: number };
  maxRounds: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const RULESETS_DIR = path.join(here, "..", "rulesets");

export function listRulesets(): { id: string; name: string; description: string }[] {
  return readdirSync(RULESETS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const rs = loadRuleset(f.replace(/\.json$/, ""));
      return { id: f.replace(/\.json$/, ""), name: rs.name, description: rs.description };
    });
}

export function loadRuleset(id: string): Ruleset {
  if (!/^[\w-]+$/.test(id)) throw new Error(`bad ruleset id: ${id}`);
  const rs = JSON.parse(readFileSync(path.join(RULESETS_DIR, `${id}.json`), "utf8")) as Ruleset;
  validate(rs, id);
  return rs;
}

function validate(rs: Ruleset, id: string) {
  const fail = (m: string) => {
    throw new Error(`ruleset ${id}: ${m}`);
  };
  const total = rs.deck.repair + rs.deck.breach;
  if (rs.missionMode === "split" || rs.missionMode === "paired") {
    rs.splitCaptainDraw ??= 2;
    rs.splitSecondDraw ??= 1;
    if (rs.splitCaptainDraw < 1 || rs.splitSecondDraw < 0) fail("split draws must be >= 1 (captain) and >= 0 (second)");
    if (rs.missionMode === "split" && rs.splitSecondDraw === 0 && rs.splitCaptainDraw < 2) fail("the Second needs at least 2 cards to choose from");
    if (rs.missionMode === "paired" && rs.splitCaptainDraw < 2) fail("paired mode needs splitCaptainDraw >= 2 (keep one, pass one)");
    if (total < 8 * rs.handSize + rs.splitCaptainDraw + rs.splitSecondDraw + 2) fail("deck too small for 8 players");
  } else {
    if (rs.handSize < 1) fail("handSize must be >= 1 unless missionMode is split or paired");
    if (total < 8 * rs.handSize + rs.supplyCrateSize + 2) fail("deck too small for 8 players");
  }
  if (rs.missionMode === "supply" && rs.supplyCrateSize < 2) fail("supplyCrateSize must be >= 2");
  for (const n of ["5", "6", "7", "8"]) if (rs.saboteurs[n] === undefined) fail(`saboteurs missing count for ${n}`);
}

export function rolesFor(rs: Ruleset, n: number): Role[] {
  const sabs = rs.saboteurs[String(n)];
  return [...Array<Role>(n - sabs - 1).fill("crew"), ...Array<Role>(sabs).fill("saboteur"), "infiltrator"];
}

const ord = (n: string) => `${n}${n === "1" ? "st" : n === "2" ? "nd" : n === "3" ? "rd" : "th"}`;

function powersText(rs: Ruleset): string {
  const lines: string[] = [];
  for (const [n, p] of Object.entries(rs.breachPowers)) lines.push(`   - ${ord(n)} Breach: ${p.toUpperCase()}`);
  for (const [n, p] of Object.entries(rs.repairPowers)) lines.push(`   - ${ord(n)} Repair: ${p.toUpperCase()}`);
  return lines.join("\n") || "   - none";
}

/** The rules as given to every agent, generated from the ruleset so they always match the engine. */
export function rulesText(rs: Ruleset): string {
  const resolution =
    rs.resolution === "any_breach"
      ? "If EITHER card is a Breach, a Breach is logged. Only two Repairs log a Repair."
      : "Only if BOTH cards are Breach is a Breach logged. Otherwise a Repair is logged.";
  const split = `4. Mission (Split Crate). Nobody holds cards between missions.
   a. The Captain privately draws ${rs.splitCaptainDraw} card(s) (the "crate"), secretly passes ONE to the Second, and discards the rest face down. Only the Captain knows the crate.
   b. The Second privately draws ${rs.splitSecondDraw} more card(s), then secretly plays ONE of the ${(rs.splitSecondDraw ?? 0) + 1} cards they hold; the rest are discarded face down. Only the Second knows what they were passed and drew.
   c. The played card is revealed and logged (Repair or Breach). Everyone knows the Second chose it, but not what the Second had to choose from or what the Captain passed.`;
  const paired = `4. Mission (Paired Play). Nobody holds cards between missions.
   a. The Captain privately draws ${rs.splitCaptainDraw} cards, KEEPS one and secretly passes ONE to the Second${(rs.splitCaptainDraw ?? 2) > 2 ? " (the rest are discarded face down)" : ""}. Only the Captain knows what was drawn.
   b. The Second privately draws ${rs.splitSecondDraw} more card(s), so they hold ${(rs.splitSecondDraw ?? 1) + 1}.
   c. The Captain plays the card they kept; the Second secretly plays ONE of their cards (the rest are discarded face down).
   d. The two played cards are revealed shuffled, so nobody sees who played which. ${resolution}`;
  const mission =
    rs.missionMode === "paired"
      ? paired
      : rs.missionMode === "split"
      ? split
      : rs.missionMode === "supply"
      ? `4. Mission (Supply Crate):
   a. The Captain privately draws ${rs.supplyCrateSize} cards from the deck (the "crate").
   b. The Captain secretly hands ONE crate card to the Second and keeps the rest in their own hand. Only the Captain knows the crate; only the Second knows what they received.
   c. Captain and Second each secretly play ONE card from their hand (the Captain now holds ${rs.handSize + rs.supplyCrateSize - 1} cards, the Second ${rs.handSize + 1}).${rs.supplyCrateSize > 2 ? ` Afterwards the Captain's extra cards beyond ${rs.handSize} are discarded face down at random.` : ""}
   d. The two played cards are revealed shuffled, so nobody sees who played which. ${resolution}`
      : `4. Mission: Captain and Second each secretly play ONE card from their hand, then draw back up to ${rs.handSize}.
   The two cards are revealed shuffled, so nobody can see who played which. ${resolution}`;
  const term =
    rs.termLimits === "team"
      ? "Members of the most recent approved team cannot be nominated as Second (with 5 or fewer players alive, only the previous Second is barred)."
      : rs.termLimits === "second"
        ? "The previous approved Second cannot be nominated as Second again."
        : "Anyone except the Captain may be nominated.";
  return `GAME: BREACH PROTOCOL (an original hidden-role game). Ruleset: ${rs.name}.

SETTING: You are one of the crew aboard the failing deep-space station Meridian. Some of the people around you are Saboteurs who want the station to fail. Each mission repairs or damages the station.

TEAMS
- Crew (majority). Win by logging ${rs.repairsToWin} Repairs, OR by ejecting the Infiltrator.
- Saboteurs. Win by logging ${rs.breachesToWin} Breaches${rs.infiltratorDangerAt > 0 ? `, OR if the Infiltrator is approved onto a mission team (as Captain or Second) once ${rs.infiltratorDangerAt}+ Breaches are logged` : ""}.
- The Infiltrator is on the Saboteur team. Regular Saboteurs know each other and know who the Infiltrator is. The Infiltrator does NOT know who the Saboteurs are.

${
    rs.missionMode === "split" || rs.missionMode === "paired"
      ? `CARDS
- Shared deck: ${rs.deck.repair} Repair and ${rs.deck.breach} Breach cards. Players do not hold hands. Used and discarded cards go to a discard pile, which is reshuffled into the deck when it runs out.
- Because draws are random, an honest Captain or Second can be left with only Breach cards. Saboteurs can also choose Repair to look innocent.`
      : `CARDS AND HANDS
- Shared deck: ${rs.deck.repair} Repair and ${rs.deck.breach} Breach cards. Every player privately holds ${rs.handSize} cards. Played cards go to a discard pile, which is reshuffled into the deck when it runs out.
- Because hands are random, an honest Crew member can be stuck holding only Breach cards. Saboteurs can also choose to play Repair to look innocent.`
  }

ROUND STRUCTURE
1. Briefing: open discussion. Anyone may speak, accuse, defend, or stay quiet.
2. Nomination: the Captain (rotates around the table each round) nominates one other living player as Second. ${term}
3. Debate on the nomination (anyone named in a message gets one extra reply even after using their messages, and the Captain gets a final word right before the vote), then everyone alive votes YES or NO simultaneously. Votes are revealed. Strict majority YES approves the team.
   - If rejected: Unrest rises by 1. At ${rs.unrestLimit} Unrest, the top card of the deck is logged automatically (no powers trigger), Unrest resets, and nomination restrictions clear.
${mission}${rs.missionMode === "split" ? "" : "\n   Everyone sees how many Breach cards were played (0, 1 or 2)."}
5. Debrief: Captain and Second each make a public statement (they may lie).
6. Powers (used by the Captain who just ran the mission). SCAN = privately learn one player's team (the Infiltrator shows as Saboteur; the Captain may share or lie about it). EJECT = remove one player from the game (role not revealed unless they were the Infiltrator).
${powersText(rs)}

TALK
- All conversation is public. You may lie, bluff, or claim anything. Ejected players cannot speak or vote.
- Refer to players by name. Keep each message under 70 words. Stay in character as a station crew member; this is a game of deduction and persuasion.
- Good play: track every claim (crate contents, cards passed, received and drawn, scan results) and look for claims that cannot all be true. Compare them with the public mission and vote record you are given each turn.

${strategyText(rs)}`;
}

/** Strategy guidance for both teams, tailored to the mission mode. Every player sees all of it. */
export function strategyText(rs: Ruleset): string {
  const split = rs.missionMode === "split";
  const paired = rs.missionMode === "paired";
  const crewMission = paired
    ? `- A Breach means the Captain kept a Breach, or the Second played one, or both. Compare their claims: the Captain's draw, the card passed, and the Second's draw must all fit the cards revealed. A Captain who claims they kept a Repair while one Breach shows is accusing their Second, and vice versa.
- Two Breaches revealed means both played a Breach. At least one of them chose it unless every card they saw was a Breach.`
    : split
    ? `- The Second's choice is the key fact. If the Second held a Repair and played a Breach, they are almost certainly a Saboteur. If Captain and Second tell different stories about the passed card, one of them is lying: look at who benefits and at each player's record.`
    : `- When a Breach appears, compare both team members' claims. Claims that cannot both be true mean one of them is lying.`;
  const sabMission = paired
    ? `- As Captain, if you draw a Breach you can KEEP it and guarantee a Breach is played. Then pass your partner the other card and blame the Second: "I kept the Repair and passed the Breach."
- As Second, if you hold a Breach you can play it and blame the Captain: "I was passed a Repair and drew a Repair, so the Breach was the Captain's."
- One Breach out of two is deniable for both of you. Two Breaches are harder to explain, so only play a Breach with a Saboteur partner if you have agreed a story through how you talk.
- Never admit to choosing a Breach while holding a Repair. That is a confession.`
    : split
    ? `- Never admit to choosing a Breach while holding a Repair. That is a confession.
- As Second after playing a Breach: say you had no choice. Claim the Captain passed you a Breach and you drew a Breach. If the Captain already said they passed a Repair, contradict them anyway: it becomes their word against yours, and nobody can check either hand.
- As Captain after a Breach: claim the crate held two Breaches so you were forced to pass one, or claim you passed a Repair so the Second must have chosen the Breach.
- As Captain you can also pass a Breach to an honest Second. If they also draw a Breach they are forced to play it and will take the blame.`
    : `- Never admit to playing a Breach by choice. Claim your hand forced it, or cast doubt on your partner.`;
  return `STRATEGY
For the Crew:
${crewMission}
- Votes are public. Notice who keeps approving teams that produce Breaches, and who protects whom.
- Share scan results, but remember a scanning Captain may be lying.

For the Saboteurs and the Infiltrator:
${sabMission}
- Before every claim, check it against everything public: the card(s) revealed, how many cards each person drew, and what you claimed in earlier rounds. Keep your story consistent across the whole game.
- Pick your moments. Playing Repair early builds trust you can spend later; a Breach is worth most when it pushes toward ${rs.breachesToWin} Breaches${rs.infiltratorDangerAt > 0 ? ` or toward the ${rs.infiltratorDangerAt}-Breach Infiltrator threshold` : ""}.
- A false scan result can split the table, but only accuse someone the table can believe is guilty.
- Regular Saboteurs: protect the Infiltrator quietly. Don't vote as an obvious bloc or defend each other every time.`;
}
