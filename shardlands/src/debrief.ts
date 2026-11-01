import { DEFAULT_STYLE, type MockStyle } from "./agents/mock.js";
import { agentSystemPrompt, type AgentInterface, type Completer } from "./agents/llm.js";
import { rng } from "./hex.js";
import type { MatchLog } from "./match.js";
import { describeStyle, styleVector } from "./metrics.js";

export interface TeamRecord {
  id: string;
  name: string;
  agents: string[];
}

/** The private post-game report for one team: public facts plus that team's own channel. */
export function gameReport(log: MatchLog, teamId: string, history: string[]): string {
  const res = log.result!;
  const team = log.teams.find((t) => t.id === teamId)!;
  const enemy = log.teams.find((t) => t.id !== teamId)!;
  const name = (id: string) => log.teams.find((t) => t.id === id)?.name ?? id;
  const L: string[] = [];
  L.push(`GAME ${log.id} REPORT FOR TEAM ${team.name} (vs ${enemy.name})`);
  const outcome = res.draw ? "DRAW" : res.winner === teamId ? "WIN" : "LOSS";
  L.push(`Result: ${outcome} after ${res.turns} turns. ${team.name} ${res.scores[teamId].total} VP, ${enemy.name} ${res.scores[enemy.id].total} VP.`);
  L.push(`You played the ${log.teams[0].id === teamId ? "north" : "south"} seat.`);
  L.push("");
  L.push("FINAL VP BREAKDOWN:");
  for (const t of log.teams) {
    const b = res.scores[t.id];
    L.push(`  ${t.name}: total ${b.total} = settlements ${b.settlements} + monuments ${b.monuments} + spire ${b.spire} + tech ${b.tech} + glory ${b.glory} + heart ${b.heart}`);
  }
  L.push("");
  L.push("VP AND SETTLEMENTS OVER TIME (every 3 turns):");
  for (const tl of log.turns.filter((t, i, a) => t.turn % 3 === 0 || i === a.length - 1))
    L.push(`  t${tl.turn}: ${tl.snapshot.teams.map((t) => `${t.name} ${t.vp.total} VP / ${tl.snapshot.settlements.filter((s) => s.team === t.id).length} settlements / ${tl.snapshot.units.filter((u) => u.team === t.id && u.type !== "scout" && u.type !== "settler").length} military`).join("; ")}`);
  L.push("");
  L.push("WHAT EACH TEAM DID (measured by the engine):");
  for (const t of log.teams) {
    const s = res.stats[t.id];
    const v = styleVector(s, res.scores[t.id], res.turns);
    L.push(
      `  ${t.name}: spend military ${s.spend.military} / expansion ${s.spend.expansion} / development ${s.spend.development} / tech ${s.spend.tech}; built ${Object.entries(s.unitsBuilt).filter(([, n]) => n).map(([u, n]) => `${n} ${u}`).join(", ") || "nothing"}; founded ${s.settlementsFounded}, captured ${s.captures}, lost ${s.settlementsLost}; attacks ${s.attacks}${s.firstAttackTurn ? ` (first on turn ${s.firstAttackTurn})` : ""}; units killed ${s.unitsKilled}, lost ${s.unitsLost}; raided enemy tiles ${s.raidTileTurns} tile-turns; held the Heart ${s.heartTurns} turns; techs in order: ${s.techs.join(" > ") || "none"}. Profile: ${describeStyle(v)}`,
    );
  }
  const mine = res.stats[teamId];
  L.push(`  Your team issued ${mine.ordersIssued} orders; ${mine.orderErrors} failed at resolution.`);
  const failures = new Map<string, number>();
  for (const tl of log.turns)
    for (const a of team.agents)
      for (const f of tl.feedback[a] ?? [])
        if (f.startsWith("FAILED")) {
          const why = f.replace(/^FAILED "[^"]*": /, "").replace(/\d+/g, "N");
          failures.set(why, (failures.get(why) ?? 0) + 1);
        }
  if (failures.size) L.push(`  Most common failure reasons: ${[...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, n]) => `${n}x "${w}"`).join("; ")}`);
  L.push("");
  L.push("KEY EVENTS:");
  const keyKinds = new Set(["truce", "capture", "tech", "found", "monument", "spire", "ruins", "end"]);
  const evs = log.turns.flatMap((t) => t.events).filter((e) => (e.vis === null || e.vis === teamId) && keyKinds.has(e.kind));
  for (const e of evs.slice(0, 120)) L.push(`  t${e.turn}: ${e.text}`);
  if (evs.length > 120) L.push(`  ... ${evs.length - 120} more events`);
  const battles = log.turns.flatMap((t) => t.events).filter((e) => e.kind === "combat");
  if (battles.length) L.push(`  ${battles.length} battles were fought (turns ${[...new Set(battles.map((c) => c.turn))].join(", ")}).`);
  L.push("");
  L.push("MESSAGES (your team channel and the public channel):");
  const msgs = log.turns.flatMap((t) => t.messages).filter((m) => m.channel === "public" || m.channel === `team:${teamId}`);
  let budget = 10000;
  for (const m of msgs) {
    const line = `  [t${m.turn} ${m.channel === "public" ? "public" : "team"}] ${m.from}: ${m.text.slice(0, 300)}`;
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
  void name;
  if (history.length) {
    L.push("");
    L.push("YOUR TEAM'S LEAGUE HISTORY (most recent last):");
    for (const r of history) L.push(`  ${r}`);
  }
  return L.join("\n");
}

const REFLECT_SCHEMA = {
  type: "object",
  properties: {
    reflection: { type: "string", description: "Your reflection on this game, shared with your teammates." },
    memory: { type: "string", description: "Your personal memory for future games (under 250 words). Replaces the old one. Only you read it." },
  },
  required: ["reflection", "memory"],
  additionalProperties: false,
} as const;

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["keep", "rewrite"] },
    playbook: { type: "string", description: 'The complete new playbook (under 900 words) if action is "rewrite"; otherwise empty.' },
    changelog: { type: "string", description: "What you changed and why, or why you kept it. Your teammates see this." },
  },
  required: ["action", "playbook", "changelog"],
  additionalProperties: false,
} as const;

