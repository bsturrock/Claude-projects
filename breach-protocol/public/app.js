const $ = (id) => document.getElementById(id);
const COLORS = ["#e2735a", "#4c8dff", "#2bb38f", "#d4a017", "#b061ff", "#e05297", "#3fb6c9", "#8c9a3a"];

let players = [];
let state = null;
let lastRepairs = 0, lastBreaches = 0;
const thinking = new Set();
const votes = {};
const bubbleTimers = {};
const bubbles = {};
let timeline = {}; // player id -> steps
let rounds = {}; // round -> { facts, summary }
let selectedAgent = 0;
let es = null;
let replayToken = 0;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const name = (id) => players[id]?.name ?? `P${id}`;
const shortModel = (m) => (m === "mock" ? "mock" : String(m).replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2"));
const cap = (s) => String(s).toUpperCase();

// ---------- controls ----------
$("controls").addEventListener("submit", async (e) => {
  e.preventDefault();
  goLive();
  await fetch("/api/start", {
    method: "POST",
    body: JSON.stringify({
      numPlayers: +$("numPlayers").value,
      backend: $("backend").value,
      model: $("model").value,
      effort: $("effort").value,
      ruleset: $("ruleset").value,
      narrator: $("narrator").checked,
    }),
  });
});
$("pause").onclick = async () => {
  const paused = $("pause").dataset.paused === "1";
  await fetch(paused ? "/api/resume" : "/api/pause", { method: "POST" });
};
$("backend").onchange = () => ($("model").disabled = $("backend").value === "mock");
$("stop").onclick = () => fetch("/api/stop", { method: "POST" });
$("reveal").onchange = () => {
  document.body.classList.toggle("reveal", $("reveal").checked);
  renderSeats();
  renderPicker();
};
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("hidden", p.id !== b.dataset.tab));
  if (b.dataset.tab === "agents") renderTimeline();
});
$("replay").onclick = () => $("logs").value && replay($("logs").value);
$("live").onclick = goLive;

async function loadConfig() {
  const c = await (await fetch("/api/config")).json();
  $("backend").value = c.cli?.ok ? "claude-code" : c.hasKey ? "api" : "mock";
  if (!c.cli?.ok) $("backend").querySelector('[value="claude-code"]').textContent += " (claude CLI not found)";
  if (!c.hasKey) $("backend").querySelector('[value="api"]').textContent += " (no key set)";
  $("model").disabled = $("backend").value === "mock";
  $("ruleset").innerHTML = c.rulesets.map((r) => `<option value="${esc(r.id)}" title="${esc(r.description)}">${esc(r.name)}</option>`).join("");
  if (c.rulesets.some((r) => r.id === "paired-play")) $("ruleset").value = "paired-play";
  await loadLogs();
}
async function loadLogs() {
  const logs = await (await fetch("/api/logs")).json();
  $("logs").innerHTML = logs.length
    ? logs.map((l) => `<option value="${esc(l.file)}">${esc(l.file.replace(/^game-|\.json$/g, ""))} . ${esc(l.ruleset ?? "")} . ${esc(shortModel(l.model ?? "?"))} . ${l.players ?? "?"}p . ${esc(l.winner ?? "unfinished")}</option>`).join("")
    : `<option value="">(no saved games yet)</option>`;
}

// ---------- live vs replay ----------
function goLive() {
  replayToken++;
  $("mode").textContent = "LIVE";
  $("mode").className = "mode";
  if (es) es.close();
  resetView();
  es = new EventSource("/events");
  es.onmessage = (m) => handle(JSON.parse(m.data));
}

async function replay(file) {
  const token = ++replayToken;
  if (es) { es.close(); es = null; }
  $("mode").textContent = "REPLAY";
  $("mode").className = "mode replay";
  const data = await (await fetch(`/logs/${encodeURIComponent(file)}`)).json();
  resetView();
  const speed = +$("replaySpeed").value;
  let prev = null;
  for (const ev of data.events) {
    if (token !== replayToken) return;
    if (speed > 0 && prev && ["chat", "system", "state", "summary"].includes(ev.type)) {
      const gap = Math.min(ev.t - prev, 2500) / speed;
      if (gap > 5) await new Promise((r) => setTimeout(r, gap));
    }
    prev = ev.t;
    handle(ev);
  }
}

