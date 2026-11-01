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
   */
  missionMode: "simultaneous" | "supply" | "split";
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
  if (rs.missionMode === "split") {
    rs.splitCaptainDraw ??= 2;
    rs.splitSecondDraw ??= 1;
    if (rs.splitCaptainDraw < 1 || rs.splitSecondDraw < 0) fail("split draws must be >= 1 (captain) and >= 0 (second)");
    if (rs.splitSecondDraw === 0 && rs.splitCaptainDraw < 2) fail("the Second needs at least 2 cards to choose from");
    if (total < 8 * rs.handSize + rs.splitCaptainDraw + rs.splitSecondDraw + 2) fail("deck too small for 8 players");
  } else {
    if (rs.handSize < 1) fail("handSize must be >= 1 unless missionMode is split");
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
  const mission =
    rs.missionMode === "split"
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
    rs.missionMode === "split"
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
3. Debate on the nomination, then everyone alive votes YES or NO simultaneously. Votes are revealed. Strict majority YES approves the team.
   - If rejected: Unrest rises by 1. At ${rs.unrestLimit} Unrest, the top card of the deck is logged automatically (no powers trigger), Unrest resets, and nomination restrictions clear.
${mission}${rs.missionMode === "split" ? "" : "\n   Everyone sees how many Breach cards were played (0, 1 or 2)."}
5. Debrief: Captain and Second each make a public statement (they may lie).
6. Powers (used by the Captain who just ran the mission). SCAN = privately learn one player's team (the Infiltrator shows as Saboteur; the Captain may share or lie about it). EJECT = remove one player from the game (role not revealed unless they were the Infiltrator).
${powersText(rs)}

TALK
- All conversation is public. You may lie, bluff, or claim anything. Ejected players cannot speak or vote.
- Refer to players by name. Keep each message under 70 words. Stay in character as a station crew member; this is a game of deduction and persuasion.
- Good play: track every claim (crate contents, cards passed, received and drawn, scan results) and look for claims that cannot all be true. Compare them with the public mission and vote record you are given each turn.`;
}
