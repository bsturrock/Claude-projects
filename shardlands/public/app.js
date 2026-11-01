/* Shardlands spectator. Plain JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const api = async (p, opts) => {
  const r = await fetch(p, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

const TEAM_ORDER = ["amber", "cobalt", "verdant", "crimson", "ivory", "onyx", "saffron", "slate"];
const teamColor = (id) => `var(--t${TEAM_ORDER.indexOf(id) + 1 || 1})`;
const STYLE_SHORT = {
  military_spend: "Military", expansion_spend: "Expansion", development_spend: "Development", tech_spend: "Tech",
  aggression: "Aggression", early_war: "Early war", diplomacy: "Peace deals", trade: "Trade", team_support: "Team gifts",
  vp_land: "VP land", vp_tech: "VP tech", vp_glory: "VP glory", vp_wonders: "VP wonders", vp_commerce: "VP commerce",
};

const S = {
  meta: null,
  leagues: [],
  league: null, // league detail
  leagueName: localGet("league") || "",
  game: null, // { log, turns, pending, observations, live }
  viewIdx: -1, // index into game.turns, -1 = latest
  viewAs: "",
  chan: "all",
  agent: null,
  team: null,
  run: null,
};

function localGet(k) { try { return localStorage.getItem("shard:" + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem("shard:" + k, v); } catch {} }

// ---------------- header / leagues ----------------

async function loadMeta() {
  S.meta = await api("/api/meta");
  $("#modelSel").innerHTML = S.meta.models.map((m) => `<option>${m}</option>`).join("");
  await loadLeagues();
}
async function loadLeagues() {
  S.leagues = await api("/api/leagues");
  if (!S.leagues.find((l) => l.name === S.leagueName)) S.leagueName = S.leagues[0]?.name ?? "";
  $("#leagueSel").innerHTML = S.leagues.length
    ? S.leagues.map((l) => `<option value="${esc(l.name)}" ${l.name === S.leagueName ? "selected" : ""}>${esc(l.name)} (${l.games} games, ${esc(l.settings.backend)})</option>`).join("")
    : `<option value="">(no leagues: create one)</option>`;
  if (S.leagueName) await loadLeague();
}
async function loadLeague() {
  if (!S.leagueName) return;
  S.league = await api(`/api/league/${encodeURIComponent(S.leagueName)}`);
  if (!S.team || !S.league.file.teams.find((t) => t.id === S.team)) S.team = S.league.file.teams[0]?.id;
  renderLeague();
}
$("#leagueSel").onchange = async (e) => {
  S.leagueName = e.target.value;
  localSet("league", S.leagueName);
  await loadLeague();
};
$("#runBtn").onclick = async () => {
  if (!S.leagueName) return alert("Create a league first.");
  try {
    await post(`/api/league/${encodeURIComponent(S.leagueName)}/run`, { games: Number($("#nGames").value) });
    switchTab("game");
    S.viewIdx = -1;
  } catch (e) { alert(e.message); }
};
$("#pauseBtn").onclick = () => post(S.run?.paused ? "/api/resume" : "/api/pause");
$("#stopBtn").onclick = () => { if (confirm("Stop the running league after aborting the current game?")) post("/api/stop"); };
$("#newLeagueBtn").onclick = () => $("#newLeague").showModal();
$("#newLeague").addEventListener("close", async () => {
  if ($("#newLeague").returnValue !== "ok") return;
  const f = new FormData($("#newLeagueForm"));
  try {
    const r = await post("/api/leagues", {
      name: f.get("name"), teams: Number(f.get("teams")), backend: f.get("backend"), model: f.get("model"),
      effort: f.get("effort"), turns: Number(f.get("turns")), council: f.get("council") === "on",
    });
    S.leagueName = r.name;
    localSet("league", r.name);
    await loadLeagues();
    switchTab("league");
  } catch (e) { alert(e.message); }
});
function renderStatus() {
  const r = S.run;
  if (!r) return;
  let t = r.active ? `Running ${r.league}: game ${r.game}/${r.games}${r.paused ? " (paused)" : ""}` : "Idle";
  if (r.error) t += ` | error: ${r.error}`;
  if (S.game?.phase && r.active) t += ` | turn ${S.game.phase.turn} ${S.game.phase.phase}`;
  if (S.game?.debrief) t += ` | ${S.game.debrief}`;
  $("#status").textContent = t;
  $("#pauseBtn").textContent = r.paused ? "Resume" : "Pause";
  $("#pauseBtn").disabled = $("#stopBtn").disabled = !r.active;
  $("#runBtn").disabled = r.active;
}

// ---------------- tabs ----------------

function switchTab(t) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  $$(".tab").forEach((x) => x.classList.toggle("active", x.id === `tab-${t}`));
  localSet("tab", t);
}
$$(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
$$(".subtabs button").forEach((b) => (b.onclick = () => {
  $$(".subtabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".sub").forEach((x) => x.classList.toggle("active", x.id === `sub-${b.dataset.sub}`));
}));

// ---------------- live events ----------------

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
}
function onEvent(e) {
  switch (e.type) {
    case "status": {
      const wasActive = S.run?.active;
      S.run = e.run;
      renderStatus();
      if (wasActive && !e.run.active) loadLeagues();
      return;
    }
    case "start":
      S.game = { log: e.log, turns: [], pending: { decisions: [], messages: [] }, observations: {}, live: true };
      S.viewIdx = -1;
      setupGame();
      break;
    case "phase":
      if (!S.game) return;
      S.game.phase = { turn: e.turn, phase: e.phase };
      renderStatus();
      return;
    case "decision":
      if (!S.game) return;
      S.game.pending.decisions.push({ ...e.decision, turn: e.turn });
      if (e.observation) S.game.observations[e.decision.agent] = e.observation;
      if (S.agent === e.decision.agent) renderAgent();
      return;
    case "messages":
      if (!S.game) return;
      S.game.pending.messages.push(...e.messages);
      renderFeed();
      return;
    case "turn":
      if (!S.game) return;
      S.game.turns.push(e.turnLog);
      S.game.pending = { decisions: [], messages: [] };
      break;
    case "end":
      if (!S.game) return;
      S.game.result = e.result;
      S.game.phase = null;
      break;
    case "debrief":
      if (!S.game) return;
      S.game.debrief = e.status === "start" ? "teams are debriefing and rewriting playbooks" : "debrief done";
      renderStatus();
      return;
    default:
      return;
  }
  renderGame();
}

// ---------------- game view ----------------

function setupGame() {
  const g = S.game;
  $("#viewAs").innerHTML = `<option value="">Everything</option>` + g.log.teams.map((t) => `<option value="${t.id}">${esc(t.name)}'s view</option>`).join("");
  $("#viewAs").value = S.viewAs = "";
  const chans = [["all", "All"], ["public", "Public"], ...g.log.teams.map((t) => [`team:${t.id}`, `${t.name} team`]), ["embassy", "Embassies"], ["events", "Events"]];
  $("#chanFilters").innerHTML = chans.map(([v, l]) => `<button data-chan="${v}" class="${S.chan === v ? "active" : ""}">${esc(l)}</button>`).join("");
  $$("#chanFilters button").forEach((b) => (b.onclick = () => { S.chan = b.dataset.chan; setupGame(); renderFeed(); }));
  $("#agentList").innerHTML = g.log.teams.flatMap((t) => t.agents.map((a) => `<button data-agent="${a}" style="border-left:4px solid ${teamColor(t.id)}">${a}</button>`)).join("");
  $$("#agentList button").forEach((b) => (b.onclick = () => { S.agent = b.dataset.agent; renderAgent(); renderMap(); }));
  $("#gameTitle").textContent = `${g.log.id} | ${g.log.teams.map((t) => t.name).join(" vs ")} | ${g.log.backend}${g.log.model !== "mock" ? " " + g.log.model : ""}`;
}
$("#viewAs").onchange = (e) => { S.viewAs = e.target.value; renderMap(); };
$("#turnSlider").oninput = (e) => {
  const v = Number(e.target.value);
  S.viewIdx = v >= (S.game?.turns.length ?? 0) ? -1 : v;
  renderGame();
};
$("#liveBtn").onclick = () => { S.viewIdx = -1; renderGame(); };

function currentSnap() {
  const g = S.game;
  if (!g) return null;
  if (!g.turns.length) return g.log.initial;
  const i = S.viewIdx < 0 ? g.turns.length - 1 : S.viewIdx;
  return i === -1 ? g.log.initial : g.turns[i].snapshot;
}
function currentTurnIdx() {
  const g = S.game;
  return S.viewIdx < 0 ? g.turns.length - 1 : S.viewIdx;
}

function renderGame() {
  const g = S.game;
  if (!g) return;
  const n = g.turns.length;
  $("#turnSlider").max = String(n);
  $("#turnSlider").value = String(S.viewIdx < 0 ? n : S.viewIdx);
  const idx = currentTurnIdx();
  $("#turnLabel").textContent = idx < 0 ? "start" : `after turn ${g.turns[idx].turn}${S.viewIdx < 0 ? (g.result ? " (final)" : " (live)") : ""}`;
  $("#liveBtn").disabled = S.viewIdx < 0;
  renderMap();
  renderScores();
  renderFeed();
  renderAgent();
}

const SIZE = 22;
const SQ3 = Math.sqrt(3);
const hexXY = (q, r) => [SIZE * SQ3 * (q + r / 2), SIZE * 1.5 * r];
const hexPts = (cx, cy, s) => Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 180) * (60 * i - 30); return `${(cx + s * Math.cos(a)).toFixed(1)},${(cy + s * Math.sin(a)).toFixed(1)}`; }).join(" ");

function renderMap() {
  const snap = currentSnap();
  const svg = $("#map");
  if (!snap) { svg.innerHTML = ""; return; }
  const R = Math.max(...snap.tiles.map((t) => Math.max(Math.abs(t.q), Math.abs(t.r), Math.abs(t.q + t.r))));
  const w = SIZE * SQ3 * (2 * R + 1) + 8;
  const h = SIZE * (3 * R + 2) + 8;
  svg.setAttribute("viewBox", `${-w / 2} ${-h / 2} ${w} ${h}`);
  const vis = S.viewAs ? new Set(snap.visible[S.viewAs]) : null;
  const claim = new Map();
  for (const s of snap.settlements) for (const k of s.claims) claim.set(k, s);
  const setAt = new Map(snap.settlements.map((s) => [`${s.pos.q},${s.pos.r}`, s]));
  const unitsAt = new Map();
  for (const u of snap.units) {
    const k = `${u.pos.q},${u.pos.r}`;
    if (!unitsAt.has(k)) unitsAt.set(k, []);
    unitsAt.get(k).push(u);
  }
  const teamName = (id) => snap.teams.find((t) => t.id === id)?.name ?? id;
  let out = "";
  for (const t of snap.tiles) {
    const k = `${t.q},${t.r}`;
    const [x, y] = hexXY(t.q, t.r);
    const s = setAt.get(k);
    const us = unitsAt.get(k) ?? [];
    const seen = !vis || vis.has(k);
    const tip = [`(${k}) ${t.t}`];
    const c = claim.get(k);
    if (c && seen) tip.push(`territory of ${c.owner} (${c.id})`);
    if (s && seen) tip.push(`${s.id} ${s.name}: ${s.level} of ${s.owner}, HP ${s.hp}/${s.maxHp}${s.walls ? ", walls" : ""}${s.monument ? ", monument" : ""}${s.spire ? ", SPIRE" : ""}`);
    if (seen) for (const u of us) tip.push(`${u.id} ${u.type} of ${u.owner} HP ${u.hp}/${u.maxHp}${u.dest ? ` -> (${u.dest.q},${u.dest.r})` : ""}`);
    out += `<g data-k="${k}"><title>${esc(tip.join("\n"))}</title><polygon class="hex" points="${hexPts(x, y, SIZE)}" fill="var(--${t.t})"/>`;
    if (c && seen) out += `<polygon points="${hexPts(x, y, SIZE - 2.5)}" fill="${teamColor(c.team)}" fill-opacity="0.22" stroke="${teamColor(c.team)}" stroke-opacity="0.55" stroke-width="1.5"/>`;
    if (t.t === "heart") out += `<text x="${x}" y="${y + 3}" text-anchor="middle" font-size="11">&#9670;</text>`;
    if (t.t === "crystal") out += `<text x="${x}" y="${y + 3}" text-anchor="middle" fill-opacity=".6">&#9671;</text>`;
    if (t.t === "ruins") out += `<text x="${x}" y="${y + 3}" text-anchor="middle">&#8962;</text>`;
    if (!seen) out += `<polygon points="${hexPts(x, y, SIZE)}" fill="var(--fog)"/>`;
    if (s && seen) {
      const sz = s.level === "village" ? 6 : s.level === "town" ? 8 : 10;
      out += `<rect x="${x - sz}" y="${y - sz - 2}" width="${2 * sz}" height="${2 * sz}" rx="2" fill="${teamColor(s.team)}" stroke="var(--surface)" stroke-width="2"/>`;
      if (s.level === "city") out += `<rect x="${x - sz - 3}" y="${y - sz - 5}" width="${2 * sz + 6}" height="${2 * sz + 6}" rx="3" fill="none" stroke="${teamColor(s.team)}" stroke-width="1.5"/>`;
      if (s.walls) out += `<rect x="${x - sz - 1.5}" y="${y - sz - 3.5}" width="${2 * sz + 3}" height="${2 * sz + 3}" rx="2" fill="none" stroke="var(--text)" stroke-width="1" stroke-dasharray="2 1.5"/>`;
      if (s.monument || s.spire) out += `<text x="${x}" y="${y + 1}" text-anchor="middle" fill="#fff" font-size="9">${s.spire ? "&#9733;" : "M"}</text>`;
      if (s.hp < s.maxHp) out += `<rect x="${x - 9}" y="${y + sz}" width="18" height="2.5" fill="var(--grid)"/><rect x="${x - 9}" y="${y + sz}" width="${(18 * s.hp) / s.maxHp}" height="2.5" fill="${teamColor(s.team)}"/>`;
    }
    if (us.length && seen) {
      const byTeam = new Map();
      for (const u of us) byTeam.set(u.team, [...(byTeam.get(u.team) ?? []), u]);
      let i = 0;
      for (const [team, list] of byTeam) {
        const ux = x + (s ? 9 : 0) + (i - (byTeam.size - 1) / 2) * 11;
        const uy = y + (s ? 9 : 0);
        const mil = list.some((u) => ["soldier", "rider", "catapult"].includes(u.type));
        out += `<circle cx="${ux}" cy="${uy}" r="5.5" fill="${teamColor(team)}" stroke="var(--surface)" stroke-width="2"/>`;
        out += `<text x="${ux}" y="${uy + 3}" text-anchor="middle" fill="#fff" font-size="8" font-weight="700">${list.length > 1 ? list.length : mil ? "&#9876;" : list[0].type[0].toUpperCase()}</text>`;
        i++;
      }
    }
    out += `</g>`;
  }
  // Standing move orders for the selected agent.
  if (S.agent) {
    for (const u of snap.units.filter((u) => u.owner === S.agent && u.dest)) {
      const [x1, y1] = hexXY(u.pos.q, u.pos.r);
      const [x2, y2] = hexXY(u.dest.q, u.dest.r);
      out += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${teamColor(u.team)}" stroke-width="2" stroke-dasharray="4 3" stroke-linecap="round"/>`;
    }
  }
  svg.innerHTML = out;
  $("#legend").innerHTML =
    snap.teams.map((t) => `<span><i style="background:${teamColor(t.id)}"></i>${esc(t.name)}</span>`).join("") +
    `<span>&#9632; settlement (bigger = town/city, dashed = walls, M monument, &#9733; spire)</span><span>&#9679; units (number = count, &#9876; military)</span><span>&#9670; Heart &#9671; crystal &#8962; ruins</span>`;
  svg.onmousemove = (e) => {
    const g = e.target.closest("g[data-k]");
    $("#hexInfo").textContent = g ? $("title", g).textContent.replace(/\n/g, " | ") : "";
  };
}

function renderScores() {
  const snap = currentSnap();
  if (!snap) return;
  const cols = [["settlements", "Land"], ["monuments", "Mon."], ["spire", "Spire"], ["tech", "Tech"], ["glory", "Glory"], ["heart", "Heart"], ["commerce", "Trade"]];
  const teams = [...snap.teams].sort((a, b) => b.vp.total - a.vp.total);
  const rows = teams.map((t) => {
    const nS = snap.settlements.filter((s) => s.team === t.id).length;
    const nU = snap.units.filter((u) => u.team === t.id).length;
    return `<tr><td><span class="sw" style="background:${teamColor(t.id)}"></span>${esc(t.name)}${t.alive ? "" : " (out)"}</td><td><b>${t.vp.total}</b></td>${cols.map(([k]) => `<td>${t.vp[k]}</td>`).join("")}<td>${nS}</td><td>${nU}</td><td title="${esc(t.techs.join(", "))}">${t.techs.length}</td></tr>`;
  });
  const stances = Object.entries(snap.stances).map(([k, v]) => {
    const [a, b] = k.split("|").map((id) => snap.teams.find((t) => t.id === id)?.name ?? id);
    return `<span class="${v === "war" ? "war" : ""}">${esc(a)}-${esc(b)}: ${v}</span>`;
  }).join(" &middot; ");
  const res = S.game.result && S.viewIdx < 0 ? `<div class="small"><b>Final:</b> ${S.game.result.ranking.map((t, i) => `#${i + 1} ${esc(snap.teams.find((x) => x.id === t)?.name)}`).join(", ")}</div>` : "";
  $("#scoreboard").innerHTML = `<div class="tablewrap"><table class="scores"><tr><th>Team</th><th>VP</th>${cols.map(([, l]) => `<th>${l}</th>`).join("")}<th>Sett.</th><th>Units</th><th>Techs</th></tr>${rows.join("")}</table></div><div class="stances">${stances}</div>${res}`;
}

function chanOk(ch) {
  if (S.chan === "all") return true;
  if (S.chan === "embassy") return ch.startsWith("embassy:");
  return ch === S.chan;
}
function chanLabel(ch) {
  const teams = S.game.log.teams;
  const n = (id) => teams.find((t) => t.id === id)?.name ?? id;
  if (ch === "public") return "public";
  if (ch.startsWith("team:")) return `${n(ch.slice(5))} team`;
  const [a, b] = ch.slice(8).split("|");
  return `embassy ${n(a)}-${n(b)}`;
}
function renderFeed() {
  const g = S.game;
  if (!g) return;
  const upto = S.viewIdx < 0 ? g.turns.length : S.viewIdx + 1;
  const items = [];
  for (const t of g.turns.slice(0, upto)) {
    if (S.chan !== "events") for (const m of t.messages) if (chanOk(m.channel)) items.push({ turn: t.turn, html: msgHtml(m) });
    if (S.chan === "all" || S.chan === "events") for (const e of t.events) if (e.kind !== "combat" || S.chan === "events") items.push({ turn: t.turn, html: `<div class="msg event"><span class="meta">t${e.turn} event</span> ${esc(e.text)}</div>` });
  }
  if (S.viewIdx < 0 && S.chan !== "events") for (const m of g.pending.messages) if (chanOk(m.channel)) items.push({ turn: m.turn, html: msgHtml(m) });
  $("#feed").innerHTML = items.slice(-400).reverse().map((i) => i.html).join("") || `<p class="muted">Nothing yet.</p>`;
}
function msgHtml(m) {
  const team = m.from.split("-")[0];
  return `<div class="msg"><div class="meta"><span class="sw" style="background:${teamColor(team)}"></span>t${m.turn} ${m.phase} &middot; ${esc(chanLabel(m.channel))} &middot; <b>${esc(m.from)}</b></div>${esc(m.text)}</div>`;
}

function renderAgent() {
  const g = S.game;
  $$("#agentList button").forEach((b) => b.classList.toggle("active", b.dataset.agent === S.agent));
  if (!g || !S.agent) { $("#agentDetail").innerHTML = `<p class="muted">Pick an agent to see its reasoning, orders, results and notes.</p>`; return; }
  const idx = currentTurnIdx();
  let decisions = [];
  let feedback = [];
  let turnNo;
  if (S.viewIdx < 0 && g.pending.decisions.some((d) => d.agent === S.agent)) {
    decisions = g.pending.decisions.filter((d) => d.agent === S.agent);
    turnNo = decisions[0].turn;
    feedback = idx >= 0 ? g.turns[idx].feedback[S.agent] ?? [] : [];
  } else if (idx >= 0) {
    const t = g.turns[idx];
    decisions = t.decisions.filter((d) => d.agent === S.agent);
    feedback = t.feedback[S.agent] ?? [];
    turnNo = t.turn;
  }
  const block = (title, body, cls = "") => (body ? `<div class="block ${cls}"><h5>${title}</h5>${esc(body)}</div>` : "");
  let html = `<div class="small muted">Turn ${turnNo ?? "-"}</div>`;
  for (const d of decisions) {
    html += `<h4>${d.phase === "council" ? "Council" : "Orders"} phase</h4>`;
    html += block("Reasoning", d.reasoning);
    if (d.thinking) html += block("Thinking (summary)", d.thinking);
    html += block("To team", d.team_message);
    html += block("Public", d.public_message);
    for (const e of d.embassy ?? []) html += block(`Embassy to ${e.team}`, e.message);
    if (d.orders?.length) html += block("Orders", d.orders.join("\n"), "mono");
    html += block("Notes", d.notes);
    if (d.error) html += block("Error", d.error);
  }
  if (feedback.length) html += block("Results", feedback.join("\n"), "mono");
  if (S.viewIdx < 0 && g.observations[S.agent]) html += `<details><summary class="small">Latest observation sent to ${esc(S.agent)}</summary><pre class="doc">${esc(g.observations[S.agent])}</pre></details>`;
  $("#agentDetail").innerHTML = html;
}

// ---------------- league view ----------------

function teamName(id) { return S.league?.file.teams.find((t) => t.id === id)?.name ?? id; }
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function renderLeague() {
  const L = S.league;
  if (!L) return;
  const s = L.file.settings;
  $("#leagueTitle").textContent = `League ${L.file.name}`;
  $("#leagueSettings").textContent = `${s.backend}${s.backend !== "mock" ? ` | ${s.model} | effort ${s.effort}` : ""} | council ${s.council ? "on" : "off"} | ${s.turns ?? 30} turns | ${L.results.length} games | ~$${L.results.reduce((a, r) => a + (r.usd || 0), 0).toFixed(2)} API-equivalent`;
  const teams = [...L.file.teams].sort((a, b) => L.ratings[b.id] - L.ratings[a.id]);
  $("#ratingsTable").innerHTML = `<div class="tablewrap"><table class="grid"><tr><th>Team</th><th>Elo</th><th>Games</th><th>Wins</th><th>Avg place</th><th>Avg VP</th></tr>${teams.map((t) => {
    const mine = L.results.filter((r) => r.seats.includes(t.id));
    return `<tr><td><span class="sw" style="background:${teamColor(t.id)}"></span>${esc(t.name)}</td><td>${L.ratings[t.id]}</td><td>${mine.length}</td><td>${mine.filter((r) => r.ranking[0] === t.id).length}</td><td>${mine.length ? mean(mine.map((r) => r.ranking.indexOf(t.id) + 1)).toFixed(2) : "-"}</td><td>${mine.length ? mean(mine.map((r) => r.scores[t.id].total)).toFixed(1) : "-"}</td></tr>`;
  }).join("")}</table></div>`;

  // Elo chart
  const elo = L.file.teams.map((t) => ({
    name: t.name, color: teamColor(t.id),
    points: [{ x: 0, y: 1500 }, ...L.results.map((r) => ({ x: r.number, y: r.ratings[t.id] ?? null })).filter((p) => p.y !== null)],
  }));
  lineChart($("#eloChart"), elo, { xLabel: "game", fmt: (v) => v.toFixed(0) });
  lineChart($("#divChart"), [{ name: "Divergence", color: "var(--t1)", points: L.divergence.map((d, i) => ({ x: i + 1, y: d.distance, label: d.games })) }], { xLabel: "block of 3 games", fmt: (v) => v.toFixed(2), single: true });

  // Style table
  const keys = Object.keys(STYLE_SHORT);
  $("#styleTable").innerHTML = `<div class="tablewrap"><table class="grid"><tr><th>Team</th>${keys.map((k) => `<th>${STYLE_SHORT[k]}</th>`).join("")}</tr>${L.file.teams.map((t) => {
    const vs = L.results.filter((r) => r.styles[t.id]).slice(-5).map((r) => r.styles[t.id]);
    if (!vs.length) return "";
    return `<tr><td><span class="sw" style="background:${teamColor(t.id)}"></span>${esc(t.name)}</td>${keys.map((k) => `<td>${Math.round(mean(vs.map((v) => v[k])) * 100)}%</td>`).join("")}</tr>`;
  }).join("")}</table></div>`;

  $("#gamesTable").innerHTML = `<div class="tablewrap"><table class="grid"><tr><th>Game</th><th>Result</th><th>Turns</th><th>Cost</th></tr>${[...L.results].reverse().map((r) => `<tr class="click" data-game="${r.game}"><td>${r.game}</td><td style="text-align:left">${r.ranking.map((t, i) => `#${i + 1} ${esc(teamName(t))} ${r.scores[t].total}`).join(", ")}</td><td>${r.turns}</td><td>$${(r.usd || 0).toFixed(2)}</td></tr>`).join("")}</table></div><p class="small muted">Click a game to replay it in the Game tab.</p>`;
  $$("#gamesTable tr.click").forEach((tr) => (tr.onclick = () => openReplay(tr.dataset.game)));

  $("#teamPick").innerHTML = L.file.teams.map((t) => `<button data-team="${t.id}" class="${t.id === S.team ? "active" : ""}" style="border-left:4px solid ${teamColor(t.id)}">${esc(t.name)}</button>`).join("");
  $$("#teamPick button").forEach((b) => (b.onclick = () => { S.team = b.dataset.team; renderLeague(); }));
  renderTeam();
}

async function renderTeam() {
  const L = S.league;
  const t = L.file.teams.find((x) => x.id === S.team);
  if (!t) return;
  const rows = L.results.filter((r) => r.styles[t.id]);
  const spendKeys = ["military_spend", "expansion_spend", "development_spend", "tech_spend"];
  lineChart($("#styleTrend"), spendKeys.map((k, i) => ({ name: STYLE_SHORT[k], color: `var(--t${i + 1})`, points: rows.map((r, j) => ({ x: j + 1, y: r.styles[t.id][k] })) })), { xLabel: `${t.name}'s games (share of spending)`, fmt: (v) => `${Math.round(v * 100)}%`, yMin: 0, yMax: 1 });
  $("#playbook").textContent = L.playbooks[t.id] || "(empty: the team has not finished a game yet)";
  $("#memories").innerHTML = t.agents.map((a) => `<div class="block"><h5>${esc(a)}</h5>${esc(L.memories[a] || "(empty)")}</div>`).join("");
  const hist = (await api(`/api/league/${encodeURIComponent(L.file.name)}/history/${t.id}`)).filter((h) => !h.game.endsWith("-report"));
  $("#historySel").innerHTML = hist.length ? [...hist].reverse().map((h) => `<option value="${h.game}">${h.game}</option>`).join("") : `<option>(none)</option>`;
  const show = () => { $("#historyDoc").textContent = hist.find((h) => h.game === $("#historySel").value)?.text ?? ""; };
  $("#historySel").onchange = show;
  show();
}

async function openReplay(id) {
  if (S.run?.active && S.game?.log.id === id) { switchTab("game"); return; }
  const log = await api(`/api/league/${encodeURIComponent(S.leagueName)}/game/${id}`);
  S.game = { log, turns: log.turns, pending: { decisions: [], messages: [] }, observations: {}, live: false, result: log.result };
  S.viewIdx = 0;
  setupGame();
  switchTab("game");
  renderGame();
}

// ---------------- line chart (SVG, crosshair tooltip) ----------------

function lineChart(el, series, opt = {}) {
  const W = 560, H = 200, m = { l: 40, r: series.length <= 4 && !opt.single ? 84 : 14, t: 10, b: 26 };
  const pts = series.flatMap((s) => s.points);
  if (pts.length < 2) { el.innerHTML = `<p class="muted small">Not enough games yet.</p>`; return; }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = opt.yMin ?? Math.min(...ys), y1 = opt.yMax ?? Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = opt.yMin === undefined ? (y1 - y0) * 0.08 : 0;
  y0 -= pad; y1 += pad;
  const X = (x) => m.l + ((x - x0) / Math.max(1e-9, x1 - x0)) * (W - m.l - m.r);
  const Y = (y) => H - m.b - ((y - y0) / (y1 - y0)) * (H - m.t - m.b);
  const ticks = 4;
  let g = `<g class="axis">`;
  for (let i = 0; i <= ticks; i++) {
    const v = y0 + ((y1 - y0) * i) / ticks;
    g += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 3}" text-anchor="end">${opt.fmt ? opt.fmt(v) : v.toFixed(1)}</text>`;
  }
  const xt = [...new Set(xs)].sort((a, b) => a - b);
  const step = Math.ceil(xt.length / 8);
  xt.filter((_, i) => i % step === 0).forEach((x) => (g += `<text x="${X(x)}" y="${H - m.b + 14}" text-anchor="middle">${x}</text>`));
  g += `<text x="${(m.l + W - m.r) / 2}" y="${H - 2}" text-anchor="middle">${esc(opt.xLabel ?? "")}</text></g>`;
  const ends = [];
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = s.points[s.points.length - 1];
    g += `<circle cx="${X(last.x)}" cy="${Y(last.y)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
    ends.push({ x: X(last.x) + 8, y: Y(last.y) + 3, name: s.name });
  }
  if (m.r > 20) {
    // Nudge direct labels apart so they never overlap.
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
    for (const e of ends) g += `<text x="${e.x}" y="${e.y}" font-size="10.5" fill="var(--text-2)">${esc(e.name)}</text>`;
  }
  g += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)" stroke-dasharray="3 3" style="display:none"/>`;
  g += `<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" class="hit"/>`;
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opt.xLabel ?? "chart")}">${g}</svg>${legend}<div class="tooltip"></div>`;
  const svg = $("svg", el), tip = $(".tooltip", el), xh = $(".xh", el);
  $(".hit", el).onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const x = xt.reduce((a, b) => (Math.abs(X(b) - px) < Math.abs(X(a) - px) ? b : a));
    xh.setAttribute("x1", X(x)); xh.setAttribute("x2", X(x)); xh.style.display = "";
    const rowsHtml = series.map((s) => { const p = s.points.find((p) => p.x === x); return p ? `<div><span class="sw" style="background:${s.color}"></span>${esc(s.name)}: <b>${opt.fmt ? opt.fmt(p.y) : p.y}</b>${p.label ? ` <span class="muted">${esc(p.label)}</span>` : ""}</div>` : ""; }).join("");
    tip.innerHTML = `<div class="muted">${esc(opt.xLabel ?? "x")} ${x}</div>${rowsHtml}`;
    tip.style.display = "block";
    const left = (X(x) / W) * r.width;
    tip.style.left = `${Math.min(left + 12, r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `8px`;
  };
  $(".hit", el).onmouseleave = () => { tip.style.display = "none"; xh.style.display = "none"; };
}

// ---------------- boot ----------------

switchTab(localGet("tab") || "game");
loadMeta().then(connect).catch((e) => ($("#status").textContent = String(e)));