function resetView() {
  $("feed").innerHTML = "";
  $("rounds").innerHTML = `<p class="empty">Round recaps appear here as each round ends.</p>`;
  $("summary").innerHTML = `<p class="empty">The game summary appears here when the game ends.</p>`;
  $("timeline").innerHTML = "";
  $("agentPicker").innerHTML = "";
  players = []; state = null; lastRepairs = lastBreaches = 0;
  timeline = {}; rounds = {};
  thinking.clear();
  Object.keys(votes).forEach((k) => delete votes[k]);
  $("mission").innerHTML = ""; $("centerNote").textContent = ""; $("banner").classList.add("hidden");
  $("table").querySelectorAll(".seat").forEach((el) => el.remove());
  $("centerPhase").textContent = "Press \"New game\"";
  renderTracks();
}

// ---------- board ----------
function renderTracks() {
  const rules = state?.rules ?? { repairsToWin: 5, breachesToWin: 5, unrestLimit: 3, infiltratorDangerAt: 3, breachPowers: {}, repairPowers: {} };
  const r = $("repairs"), b = $("breaches");
  r.innerHTML = ""; b.innerHTML = "";
  const slot = (kind, i, n, powers) => {
    const key = kind === "repair" ? "repairs" : "breaches";
    const s = document.createElement("div");
    const filled = state && i < state[key];
    const justFilled = state && i === state[key] - 1 && state[key] > (kind === "repair" ? lastRepairs : lastBreaches);
    const danger = kind === "breach" && rules.infiltratorDangerAt > 0 && i >= rules.infiltratorDangerAt - 1 && i < n - 1;
    s.className = `slot${filled ? ` filled ${kind}` : ""}${danger ? " danger" : ""}${justFilled ? " pop" : ""}`;
    s.textContent = i === n - 1 ? (kind === "repair" ? "Saved" : "Lost") : powers[String(i + 1)] ?? "";
    if (danger) s.title = "Once this many Breaches are logged, an approved Infiltrator wins for the Saboteurs";
    return s;
  };
  for (let i = 0; i < rules.repairsToWin; i++) r.appendChild(slot("repair", i, rules.repairsToWin, rules.repairPowers));
  for (let i = 0; i < rules.breachesToWin; i++) b.appendChild(slot("breach", i, rules.breachesToWin, rules.breachPowers));
  const hints = document.querySelectorAll(".track .hint");
  hints[0].textContent = `crew wins at ${rules.repairsToWin}`;
  hints[1].textContent = `saboteurs win at ${rules.breachesToWin}`;
  if (!state) return;
  lastRepairs = state.repairs; lastBreaches = state.breaches;
  $("round").textContent = state.round || "-";
  $("phase").textContent = state.phase;
  $("deck").textContent = state.deck;
  $("discard").textContent = state.discard;
  $("unrest").innerHTML = Array.from({ length: rules.unrestLimit }, (_, i) => `<span class="pip ${i < state.unrest ? "on" : ""}"></span>`).join("");
  if (state.usd !== undefined) $("cost").textContent = `$${state.usd.toFixed(2)}`;
  const cc = state.players?.some((p) => p.usage?.usd !== undefined);
  $("costLabel").textContent = cc ? "API-equiv" : "Spend";
  $("costLabel").title = cc ? "Claude Code reports what these calls would cost on the API. On a Pro/Max login this is not billed; it counts toward your plan's usage limits." : "";
  const phaseNames = { briefing: "Briefing", nomination: "Nomination", debate: "Debate", vote: "Voting", mission: "Mission", debrief: "Debrief", scan: "Power: Scan", eject: "Power: Eject", over: "Game over", setup: "Setup" };
  $("centerPhase").textContent = `${state.ruleset} . Round ${state.round || 0} . ${phaseNames[state.phase] ?? state.phase}`;
}

