const $ = (id) => document.getElementById(id);
const COLORS = ["#e2735a", "#4c8dff", "#2bb38f", "#d4a017", "#b061ff", "#e05297", "#3fb6c9", "#8c9a3a"];
const BREACH_LABELS = ["", "Scan", "Eject", "Eject", "Lost"];
const REPAIR_LABELS = ["", "", "Scan", "", "Saved"];

let players = [];
let state = null;
let lastRepairs = 0, lastBreaches = 0;
const thinking = new Set();
const votes = {};
const bubbleTimers = {};
const bubbles = {};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const name = (id) => players[id]?.name ?? `P${id}`;
const shortModel = (m) => (m === "mock" ? "mock" : m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2"));

// ---------- controls ----------
$("controls").addEventListener("submit", async (e) => {
  e.preventDefault();
  await fetch("/api/start", {
    method: "POST",
    body: JSON.stringify({ numPlayers: +$("numPlayers").value, model: $("model").value, effort: $("effort").value }),
  });
});
$("pause").onclick = async () => {
  const paused = $("pause").dataset.paused === "1";
  await fetch(paused ? "/api/resume" : "/api/pause", { method: "POST" });
};
$("stop").onclick = () => fetch("/api/stop", { method: "POST" });
$("reveal").onchange = () => {
  document.body.classList.toggle("reveal", $("reveal").checked);
  renderSeats();
};
fetch("/api/config").then((r) => r.json()).then((c) => {
  if (!c.hasKey) $("model").value = "mock";
});

// ---------- board ----------
function renderTracks() {
  const r = $("repairs"), b = $("breaches");
  r.innerHTML = ""; b.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const s = document.createElement("div");
    s.className = "slot" + (state && i < state.repairs ? " filled repair" : "") + (state && i === state.repairs - 1 && state.repairs > lastRepairs ? " pop" : "");
    s.textContent = REPAIR_LABELS[i];
    r.appendChild(s);
    const t = document.createElement("div");
    t.className = "slot" + (state && i < state.breaches ? " filled breach" : "") + (i >= 2 ? " danger" : "") + (state && i === state.breaches - 1 && state.breaches > lastBreaches ? " pop" : "");
    t.textContent = BREACH_LABELS[i];
    t.title = i >= 2 ? "From this breach on, an approved Infiltrator wins for the Saboteurs" : "";
    b.appendChild(t);
  }
  if (!state) return;
  lastRepairs = state.repairs; lastBreaches = state.breaches;
  $("round").textContent = state.round || "-";
  $("phase").textContent = state.phase;
  $("deck").textContent = state.deck;
  $("discard").textContent = state.discard;
  $("unrest").innerHTML = [0, 1, 2].map((i) => `<span class="pip ${i < state.unrest ? "on" : ""}"></span>`).join("");
  if (state.usd !== undefined) $("cost").textContent = `$${state.usd.toFixed(2)}`;
  const phaseNames = { briefing: "Briefing", nomination: "Nomination", debate: "Debate", vote: "Voting", mission: "Mission", debrief: "Debrief", scan: "Power: Scan", eject: "Power: Eject", over: "Game over", setup: "Setup" };
  $("centerPhase").textContent = `Round ${state.round || 0} . ${phaseNames[state.phase] ?? state.phase}`;
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
    if (votes[i]) badges.push(`<span class="badge ${votes[i]}">${votes[i].toUpperCase()}</span>`);
    if (sp && !sp.alive) badges.push(`<span class="badge out">EJECTED</span>`);
    if (reveal && sp) badges.push(`<span class="badge role ${sp.role}">${sp.role.toUpperCase()}</span>`);
    const hand = reveal && sp ? `<div class="hand">${sp.hand.map((c) => `<span class="card small ${c}">${c[0].toUpperCase()}</span>`).join("")}</div>` : "";
    el.innerHTML = `
      <div class="bubble" id="bubble-${i}"></div>
      <div class="avatar" style="background:${COLORS[i]}">${p.name[0]}</div>
      <div class="name">${esc(p.name)}</div>
      <div class="model">${shortModel(p.model)}</div>
      <div class="badges">${badges.join("")}</div>${hand}`;
    el.title = p.persona;
    table.appendChild(el);
    const bub = bubbles[i];
    if (bub && bub.until > Date.now()) { const b = el.querySelector(".bubble"); b.textContent = bub.text; b.classList.add("show"); }
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

function handle(ev) {
  switch (ev.type) {
    case "reset":
      $("feed").innerHTML = ""; players = []; state = null; lastRepairs = lastBreaches = 0;
      thinking.clear(); Object.keys(votes).forEach((k) => delete votes[k]);
      $("mission").innerHTML = ""; $("centerNote").textContent = ""; $("banner").classList.add("hidden");
      break;
    case "players":
      players = ev.players;
      renderSeats();
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
      if (ev.text) add(`<b>${esc(name(ev.player))}</b> thinks (${ev.kind}): ${esc(ev.text)}`, "thought spoiler");
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
      if (ev.kind === "mission") {
        $("mission").innerHTML = ev.cards.map((c) => `<div class="card ${c}">${c.toUpperCase()}</div>`).join("");
        $("centerNote").textContent = `${ev.result.toUpperCase()} logged`;
      }
      if (ev.kind === "auto") {
        $("mission").innerHTML = `<div class="card ${ev.card}">${ev.card.toUpperCase()}</div>`;
        $("centerNote").textContent = "Emergency protocol";
      }
      break;
    }
    case "private":
      add(`PRIVATE to ${esc(ev.to.map(name).join(", "))}: ${esc(ev.text)}`, "priv spoiler");
      break;
    case "played":
      add(`${esc(name(ev.player))} secretly played ${ev.card.toUpperCase()}`, "priv spoiler");
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
      break;
    case "gameover": {
      const b = $("banner");
      b.className = `banner ${ev.winner}`;
      b.innerHTML = `<h3>${ev.winner === "crew" ? "CREW WINS" : ev.winner === "saboteurs" ? "SABOTEURS WIN" : "NO WINNER"}</h3>
        <div>${esc(ev.reason)}</div>
        <div class="roles">${ev.roles.map((r) => `<span class="badge role ${r.role}">${esc(r.name)}: ${r.role}</span>`).join("")}</div>
        <button onclick="this.parentElement.classList.add('hidden')">Close</button>`;
      thinking.clear(); renderSeats();
      break;
    }
  }
}

renderTracks();
const es = new EventSource("/events");
es.onmessage = (m) => handle(JSON.parse(m.data));
