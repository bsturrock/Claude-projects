import { DEFAULT_STYLE, type MockStyle } from "./agents/mock.js";
import type { Completer } from "./agents/llm.js";
import { agentSystemPrompt } from "./agents/llm.js";
import type { MatchLog } from "./match.js";
import { channelLabelStatic } from "./util.js";
import { describeStyle, styleVector } from "./metrics.js";
import { rng } from "./hex.js";

export interface TeamRecord {
  id: string;
  name: string;
  agents: string[];
}

/** The private post-game report for one team: public facts plus that team's own channels. */
export function gameReport(log: MatchLog, teamId: string, recent: string[]): string {
  const res = log.result!;
  const team = log.teams.find((t) => t.id === teamId)!;
  const name = (id: string) => log.teams.find((t) => t.id === id)?.name ?? id;
  const place = res.ranking.indexOf(teamId) + 1;
  const L: string[] = [];
  L.push(`GAME ${log.id} REPORT FOR TEAM ${team.name}`);
  L.push(`Result: you finished #${place} of 3 after ${res.turns} turns. Final order: ${res.ranking.map((t, i) => `#${i + 1} ${name(t)} ${res.scores[t].total} VP`).join(", ")}.`);
  L.push(`Seats: ${log.teams.map((t, i) => `seat ${i}: ${t.name}`).join(", ")}.`);
  L.push("");
  L.push("FINAL VP BREAKDOWN:");
  for (const t of res.ranking) {
    const b = res.scores[t];
    L.push(`  ${name(t)}: total ${b.total} = settlements ${b.settlements} + monuments ${b.monuments} + spire ${b.spire} + tech ${b.tech} + glory ${b.glory} + heart ${b.heart} + commerce ${b.commerce}`);
  }
  L.push("");
  L.push("VP OVER TIME (every 3 turns):");
  for (const tl of log.turns.filter((t, i, a) => t.turn % 3 === 0 || i === a.length - 1))
    L.push(`  t${tl.turn}: ${tl.snapshot.teams.map((t) => `${t.name} ${t.vp.total}`).join(", ")}; settlements ${tl.snapshot.teams.map((t) => `${t.name} ${tl.snapshot.settlements.filter((s) => s.team === t.id).length}`).join(", ")}`);
  L.push("");
  L.push("WHAT EACH TEAM DID (measured by the engine):");
  for (const t of log.teams) {
    const s = res.stats[t.id];
    const v = styleVector(s, res.scores[t.id], res.turns);
    L.push(`  ${t.name}: spend military ${s.spend.military} / expansion ${s.spend.expansion} / development ${s.spend.development} / tech ${s.spend.tech}; built ${Object.entries(s.unitsBuilt).filter(([, n]) => n).map(([u, n]) => `${n} ${u}`).join(", ") || "nothing"}; founded ${s.settlementsFounded}, captured ${s.captures}, lost ${s.settlementsLost}; wars declared ${s.warsDeclared}${s.firstWarTurn ? ` (first on turn ${s.firstWarTurn})` : ""}, peaces ${s.peacesMade}, betrayals ${s.betrayals}; cross-team trades ${s.tradesCross}; techs in order: ${s.techs.join(" > ") || "none"}. Profile: ${describeStyle(v)}`);
  }
  const mine = res.stats[teamId];
  L.push(`  Your team issued ${mine.ordersIssued} orders; ${mine.orderErrors} failed.`);
  const failures = new Map<string, number>();
  for (const tl of log.turns)
    for (const a of team.agents)
      for (const f of tl.feedback[a] ?? [])
        if (f.startsWith("FAILED")) {
          const why = f.replace(/^FAILED "[^"]*": /, "").replace(/\d+/g, "N");
          failures.set(why, (failures.get(why) ?? 0) + 1);
        }
  if (failures.size)
    L.push(`  Most common failed-order reasons: ${[...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, n]) => `${n}x "${w}"`).join("; ")}`);
  L.push("");
  L.push("KEY EVENTS (public, plus your team's private ones):");
  const key = new Set(["war", "peace", "peace_offer", "capture", "tech", "found", "monument", "spire", "trade", "gift", "end"]);
  const evs = log.turns.flatMap((t) => t.events).filter((e) => (e.vis === null || e.vis === teamId) && key.has(e.kind));
  const combats = log.turns.flatMap((t) => t.events).filter((e) => e.kind === "combat" && ((e.data?.teams as string[]) ?? []).includes(teamId));
  for (const e of evs.slice(0, 120)) L.push(`  t${e.turn}: ${e.text}`);
  if (evs.length > 120) L.push(`  ... ${evs.length - 120} more events`);
  if (combats.length) L.push(`  Your team fought ${combats.length} battles (turns ${[...new Set(combats.map((c) => c.turn))].join(", ")}).`);
  L.push("");
  L.push("MESSAGES (your team channel, your embassies, and public):");
  const msgs = log.turns.flatMap((t) => t.messages).filter((m) => m.channel === "public" || m.channel === `team:${teamId}` || (m.channel.startsWith("embassy:") && m.channel.includes(teamId)));
  let budget = 9000;
  for (const m of msgs) {
    const line = `  [t${m.turn} ${channelLabelStatic(m.channel, log.teams)}] ${m.from}: ${m.text.slice(0, 300)}`;
    if ((budget -= line.length) < 0) {
      L.push("  ... (later messages truncated)");
      break;
    }
    L.push(line);
  }
  L.push("");
  L.push("YOUR TEAM'S FINAL IN-GAME NOTES:");
  for (const a of team.agents) {
    const last = [...log.turns].reverse().flatMap((t) => t.decisions).find((d) => d.agent === a && d.notes?.trim());
    L.push(`  ${a}: ${last?.notes?.trim().slice(0, 800) ?? "(none)"}`);
  }
  if (recent.length) {
    L.push("");
    L.push("YOUR TEAM'S RECENT LEAGUE RESULTS (most recent last):");
    for (const r of recent) L.push(`  ${r}`);
  }
  return L.join("\n");
}

const REFLECT_SCHEMA = {
  type: "object",
  properties: {
    reflection: { type: "string", description: "What worked, what failed and why (under 200 words)." },
    memory: { type: "string", description: "Your rewritten personal memory for future games (under 250 words). Replaces the old one." },
    playbook_proposals: { type: "string", description: "Concrete changes you propose to the team playbook (under 200 words)." },
  },
  required: ["reflection", "memory", "playbook_proposals"],
  additionalProperties: false,
} as const;

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    playbook: { type: "string", description: "The complete new team playbook in Markdown (under 900 words). Replaces the old one." },
    changelog: { type: "string", description: "One or two sentences: what changed and why." },
  },
  required: ["playbook", "changelog"],
  additionalProperties: false,
} as const;