function renderSeats() {
  const table = $("table");
  table.querySelectorAll(".seat").forEach((el) => el.remove());
  const n = players.length;
  const reveal = $("reveal").checked;
  players.forEach((p, i) => {
    const sp = state?.players?.[i];
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const x = 50 + 40 * Math.cos(ang), y = 50 + 38 * Math.sin(ang);
    const el = document.createElement("div");
    el.className = "seat";
    el.id = `seat-${i}`;
    if (y < 45) el.classList.add("low");
    if (x < 30) el.classList.add("left");
    if (x > 70) el.classList.add("right");
    if (sp && !sp.alive) el.classList.add("dead");
    if (thinking.has(i)) el.classList.add("thinking");
    if (reveal && sp) el.classList.add("reveal", sp.role);
    el.style.left = `${x}%`; el.style.top = `${y}%`;
    const badges = [];
    if (state?.captain === i) badges.push(`<span class="badge captain">CAPTAIN</span>`);
    if (state?.second === i) badges.push(`<span class="badge second">SECOND</span>`);
    if (votes[i]) badges.push(`<span class="badge ${votes[i]}">${cap(votes[i])}</span>`);
    if (sp && !sp.alive) badges.push(`<span class="badge out">EJECTED</span>`);
    if (reveal && sp) badges.push(`<span class="badge role ${sp.role}">${cap(sp.role)}</span>`);
    const hand = reveal && sp ? `<div class="hand">${sp.hand.map((c) => `<span class="card small ${c}">${c[0].toUpperCase()}</span>`).join("")}</div>` : "";
    el.innerHTML = `
      <div class="bubble" id="bubble-${i}"></div>
      <div class="avatar" style="background:${COLORS[i]}">${esc(p.name[0])}</div>
      <div class="name">${esc(p.name)}</div>
      <div class="model">${esc(shortModel(p.model))}</div>
      <div class="badges">${badges.join("")}</div>${hand}`;
    el.title = `${p.persona} (click to open this agent's timeline)`;
    el.style.cursor = "pointer";
    el.onclick = () => openAgent(i);
    table.appendChild(el);
    const bub = bubbles[i];
    if (bub && bub.until > Date.now()) {
      const bb = el.querySelector(".bubble");
      bb.textContent = bub.text;
      bb.classList.add("show");
    }
  });
}

function showBubble(pid, text) {
  const b = $(`bubble-${pid}`);
  if (!b) return;
  b.textContent = text;
  b.classList.add("show");
  bubbles[pid] = { text, until: Date.now() + 7000 };
  clearTimeout(bubbleTimers[pid]);
  bubbleTimers[pid] = setTimeout(() => $(`bubble-${pid}`)?.classList.remove("show"), 7000);
}

// ---------- feed ----------
function add(html, cls = "") {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.innerHTML = html;
  $("feed").appendChild(div);
  if ($("autoscroll").checked) $("feed").scrollTop = $("feed").scrollHeight;
  return div;
}

// ---------- agents tab ----------
function renderPicker() {
  const reveal = $("reveal").checked;
  $("agentPicker").innerHTML = players
    .map((p, i) => {
      const role = reveal && state?.players?.[i] ? ` <span class="muted">(${esc(state.players[i].role)})</span>` : "";
      return `<button type="button" data-p="${i}" class="${i === selectedAgent ? "active" : ""}"><span class="sw" style="background:${COLORS[i]}"></span>${esc(p.name)}${role}</button>`;
    })
    .join("");
  $("agentPicker").querySelectorAll("button").forEach((b) => (b.onclick = () => { selectedAgent = +b.dataset.p; renderPicker(); renderTimeline(); }));
}
function openAgent(i) {
  selectedAgent = i;
  document.querySelector('#tabs button[data-tab="agents"]').click();
  renderPicker();
}
function stepHtml(s) {
  if (s.type === "info") return `<div class="step info"><div class="head"><span>R${s.round} . private info</span></div>${esc(s.text)}</div>`;
  const d = s.decision ?? {};
  const act = [];
  if (d.say) act.push(`says: "${esc(d.say)}"`);
  if (d.target) act.push(`target: ${esc(d.target)}`);
  if (d.vote && d.vote !== "none") act.push(`vote: ${cap(d.vote)}`);
  if (d.card && d.card !== "none") act.push(`card: ${cap(d.card)}`);
  return `<div class="step">
    <div class="head"><span>R${s.round} . ${esc(s.kind)}</span></div>
    ${s.thinking ? `<div class="think"><b>Thinking (summary):</b> ${esc(s.thinking)}</div>` : ""}
    ${s.text ? `<div class="reason"><b>Stated reasoning:</b> ${esc(s.text)}</div>` : ""}
    <div class="act">${act.length ? act.join(" . ") : "(stays quiet)"}</div>
  </div>`;
}
function renderTimeline() {
  const steps = timeline[selectedAgent] ?? [];
  $("timeline").innerHTML = steps.length ? steps.map(stepHtml).join("") : `<p class="empty">No decisions yet.</p>`;
  if ($("autoscroll").checked) $("timeline").scrollTop = $("timeline").scrollHeight;
}
function pushStep(pid, step) {
  (timeline[pid] ??= []).push(step);
  if (pid === selectedAgent && !$("agents").classList.contains("hidden")) {
    $("timeline").querySelector(".empty")?.remove();
    $("timeline").insertAdjacentHTML("beforeend", stepHtml(step));
    if ($("autoscroll").checked) $("timeline").scrollTop = $("timeline").scrollHeight;
  }
}

