import { LEVELS, UNIT_TYPES, type Ruleset } from "./config.js";
import { fmtBundle } from "./bundle.js";
import { ordersReference } from "./commands/index.js";

/** Full rules handed to every agent. Generated from the ruleset and the command registry, so it always matches the engine. */
export function rulesText(R: Ruleset): string {
  const u = R.units;
  const unitLines = UNIT_TYPES.map((t) => {
    const s = u[t];
    return `- ${t}: cost ${fmtBundle(s.cost)}; strength ${s.str}, HP ${s.hp}, move ${s.move}, sight ${s.sight}${s.siege ? `, deals x${s.siege} damage to settlements` : ""}${s.requires ? ` (needs ${s.requires})` : ""}`;
  }).join("\n");
  const techLines = Object.entries(R.techs)
    .map(([id, t]) => {
      const req = t.requiresAll?.length ? `needs ALL of ${t.requiresAll.join(", ")}` : t.requiresAny?.length ? `needs ANY of ${t.requiresAny.join(", ")}` : "no prerequisite";
      return `- ${id} (tier ${t.tier}, ${R.vp.techTier[t.tier]} VP): cost ${fmtBundle(t.cost)}; ${req}. ${t.text}`;
    })
    .join("\n");
  const S = R.settlement;
  const B = R.buildings;
  return `SHARDLANDS: RULES

OVERVIEW
Two teams of ${R.agentsPerTeam} agents fight over one hex map. Each agent controls its own settlements, units and stockpile; the team shares technology, vision and victory points (VP). A team wins by reaching ${R.vpTarget} VP (checked at the end of each turn), by eliminating the enemy (no settlements and no units left), or by having more VP after turn ${R.turns}. Ties on VP are broken by total stockpile; a full tie is a draw. Many strategies can win: expansion, conquest, raiding, technology, wonders and holding the Heart all score.

MAP
Axial hex coordinates (q,r). The six neighbours of (q,r) are (q+1,r) (q-1,r) (q,r+1) (q,r-1) (q+1,r-1) (q-1,r+1). Distance between (q1,r1) and (q2,r2) = (|q1-q2| + |r1-r2| + |q1+r1-q2-r2|) / 2. The map is a hexagon of radius ${R.mapRadius} centred on (0,0). It is point-symmetric: the south half is the north half rotated 180 degrees, so both teams start in identical positions, one team in the north (negative r) and one in the south.
Terrain: plains (2 food), forest (2 wood), hills (2 ore; units defending on hills get +${R.hillsDefenseBonus} strength each), water (1 food, impassable), mountain (impassable, yields nothing), crystal (1 crystal), ruins (explore once for loot), and the Heart at (0,0) (3 crystal; the team holding a settlement on it gets ${R.vp.heartPerTurn} VP every turn).
You see everything within sight range of your team's units and settlements (settlements see ${S.sight}). Explored tiles you cannot currently see show the terrain and the last settlement you saw there.

TRUCE AND WAR
Turns 1-${R.truceTurns} are a truce: no combat, and enemy settlement hexes cannot be entered. From turn ${R.truceTurns + 1} on the teams are permanently at war: whenever units or settlements of both teams share a hex after movement, they fight.

RESOURCES
food, wood, ore, crystal. Each agent has a private stockpile; "give" moves resources to a teammate (gifts resolve before anyone's purchases, so you can fund a teammate's order the same turn). Crystal is scarce and powers technology.
Bank: "exchange" any resource at ${R.bankRate}:1 (${R.currencyBankRate}:1 with currency): give that many of one resource, get 1 of another. The bank never sells crystal.

SETTLEMENTS
A settler founds a village on the hex it stands on ("found <unit>"; the settler is used up). It must be at least ${R.minSettlementDistance} hexes from every other settlement and not on water, mountain or unexplored ruins. A settlement claims its own hex and the 6 neighbours (tiles not already claimed). Every claimed tile yields its terrain's resources to the owner each turn.
Levels: ${LEVELS.join(" -> ")}. Each level above village adds +${R.levelBonusPerTile} food/wood/ore to every producing claimed tile (crystal is not boosted).
- upgrade village to town: ${fmtBundle(S.upgradeCost.town)}. Town to city: ${fmtBundle(S.upgradeCost.city)} and needs ${S.cityRequires}.
- HP: village ${S.hp.village}, town ${S.hp.town}, city ${S.hp.city}. Defense (damage it deals to attackers each combat): ${S.defense.village}/${S.defense.town}/${S.defense.city}. Settlements regain ${S.regen} HP per turn when not attacked.
- walls: ${fmtBundle(B.walls.cost)} -> +${B.walls.hp} HP, +${B.walls.defense} defense.
- monument: ${fmtBundle(B.monument.cost)}, needs ${B.monument.requires} -> ${B.monument.vp} VP while your team holds that settlement.
- Shard Spire: ${fmtBundle(B.spire.cost)}, needs ${B.spire.requires} and a ${B.spire.level}. Only ONE may exist in the game. ${B.spire.vp} VP while held.
Each settlement can build one unit per turn. New units appear at the end of the turn.
A settlement that was in combat this turn produces nothing. A claimed tile with an enemy unit standing on it produces nothing (raiding).

UNITS
${unitLines}
Every unit costs ${R.upkeepPerUnit} food per turn in upkeep, paid by its owner. If you cannot pay, food drops to 0 and all your units lose 1 HP.
Units heal ${R.healPerTurn} HP per turn inside your team's territory when not in combat. At most ${R.maxStack} units of one team can share a hex.
"move <unit> q,r" gives a standing order: the unit walks the shortest path, using its full move each turn, and keeps going on later turns until it arrives or you change the order. Once the truce is over, a unit stops as soon as it enters a hex containing enemy units or an enemy settlement.

COMBAT
Combat happens after movement on every hex where both teams are present. Both sides strike simultaneously, once per turn. A side's damage = the sum of its units' strength (+ hill bonus for units that started the turn there, + settlement defense if it is defending its settlement). Damage is applied to the enemy's units one at a time (military units first, sturdiest first); a unit absorbs damage up to its HP and dies at 0. Damage left over hits the enemy settlement on that hex. Catapult damage goes straight to the settlement. Combat continues on later turns while both sides remain.
A settlement at 0 HP with no defending units and at least one enemy military unit present is CAPTURED by the attacking agent with the most strength there: it drops one level (min village), loses its walls, keeps monuments/spire, and the captor's team gains ${R.vp.capture} glory VP. Its VP now count for the captor.

TECHNOLOGY (team-wide; any one teammate pays the full cost with "research <tech>")
${techLines}

VICTORY POINTS
- Settlements held: village ${R.vp.settlement.village}, town ${R.vp.settlement.town}, city ${R.vp.settlement.city}.
- Monuments ${B.monument.vp} each, Shard Spire ${B.spire.vp} (while held).
- Technologies: ${R.vp.techTier[1]}/${R.vp.techTier[2]}/${R.vp.techTier[3]} VP for tier 1/2/3.
- Glory (permanent): ${R.vp.capture} per settlement captured, ${R.ruinLoot.vp} per ruin explored (ruins give ${R.ruinLoot.min}-${R.ruinLoot.max} random resources).
- Heart (permanent): ${R.vp.heartPerTurn} per turn holding a settlement on (0,0).

TURN ORDER
Each turn has two phases. COUNCIL: everyone talks (team channel, or the public channel the enemy also reads); orders are not accepted. ORDERS: everyone queues orders at the same time (messages sent now arrive next turn). Resolution: 1 gifts, 2 each agent's exchanges, research, upgrades, constructions, unit purchases and disbands in the order queued, 3 settlers found, 4 move orders are set and all units step together, 5 combat and captures, 6 new units appear, 7 ruins, 8 production, upkeep, healing, 9 Heart VP, 10 scoring.

ORDERS (queued with the shard CLI; up to ${R.maxOrdersPerTurn} per turn)
${ordersReference()}
Use ids exactly as shown (u12, s3, agent ids). Orders are checked when you queue them; anything that still fails at resolution costs nothing and is reported back to you.`;
}
