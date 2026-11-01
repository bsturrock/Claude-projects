import type { Card, Role } from "./types.js";

export const REPAIRS_TO_WIN = 5;
export const BREACHES_TO_WIN = 5;
export const UNREST_LIMIT = 3;
export const HAND_SIZE = 2;
export const INFILTRATOR_DANGER_AT = 3; // breaches after which an approved Infiltrator wins
export const MAX_ROUNDS = 30;

export const DECK: Card[] = [
  ...Array<Card>(12).fill("repair"),
  ...Array<Card>(8).fill("breach"),
];

/** Power the Captain gains when the Nth breach (index = count) is logged. */
export const BREACH_POWERS: Record<number, "scan" | "eject" | undefined> = {
  2: "scan",
  3: "eject",
  4: "eject",
};
/** Power the Captain gains when the Nth repair is logged. */
export const REPAIR_POWERS: Record<number, "scan" | undefined> = {
  3: "scan",
};

export function rolesFor(n: number): Role[] {
  const saboteurs = n >= 7 ? 2 : 1;
  const crew = n - saboteurs - 1;
  return [
    ...Array<Role>(crew).fill("crew"),
    ...Array<Role>(saboteurs).fill("saboteur"),
    "infiltrator",
  ];
}

export const NAMES = ["Ada", "Boris", "Chen", "Dara", "Emeka", "Freya", "Gus", "Hana"];

export const PERSONAS = [
  "methodical and data-driven; likes to track who was on which mission",
  "blunt and impatient; calls out evasive answers",
  "calm mediator; tries to build consensus but notices contradictions",
  "suspicious by nature; slow to trust anyone",
  "friendly and talkative; reads tone and emotional cues",
  "strategic and terse; thinks in probabilities",
  "dry humour; pokes holes in other people's theories",
  "cautious newcomer; asks clarifying questions",
];

export const RULES_TEXT = `GAME: BREACH PROTOCOL (an original hidden-role game)

SETTING: You are one of the crew aboard the failing deep-space station Meridian. Some of the people around you are Saboteurs who want the station to fail. Each mission repairs or damages the station.

TEAMS
- Crew (majority). Win by logging ${REPAIRS_TO_WIN} Repairs, OR by ejecting the Infiltrator.
- Saboteurs. Win by logging ${BREACHES_TO_WIN} Breaches, OR if the Infiltrator is approved onto a mission team (as Captain or Second) once ${INFILTRATOR_DANGER_AT}+ Breaches are logged.
- The Infiltrator is on the Saboteur team. Regular Saboteurs know each other and know who the Infiltrator is. The Infiltrator does NOT know who the Saboteurs are.

CARDS AND HANDS
- Shared deck: 12 Repair and 8 Breach cards. Every player privately holds ${HAND_SIZE} cards. Played cards go to a discard pile, which is reshuffled into the deck when it runs out.
- Because hands are random, an honest Crew member can be stuck holding only Breach cards. Saboteurs can also choose to play Repair to look innocent.

ROUND STRUCTURE
1. Briefing: open discussion. Anyone may speak, accuse, defend, or stay quiet.
2. Nomination: the Captain (rotates around the table each round) nominates one other living player as Second.
   Members of the most recent approved team cannot be nominated as Second (with 5 or fewer players alive, only the previous Second is barred).
3. Debate on the nomination, then everyone alive votes YES or NO simultaneously. Votes are revealed. Strict majority YES approves the team.
   - If rejected: Unrest rises by 1. At ${UNREST_LIMIT} Unrest, the top card of the deck is logged automatically (no powers trigger), Unrest resets, and nomination restrictions clear.
4. Mission: Captain and Second each secretly play ONE card from their hand, then draw back up to ${HAND_SIZE}.
   The two cards are revealed shuffled, so nobody can see who played which. If EITHER card is a Breach, a Breach is logged. Only two Repairs log a Repair.
   Everyone sees how many Breach cards were played (0, 1 or 2).
5. Debrief: Captain and Second each make a public statement (they may lie).
6. Powers (used by the Captain who just ran the mission):
   - 2nd Breach: Scan (privately learn one player's team; the Infiltrator shows as Saboteur). The Captain can share or lie about the result.
   - 3rd and 4th Breach: Eject (remove one player from the game; their role is NOT revealed unless they were the Infiltrator).
   - 3rd Repair: Scan.

TALK
- All conversation is public. You may lie, bluff, or claim anything. Ejected players cannot speak or vote.
- Refer to players by name. Keep each message under 70 words. Stay in character as a station crew member; this is a game of deduction and persuasion.`;