// ---------- rounds tab ----------
function renderRound(r) {
  const d = rounds[r];
  if (!d?.facts) return;
  const f = d.facts;
  $("rounds").querySelector(".empty")?.remove();
  let card = $(`round-${r}`);
  if (!card) {
    card = document.createElement("div");
    card.className = "round-card";
    card.id = `round-${r}`;
    $("rounds").appendChild(card);
  }
  const tag = f.approved === false
    ? `<span class="tag rejected">REJECTED${f.auto ? ` . AUTO ${cap(f.auto)}` : ""}</span>`
    : f.result ? `<span class="tag ${f.result}">${cap(f.result)}</span>` : "";
  const yes = f.votes ? Object.entries(f.votes).filter(([, v]) => v === "yes").map(([k]) => name(+k)) : [];
  const no = f.votes ? Object.entries(f.votes).filter(([, v]) => v === "no").map(([k]) => name(+k)) : [];
  const facts = [
    `Captain ${esc(name(f.captain))}${f.second !== undefined ? ` . Second ${esc(name(f.second))}` : ""}`,
    f.votes ? `Yes: ${esc(yes.join(", ") || "-")} . No: ${esc(no.join(", ") || "-")}` : "",
    f.power ? `Power: ${esc(f.power.kind)} on ${esc(name(f.power.target))}` : "",
  ].filter(Boolean);
  const secret = [
    f.crate ? `Crate: ${f.crate.map(cap).join(" + ")}; passed ${cap(f.handed)}${f.secondDrew?.length ? `; Second drew ${f.secondDrew.map(cap).join(" + ")}` : ""}` : "",
    f.played ? `Played: ${f.played.map((p) => `${esc(name(p.player))} ${cap(p.card)}`).join(", ")}` : "",
  ].filter(Boolean);
  card.innerHTML = `
    <h4><span>Round ${r}</span>${tag}</h4>
    <div class="facts">${facts.map((x) => `<div>${x}</div>`).join("")}</div>
    ${secret.length ? `<div class="priv spoiler">${secret.join("<br>")}</div>` : ""}
    ${d.summary
      ? `<div class="recap">${esc(d.summary.public_recap)}</div>
         <div class="thought spoiler analysis"><b>Spectator analysis:</b> ${esc(d.summary.spectator_analysis)}</div>`
      : `<div class="muted recap">${state?.narrator ? "Narrator is writing..." : ""}</div>`}`;
}

function renderGameSummary(s) {
  const roles = state?.players ?? [];
  $("summary").innerHTML = `<div class="sum">
    <h3>${esc(s.headline)}</h3>
    <div class="story">${esc(s.story)}</div>
    <h5>Turning points</h5><ul>${s.turning_points.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    <h5>Best play</h5><div>${esc(s.best_play)}</div>
    <h5>Biggest mistake</h5><div>${esc(s.biggest_mistake)}</div>
    <h5>Players</h5>
    <table>${s.players.map((p) => {
      const sp = roles.find((r) => r.name === p.name);
      const calls = sp?.usage ? `${sp.usage.calls} calls` : "";
      return `<tr><td><b>${esc(p.name)}</b><br><span class="badge role ${esc(sp?.role ?? "")}">${esc(sp?.role ?? "")}</span></td><td>${esc(p.verdict)}<div class="muted">${esc(shortModel(sp?.model ?? ""))} . ${calls}</div></td></tr>`;
    }).join("")}</table>
  </div>`;
}