export interface DebriefResult {
  playbook: string;
  changelog: string;
  memories: Record<string, string>;
  reflections: Record<string, { reflection: string; proposals: string }>;
  editor: string;
}

/** LLM debrief: each agent reflects privately, then one rotating "editor" rewrites the playbook. */
export async function llmDebrief(
  completer: Completer,
  rules: string,
  team: TeamRecord,
  playbook: string,
  memories: Record<string, string>,
  report: string,
  gameNumber: number,
): Promise<DebriefResult> {
  const reflections: DebriefResult["reflections"] = {};
  const newMem: Record<string, string> = {};
  await Promise.all(
    team.agents.map(async (a) => {
      const sys = agentSystemPrompt(rules, a, team.name, playbook, memories[a] ?? "");
      const prompt = `${report}\n\nPOST-GAME DEBRIEF. Reflect honestly on this game. Rewrite your personal memory (keep lessons that still hold, drop ones that proved wrong) and propose concrete changes to your team's playbook. You may also record what you learned about the other teams; you will likely meet them again. Answer with the JSON object only.`;
      try {
        const { output } = await completer.complete(sys, prompt, REFLECT_SCHEMA, `${a}-debrief`);
        reflections[a] = { reflection: String(output.reflection ?? ""), proposals: String(output.playbook_proposals ?? "") };
        newMem[a] = String(output.memory ?? memories[a] ?? "").slice(0, 3000);
      } catch (err) {
        reflections[a] = { reflection: `(debrief failed: ${String(err).slice(0, 150)})`, proposals: "" };
        newMem[a] = memories[a] ?? "";
      }
    }),
  );
  const editor = team.agents[gameNumber % team.agents.length];
  const sys = agentSystemPrompt(rules, editor, team.name, playbook, newMem[editor] ?? "");
  const prompt = `${report}

TEAMMATE REFLECTIONS:
${team.agents.map((a) => `--- ${a}\nReflection: ${reflections[a].reflection}\nProposed playbook changes: ${reflections[a].proposals}`).join("\n")}

You are this game's playbook EDITOR. Rewrite the team playbook, combining your teammates' proposals with your own judgement. It is read by all three of you at the start of every game, so it should be practical: openings, priorities, role split between the three of you, how to handle each opponent team, diplomacy rules, and mistakes to avoid. Keep what is working. Do not just append; consolidate. Answer with the JSON object only.`;
  try {
    const { output } = await completer.complete(sys, prompt, EDIT_SCHEMA, `${editor}-editor`);
    return { playbook: String(output.playbook ?? playbook).slice(0, 9000), changelog: String(output.changelog ?? ""), memories: newMem, reflections, editor };
  } catch (err) {
    return { playbook, changelog: `(editor failed: ${String(err).slice(0, 150)})`, memories: newMem, reflections, editor };
  }
}

/** Mock "learning": a noisy hill-climb on the bot's strategy knobs, kept if it placed well. */
export function mockDebrief(style: MockStyle | null, best: MockStyle | null, place: number, seed: number): { style: MockStyle; best: MockStyle } {
  const r = rng(seed);
  const cur = style ?? { ...DEFAULT_STYLE };
  let base = best ?? cur;
  if (place === 1) base = cur;
  const next: MockStyle = { ...base };
  const keys = Object.keys(next) as (keyof MockStyle)[];
  for (const k of keys) {
    const span = k === "expand" ? 1.2 : 0.18;
    next[k] = next[k] + (r() - 0.5) * 2 * span * (place === 1 ? 0.5 : 1);
    next[k] = k === "expand" ? Math.max(1, Math.min(6, next[k])) : Math.max(0, Math.min(1, next[k]));
  }
  return { style: next, best: base };
}

export function mockPlaybook(style: MockStyle): string {
  return `# Heuristic team (mock)\n\nStrategy knobs, tuned by hill-climbing after each game:\n\n\`\`\`json\n${JSON.stringify(Object.fromEntries(Object.entries(style).map(([k, v]) => [k, Math.round(v * 100) / 100])), null, 2)}\n\`\`\`\n`;
}