export interface DebriefResult {
  playbook: string;
  changelog: string;
  memories: Record<string, string>;
  reflections: Record<string, { reflection: string }>;
  edits: { agent: string; action: string; changelog: string }[];
}

/**
 * LLM debrief. No roles and no prescribed process: every agent reflects (shared with the team)
 * and rewrites its own memory, then every agent in a random order may rewrite the team
 * playbook or keep it, seeing the edits made before it. How the team organises itself is
 * whatever the team writes into the playbook.
 */
export async function llmDebrief(
  completer: Completer,
  rules: string,
  team: TeamRecord,
  playbook: string,
  memories: Record<string, string>,
  report: string,
  iface: AgentInterface,
  seed: number,
): Promise<DebriefResult> {
  const reflections: DebriefResult["reflections"] = {};
  const newMem: Record<string, string> = {};
  const sysFor = (a: string, pb: string, mem: string) => agentSystemPrompt(rules, a, team.name, team.agents.length, pb, mem, iface);
  await Promise.all(
    team.agents.map(async (a) => {
      const prompt = `${report}\n\nPOST-GAME. Write a reflection on this game (your teammates will read it) and your personal memory for future games (only you will read it). Answer with the JSON object only.`;
      try {
        const { output } = await completer.complete(sysFor(a, playbook, memories[a] ?? ""), prompt, REFLECT_SCHEMA, `${a}-debrief`);
        reflections[a] = { reflection: String(output.reflection ?? "") };
        newMem[a] = String(output.memory ?? memories[a] ?? "").slice(0, 3000);
      } catch (err) {
        reflections[a] = { reflection: `(debrief failed: ${String(err).slice(0, 150)})` };
        newMem[a] = memories[a] ?? "";
      }
    }),
  );
  const r = rng(seed);
  const order = [...team.agents].sort(() => r() - 0.5);
  let current = playbook;
  const edits: DebriefResult["edits"] = [];
  for (const a of order) {
    const prompt = `${report}

TEAM REFLECTIONS:
${team.agents.map((x) => `--- ${x}\n${reflections[x].reflection}`).join("\n")}
${edits.length ? `\nPLAYBOOK EDITS SO FAR THIS ROUND:\n${edits.map((e) => `${e.agent}: ${e.action} - ${e.changelog}`).join("\n")}\n` : ""}
CURRENT TEAM PLAYBOOK (shown in your system prompt as well):
${current.trim() || "(empty)"}

The playbook is your team's shared document: every teammate reads it at the start of every game. Each of you, in turn, may rewrite it or keep it as it is. It is your turn (${edits.length + 1} of ${order.length}). Answer with the JSON object only.`;
    try {
      const { output } = await completer.complete(sysFor(a, current, newMem[a] ?? ""), prompt, EDIT_SCHEMA, `${a}-edit`);
      const action = output.action === "rewrite" && String(output.playbook ?? "").trim() ? "rewrite" : "keep";
      if (action === "rewrite") current = String(output.playbook).slice(0, 9000);
      edits.push({ agent: a, action, changelog: String(output.changelog ?? "") });
    } catch (err) {
      edits.push({ agent: a, action: "error", changelog: String(err).slice(0, 150) });
    }
  }
  const changelog = edits.filter((e) => e.action === "rewrite").map((e) => `${e.agent}: ${e.changelog}`).join(" | ") || "kept unchanged";
  return { playbook: current, changelog, memories: newMem, reflections, edits };
}

/** Mock "learning": a noisy hill-climb on the bot's strategy knobs, kept if it won. */
export function mockDebrief(style: MockStyle | null, best: MockStyle | null, won: boolean, seed: number): { style: MockStyle; best: MockStyle } {
  const r = rng(seed);
  const cur = style ?? { ...DEFAULT_STYLE };
  const base = won ? cur : (best ?? cur);
  const next: MockStyle = { ...base };
  for (const k of Object.keys(next) as (keyof MockStyle)[]) {
    if (!(k in DEFAULT_STYLE)) {
      delete next[k];
      continue;
    }
    const span = k === "expand" ? 1.2 : 0.18;
    next[k] = next[k] + (r() - 0.5) * 2 * span * (won ? 0.5 : 1);
    next[k] = k === "expand" ? Math.max(1, Math.min(6, next[k])) : Math.max(0, Math.min(1, next[k]));
  }
  return { style: next, best: base };
}

export function mockPlaybook(style: MockStyle): string {
  return `# Heuristic team (mock)\n\nStrategy knobs, tuned by hill-climbing after each game:\n\n\`\`\`json\n${JSON.stringify(Object.fromEntries(Object.entries(style).map(([k, v]) => [k, Math.round(v * 100) / 100])), null, 2)}\n\`\`\`\n`;
}