// ---------- event handling ----------
function handle(ev) {
  switch (ev.type) {
    case "reset":
      resetView();
      break;
    case "players":
      players = ev.players;
      selectedAgent = 0;
      renderSeats(); renderPicker(); renderTimeline();
      break;
    case "state":
      state = ev.state;
      renderTracks(); renderSeats();
      break;
    case "round":
      Object.keys(votes).forEach((k) => delete votes[k]);
      $("mission").innerHTML = ""; $("centerNote").textContent = "";
      break;
    case "thinking":
      thinking.add(ev.player);
      $(`seat-${ev.player}`)?.classList.add("thinking");
      break;
    case "reasoning":
      thinking.delete(ev.player);
      $(`seat-${ev.player}`)?.classList.remove("thinking");
      if (ev.text) add(`<b>${esc(name(ev.player))}</b> thinks (${esc(ev.kind)}): ${esc(ev.text)}`, "thought spoiler");
      pushStep(ev.player, { type: "decision", round: ev.round, kind: ev.kind, text: ev.text, thinking: ev.thinking, decision: ev.decision });
      break;
    case "chat": {
      const p = ev.player;
      add(`<div class="av" style="background:${COLORS[p]}">${esc(name(p)[0])}</div>
        <div><span class="who" style="color:${COLORS[p]}">${esc(name(p))}</span><span class="ctx">${esc(ev.context)}</span>
        <div class="text">${esc(ev.text)}</div></div>`, "msg");
      showBubble(p, ev.text);
      break;
    }
    case "pass":
      add(`${esc(name(ev.player))} stays quiet`, "pass");
      break;
    case "system": {
      let cls = "sys";
      if (ev.text.startsWith("--- Round")) cls += " round";
      if (ev.kind === "mission" || ev.kind === "auto") cls += (ev.result ?? ev.card) === "repair" ? " result-repair" : " result-breach";
      if (ev.text.startsWith("GAME OVER")) cls += " over";
      add(esc(ev.text.replace(/^--- | ---$/g, "")), cls);
      if (ev.kind === "votes") {
        Object.assign(votes, ev.votes);
        $("centerNote").textContent = ev.passed ? "Team approved" : "Team rejected";
        renderSeats();
      }
      if (ev.kind === "crate") $("centerNote").textContent = "Supply crate opened";
      if (ev.kind === "mission") {
        $("mission").innerHTML = ev.cards.map((c) => `<div class="card ${c}">${cap(c)}</div>`).join("");
        $("centerNote").textContent = `${cap(ev.result)} logged`;
      }
      if (ev.kind === "auto") {
        $("mission").innerHTML = `<div class="card ${ev.card}">${cap(ev.card)}</div>`;
        $("centerNote").textContent = "Emergency protocol";
      }
      break;
    }
    case "private":
      add(`PRIVATE to ${esc(ev.to.map(name).join(", "))}: ${esc(ev.text)}`, "priv spoiler");
      for (const pid of ev.to) pushStep(pid, { type: "info", round: ev.round, text: ev.text });
      break;
    case "played":
      add(`${esc(name(ev.player))} secretly played ${cap(ev.card)}`, "priv spoiler");
      break;
    case "roundfacts":
      (rounds[ev.facts.round] ??= {}).facts = ev.facts;
      renderRound(ev.facts.round);
      break;
    case "summary":
      if (ev.scope === "round") {
        (rounds[ev.forRound] ??= {}).summary = ev.summary;
        renderRound(ev.forRound);
      } else {
        renderGameSummary(ev.summary);
      }
      break;
    case "error":
      add(esc(ev.text), "err");
      break;
    case "paused":
      $("pause").dataset.paused = ev.paused ? "1" : "0";
      $("pause").textContent = ev.paused ? "Resume" : "Pause";
      break;
    case "cost":
      $("cost").textContent = `$${ev.usd.toFixed(2)}`;
      loadLogs();
      break;
    case "gameover": {
      const b = $("banner");
      b.className = `banner ${ev.winner}`;
      b.innerHTML = `<h3>${ev.winner === "crew" ? "CREW WINS" : ev.winner === "saboteurs" ? "SABOTEURS WIN" : "NO WINNER"}</h3>
        <div>${esc(ev.reason)}</div>
        <div class="roles">${ev.roles.map((r) => `<span class="badge role ${esc(r.role)}">${esc(r.name)}: ${esc(r.role)}</span>`).join("")}</div>
        <button onclick="this.parentElement.classList.add('hidden')">Close</button>`;
      thinking.clear(); renderSeats();
      break;
    }
  }
}

loadConfig();
goLive();
