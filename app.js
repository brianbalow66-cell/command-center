"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = (path, opts) => fetch(path, Object.assign({ credentials: "same-origin" }, opts));

/* ---------- clock ---------- */
function tick() {
  const n = new Date();
  $("#clock").innerHTML = "<b>" + n.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) +
    "</b> &middot; " + n.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/* ---------- auth gate ---------- */
async function boot() {
  let me = null;
  try { const r = await api("/api/me"); if (r.ok) me = await r.json(); } catch (e) {}
  if (!me) { $("#gate").hidden = false; return; }

  $("#app").hidden = false;
  if (me.picture) { const a = $("#avatar"); a.src = me.picture; a.hidden = false; }
  tick(); setInterval(tick, 20000);
  try{const cfg=await api("/api/config").then(r=>r.json());if(cfg){if(cfg.accent)document.documentElement.style.setProperty("--accent",cfg.accent);if(cfg.title)document.title=cfg.title;if(cfg.calDays){const cd=document.getElementById("cal-days");if(cd)cd.textContent=cfg.calDays;}if(Array.isArray(cfg.hidePanels))cfg.hidePanels.forEach(function(id){var el=document.getElementById(id);if(el){var card=el.closest(".card");if(card)card.style.display="none";}});}}catch(e){}

  renderTodos(); renderProjs(); setupNotif();
  await Promise.all([loadTodos(), loadProjs()]);
  checkReminders(); setInterval(checkReminders, 30000);

  loadMarket(); loadCalendar(); loadMail(); loadResearch(); loadTracker();
  // auto-refresh live data (markets refresh hourly server-side; poll every 15 min to pick up updates)
  setInterval(loadMarket, 15 * 60000);
  setInterval(loadCalendar, 5 * 60000);
  setInterval(loadMail, 3 * 60000);
  setInterval(loadResearch, 10 * 60000);
  setInterval(loadTracker, 5 * 60000);
}

/* ---------- markets ---------- */
const fmtNum = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
function pctSpan(v) {
  if (v == null) return '<span class="muted">—</span>';
  const up = v >= 0;
  return '<span class="' + (up ? "up" : "down") + '">' + (up ? "+" : "") + v.toFixed(2) + "%</span>";
}
async function loadMarket() {
  const el = $("#mkt");
  try {
    const d = await api("/api/markets").then((r) => r.json());
    const arr = d.markets || [];
    const anyLive = arr.some((q) => q.state === "REGULAR");
    $("#mkt-status").textContent = arr.every((q) => q.price == null) ? "" : (anyLive ? "live" : "last close");
    el.className = "mkt";
    el.innerHTML = arr.map((q) => {
      const px = q.price != null ? fmtNum(q.price) : "—";
      const day = q.changePercent;
      const up = day != null ? day >= 0 : true;
      const dayTxt = day != null ? ((up ? "▲ +" : "▼ ") + day.toFixed(2) + "%") : "";
      return '<div class="tile"><div class="nm">' + esc(q.name) + '</div><div class="px">' + px +
        '</div><div class="ch ' + (up ? "up" : "down") + '">' + dayTxt + ' <span class="lbl">today</span></div>' +
        '<div class="mty">MTD ' + pctSpan(q.mtd) + ' &middot; YTD ' + pctSpan(q.ytd) + "</div></div>";
    }).join("");
  } catch (err) { el.innerHTML = '<div class="err">Markets unavailable.</div>'; }
}

/* ---------- calendar ---------- */
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
async function loadCalendar() {
  const el = $("#cal");
  try {
    const d = await api("/api/calendar").then((r) => r.json());
    const evs = (d.events || []).filter((e) => e.status !== "cancelled");
    $("#cal-status").textContent = evs.length + " events";
    if (!evs.length) { el.innerHTML = '<div class="empty">Nothing scheduled. Enjoy the calm.</div>'; return; }
    el.innerHTML = evs.map((e) => {
      const s = e.start && (e.start.dateTime || e.start.date);
      const allDay = !!(e.start && e.start.date && !e.start.dateTime);
      const dt = s ? new Date(s) : null;
      const time = allDay ? "All day" : (dt ? dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
      const wd = dt ? dt.toLocaleDateString("en-US", { weekday: "short" }) : "";
      const loc = e.location ? " &middot; " + esc(e.location.length > 40 ? e.location.slice(0, 40) + "…" : e.location) : "";
      const tag = e.eventType === "fromGmail" ? '<span class="pill">gmail</span>' : "";
      return '<div class="ev"><div class="day"><div class="d">' + (dt ? dt.getDate() : "") + '</div><div class="m">' +
        (dt ? MON[dt.getMonth()] : "") + '</div></div><div class="body"><div class="ti">' +
        esc(e.summary) + tag + '</div><div class="mt">' + wd + " &middot; " + esc(time) + loc + "</div></div></div>";
    }).join("");
  } catch (err) { el.innerHTML = '<div class="err">Calendar unavailable.</div>'; }
}

/* ---------- gmail ---------- */
function ago(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}
function nmeOf(addr) { if (!addr) return ""; const m = addr.match(/"?([^"<]+)"?\s*</); let n = m ? m[1].trim() : addr.split("@")[0]; return n.replace(/^["']|["']$/g, ""); }
let DRAFTS = {}; // threadId -> prepared draft info
async function loadDrafts() {
  try {
    const d = await api("/api/drafts").then((r) => r.json());
    DRAFTS = {};
    (d.items || []).forEach((it) => { if (it && it.threadId) DRAFTS[it.threadId] = it; });
  } catch (e) { /* leave DRAFTS as-is */ }
}
async function loadMail() {
  const el = $("#mail");
  try {
    await loadDrafts();
    const d = await api("/api/gmail").then((r) => r.json());
    const items = d.messages || [];
    let unread = 0, dcount = 0;
    el.innerHTML = items.map((m) => {
      const labels = m.labelIds || [];
      const isUnread = labels.includes("UNREAD"); if (isUnread) unread++;
      const isImp = labels.includes("IMPORTANT");
      const snip = (m.snippet || "").replace(/[͏​‌‍­‎﻿\s]+/g, " ").trim();
      const draft = m.threadId && DRAFTS[m.threadId];
      let badge = "";
      if (draft) { dcount++; const url = "https://mail.google.com/mail/u/0/#all/" + encodeURIComponent(m.threadId); badge = '<a class="draftbadge" href="' + url + '" target="_blank" rel="noopener" title="Reply draft ready in your Gmail — click to review">✎ draft ready</a>'; }
      return '<div class="ml"><span class="dot ' + (isUnread ? "unread" : "") + '"></span>' +
        '<div style="flex:1;min-width:0"><div class="from">' + (isImp ? '<span class="imp">&#9733; </span>' : "") + esc(nmeOf(m.sender)) +
        '</div><div class="subj">' + esc(m.subject) + '</div><div class="snip">' + esc(snip.slice(0, 90)) +
        '</div>' + badge + '</div><div class="when">' + (m.date ? ago(m.date) : "") + "</div></div>";
    }).join("") || '<div class="empty">Inbox zero.</div>';
    $("#mail-status").textContent = unread + " unread" + (dcount ? " · " + dcount + " draft" + (dcount > 1 ? "s" : "") : "");
  } catch (err) { el.innerHTML = '<div class="err">Mail unavailable.</div>'; }
}

function briefItem(it){
  var t=(it&&typeof it==="object")?(it.t||it.text||""):it;
  var u=(it&&typeof it==="object")?(it.u||it.url||""):"";
  if(u){return '<li><a href="'+esc(u)+'" target="_blank" rel="noopener">'+esc(t)+'<span class="ext">\u2197</span></a></li>';}
  return "<li>"+esc(t)+"</li>";
}
let ARCHIVE = [];
async function loadArchive(){ try{ const d = await api("/api/research/archive").then((r)=>r.json()); ARCHIVE = d.entries || []; }catch(e){ ARCHIVE = []; } }
function archiveHtml(cat){
  const blocks = [];
  ARCHIVE.forEach((entry)=>{
    const sec = (entry.sections||[]).find((s)=>s.title===cat);
    if (sec && sec.items && sec.items.length){
      const date = entry.updated ? new Date(entry.updated).toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "";
      blocks.push('<div class="rarch-day"><div class="rarch-date">'+esc(date)+'</div><ul class="rlist">'+sec.items.map(briefItem).join("")+'</ul></div>');
    }
  });
  return blocks.length ? blocks.join("") : '<div class="rarch-empty">No earlier entries yet \u2014 history builds up with each morning\u2019s briefing.</div>';
}
async function loadResearch(){const el=$("#research");if(!el)return;try{const d=await api("/api/research").then(r=>r.json());await loadArchive();const secs=(d&&d.sections)||[];if(!secs.length){el.className="";el.innerHTML='<div class="empty">No briefing yet \u2014 it updates each morning.</div>';$("#research-status").textContent="";return;}$("#research-status").textContent=d.updated?("updated "+new Date(d.updated).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})):"";el.className="rcols";el.innerHTML=secs.map(s=>'<div class="rsec"><div class="rtitle">'+esc(s.title)+'<a class="rarch-link" href="#" data-cat="'+esc(s.title)+'">archive</a></div><ul class="rlist">'+((s.items)||[]).map(briefItem).join("")+'</ul><div class="rarch" data-cat="'+esc(s.title)+'" hidden></div></div>').join("");}catch(e){el.innerHTML='<div class="err">Briefing unavailable.</div>';}}
/* ---------- SpaceX tracker ---------- */
let TRK = {};
async function loadTracker() {
  const card = $("#tracker-card"); if (!card) return;
  const el = $("#trk");
  try {
    const d = await api("/api/tracker").then((r) => r.json());
    const c = d.config || {}; TRK = c;
    const price = d.price, day = d.changePercent;
    const dayCls = day != null ? (day >= 0 ? "up" : "down") : "";
    const dayTxt = day != null ? ((day >= 0 ? "▲ +" : "▼ ") + day.toFixed(2) + "%") : "";
    $("#trk-status").textContent = d.state === "REGULAR" ? "live" : (price != null ? "last close" : "");
    const cb = c.costBasis;
    let plHtml = '<span class="muted">set cost basis</span>';
    if (cb != null && price != null) { const pl = (price - cb) / cb * 100; const up = pl >= 0; plHtml = '<span class="' + (up ? "up" : "down") + '">' + (up ? "+" : "") + pl.toFixed(1) + "%</span>"; }
    const cbVal = cb != null ? ("$" + fmtNum(cb)) : "—";
    const sharesTxt = c.shares ? (" · " + c.shares + " sh") : "";
    const tgt = (c.targetLow != null && c.targetHigh != null) ? ("$" + fmtNum(c.targetLow) + " – $" + fmtNum(c.targetHigh)) : "—";
    const tgtAvg = c.targetAvg != null ? ("avg $" + fmtNum(c.targetAvg)) : "";
    const today = new Date().toISOString().slice(0, 10);
    const ups = (c.lockups || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const next = ups.find((l) => l.date >= today) || ups[ups.length - 1];
    const fmtD = (s) => { const dt = new Date(s + "T00:00:00"); return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
    let posVal = "—", posSub = "";
    if (price != null && c.shares) {
      posVal = "$" + fmtNum(price * c.shares);
      if (cb != null) {
        const g = (price - cb) * c.shares; const up = g >= 0; const pl = (price - cb) / cb * 100;
        posSub = '<span class="' + (up ? "up" : "down") + '">' + (up ? "+" : "−") + "$" + fmtNum(Math.abs(g)) + " (" + (up ? "+" : "") + pl.toFixed(1) + "%)</span>";
      }
    }
    el.innerHTML =
      '<div class="trk-cell"><div class="lab">' + esc(c.ticker || "SPCX") + ' · Current</div><div class="val">' + (price != null ? ("$" + fmtNum(price)) : "—") + '</div><div class="sub ' + dayCls + '">' + dayTxt + '</div></div>' +
      '<div class="trk-cell"><div class="lab">Cost basis <span class="trk-edit" id="trk-edit">✎ edit</span></div><div class="val">' + cbVal + sharesTxt + '</div><div class="sub">P/L ' + plHtml + '</div></div>' +
      '<div class="trk-cell"><div class="lab">Position value</div><div class="val" style="font-size:16px">' + posVal + '</div><div class="sub">Unrealized ' + (posSub || "—") + '</div></div>' +
      '<div class="trk-cell"><div class="lab">Analyst target · 12 mo</div><div class="val" style="font-size:15px">' + tgt + '</div><div class="sub">' + tgtAvg + '</div></div>' +
      '<div class="trk-cell" style="flex:1.4"><div class="lab">Next lock-up release</div><div class="val" style="font-size:15px">' + (next ? fmtD(next.date) : "—") + '</div><div class="sub">' + (next ? esc(next.label) : "") + '</div></div>';
    const eb = $("#trk-edit"); if (eb) eb.onclick = editTracker;
    card.hidden = false;
  } catch (e) { el.innerHTML = '<div class="err">Tracker unavailable.</div>'; card.hidden = false; }
}
function editTracker() {
  const cbStr = prompt("Your average cost basis per share (e.g. 135):", TRK.costBasis != null ? TRK.costBasis : "");
  if (cbStr === null) return;
  const cb = parseFloat(cbStr);
  const shStr = prompt("Number of shares (optional):", TRK.shares != null ? TRK.shares : "");
  const sh = (shStr !== null && shStr.trim() !== "") ? parseInt(shStr, 10) : null;
  const next = Object.assign({}, TRK, { costBasis: isNaN(cb) ? null : cb, shares: (sh != null && !isNaN(sh)) ? sh : null });
  api("/api/tracker", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }).then(() => loadTracker());
}

/* ---------- shared list store (KV + localStorage cache) ---------- */
function lget(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lset(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------- to-dos ---------- */
let TODOS = [];
const saveTodosRemote = debounce(() => { api("/api/todos", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: TODOS }) }).catch(() => {}); }, 600);
function persistTodos() { lset("cc_todos", TODOS); saveTodosRemote(); }
async function loadTodos() {
  TODOS = lget("cc_todos") || [];
  renderTodos();
  try { const d = await api("/api/todos").then((r) => r.json()); if (d.items) { TODOS = d.items; lset("cc_todos", TODOS); renderTodos(); } } catch (e) {}
}
function fmtRem(iso) {
  const d = new Date(iso), now = new Date();
  const same = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return { lbl: same ? "Today " + t : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + t, past: d < now };
}
let SHOW_ARCHIVED = false;
const STATUSES = ["active", "waiting", "hold"];
function statusChip(s) {
  s = STATUSES.indexOf(s) >= 0 ? s : "active";
  const cls = { active: "st-active", waiting: "st-waiting", hold: "st-hold" }[s];
  return '<span class="tstatus ' + cls + '" data-act="status" title="Click to change status">' + s + "</span>";
}
function renderTodos() {
  const el = $("#todos");
  const openCount = TODOS.filter((t) => !t.archived && !t.done).length;
  const archCount = TODOS.filter((t) => t.archived).length;
  $("#todo-count").textContent = openCount + " open";
  const toggle = $("#arch-toggle");
  if (toggle) toggle.textContent = SHOW_ARCHIVED ? "← back to active" : (archCount ? "View archived (" + archCount + ")" : "");
  const visible = TODOS.filter((t) => (SHOW_ARCHIVED ? t.archived : !t.archived));
  if (!visible.length) { el.innerHTML = '<div class="empty">' + (SHOW_ARCHIVED ? "No archived tasks." : "No tasks yet. Add one above.") + "</div>"; return; }
  visible.sort((a, b) => (a.done - b.done) || (STATUSES.indexOf(a.status || "active") - STATUSES.indexOf(b.status || "active")) || ((a.when || "9") > (b.when || "9") ? 1 : -1));
  el.innerHTML = visible.map((t) => {
    let rem = "";
    if (t.when) { const r = fmtRem(t.when); rem = '<div class="rem ' + (r.past && !t.done ? "past" : "") + '">&#9200; ' + esc(r.lbl) + "</div>"; }
    const chip = t.archived ? "" : statusChip(t.status);
    const archBtn = t.archived
      ? '<button class="arch" data-act="unarch" title="Restore to active">&#8617;</button>'
      : '<button class="arch" data-act="arch" title="Archive">&#128229;</button>';
    return '<div class="todo ' + (t.done ? "done " : "") + (t.archived ? "archived" : "") + '" data-id="' + t.id + '"><input type="checkbox" ' +
      (t.done ? "checked" : "") + ' data-act="chk"><div class="tx"><div class="tt">' + chip + esc(t.text) + "</div>" + rem +
      "</div>" + archBtn + '<button class="del" data-act="del" title="Delete">&times;</button></div>';
  }).join("");
}
function addTodo() {
  const tx = $("#t-text").value.trim(); if (!tx) return;
  TODOS.push({ id: Date.now() + "" + Math.floor(Math.random() * 99), text: tx, when: $("#t-when").value || null, status: "active", done: false, archived: false, notified: false });
  $("#t-text").value = ""; $("#t-when").value = ""; persistTodos(); renderTodos();
}

/* ---------- projects ---------- */
let PROJS = [];
const saveProjsRemote = debounce(() => { api("/api/projects", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: PROJS }) }).catch(() => {}); }, 600);
function persistProjs() { lset("cc_projects", PROJS); saveProjsRemote(); }
async function loadProjs() {
  PROJS = lget("cc_projects") || [{ id: "p1", name: "Project 1", pct: 0 }, { id: "p2", name: "Project 2", pct: 0 }];
  renderProjs();
  try { const d = await api("/api/projects").then((r) => r.json()); if (d.items) { PROJS = d.items; lset("cc_projects", PROJS); renderProjs(); } } catch (e) {}
}
let pchart = null;
function drawChart() {
  const cv = $("#pchart"); if (!cv) return;
  const done = PROJS.length ? Math.round(PROJS.reduce((s, p) => s + (+p.pct || 0), 0) / PROJS.length) : 0;
  if (pchart) { pchart.data.datasets[0].data = [done, 100 - done]; pchart.update(); }
  else pchart = new Chart(cv, { type: "doughnut", data: { labels: ["Done", "Left"], datasets: [{ data: [done, 100 - done], backgroundColor: ["#34d77f", "#1a222e"], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: "72%", plugins: { legend: { display: false }, tooltip: { enabled: false } } } });
}
function projStatusChip(s) {
  s = STATUSES.indexOf(s) >= 0 ? s : "active";
  const cls = { active: "st-active", waiting: "st-waiting", hold: "st-hold" }[s];
  return '<span class="tstatus ' + cls + '" data-act="ptstatus" title="Click to change status">' + s + "</span>";
}
function addProjTask(projId, input) {
  const tx = input.value.trim(); if (!tx) return;
  const p = PROJS.find((x) => x.id === projId); if (!p) return;
  if (!p.tasks) p.tasks = [];
  p.tasks.push({ id: "pt" + Date.now() + "" + Math.floor(Math.random() * 99), text: tx, status: "active", done: false });
  input.value = ""; persistProjs(); renderProjs();
}
function renderProjs() {
  const el = $("#projs");
  $("#proj-avg").textContent = PROJS.length ? Math.round(PROJS.reduce((s, p) => s + (+p.pct || 0), 0) / PROJS.length) + "% avg" : "";
  el.innerHTML = PROJS.length ? PROJS.map((p) => {
    const tasks = p.tasks || [];
    const openT = tasks.filter((t) => !t.done).length;
    const tasksHtml = tasks.length ? tasks.map((t) =>
      '<div class="ptask ' + (t.done ? "done" : "") + '" data-tid="' + t.id + '"><input type="checkbox" ' + (t.done ? "checked" : "") +
      ' data-act="ptchk">' + projStatusChip(t.status) + '<span class="ptt">' + esc(t.text) +
      '</span><button class="del" data-act="ptdel" title="Delete task">&times;</button></div>'
    ).join("") : '<div class="ptask-empty">No tasks yet.</div>';
    return '<div class="proj" data-id="' + p.id + '"><div class="ph"><div class="pn">' + esc(p.name) +
      '</div><div style="display:flex;align-items:center;gap:8px"><span class="pv">' + (+p.pct) + '%</span>' +
      '<button class="del" data-act="pdel" title="Remove project">&times;</button></div></div>' +
      '<div class="bar"><i style="width:' + (+p.pct) + '%"></i></div>' +
      '<div class="prng"><input type="range" min="0" max="100" step="5" value="' + (+p.pct) + '" data-act="prng"></div>' +
      '<div class="ptasks">' + tasksHtml + '</div>' +
      '<div class="ptadd"><input type="text" class="ptadd-in" placeholder="Add task under ' + esc(p.name) + '…" maxlength="120">' +
      '<button class="btn ghost ptadd-btn" data-act="ptadd">Add</button></div></div>';
  }).join("") : '<div class="empty">No projects. Add one above.</div>';
  drawChart();
}

/* ---------- reminders ---------- */
function setupNotif() {
  const note = $("#notif-note");
  if (!("Notification" in window)) { note.textContent = ""; return; }
  if (Notification.permission === "granted") note.textContent = "Reminders on — you'll be notified when a task is due.";
  else if (Notification.permission !== "denied") {
    note.innerHTML = '<a href="#" id="enable-notif">Enable reminder notifications</a>';
    note.querySelector("#enable-notif").onclick = (e) => { e.preventDefault(); Notification.requestPermission().then(setupNotif); };
  } else note.textContent = "Notifications blocked — due tasks still turn red.";
}
function checkReminders() {
  let changed = false; const now = Date.now();
  TODOS.forEach((t) => {
    if (t.when && !t.done && !t.notified && new Date(t.when).getTime() <= now) {
      t.notified = true; changed = true;
      if ("Notification" in window && Notification.permission === "granted") { try { new Notification("⏰ Task due", { body: t.text }); } catch (e) {} }
    }
  });
  if (changed) { persistTodos(); renderTodos(); }
}

/* ---------- events ---------- */
document.addEventListener("DOMContentLoaded", () => {
  $("#t-add").onclick = addTodo;
  $("#t-text").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
  $("#todos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const id = b.closest(".todo").dataset.id;
    const t = TODOS.find((x) => x.id === id);
    const act = b.dataset.act;
    if (act === "del") TODOS = TODOS.filter((x) => x.id !== id);
    else if (act === "chk") { if (t) t.done = !t.done; }
    else if (act === "status") { if (t) { const i = STATUSES.indexOf(t.status || "active"); t.status = STATUSES[(i + 1) % STATUSES.length]; } }
    else if (act === "arch") { if (t) { t.archived = true; } }
    else if (act === "unarch") { if (t) { t.archived = false; } }
    persistTodos(); renderTodos();
  });
  const archToggle = $("#arch-toggle");
  if (archToggle) archToggle.addEventListener("click", (e) => { e.preventDefault(); SHOW_ARCHIVED = !SHOW_ARCHIVED; renderTodos(); });
  const research = $("#research");
  if (research) research.addEventListener("click", (e) => {
    const a = e.target.closest(".rarch-link"); if (!a) return; e.preventDefault();
    const cat = a.dataset.cat;
    const panel = a.closest(".rsec").querySelector(".rarch");
    if (!panel) return;
    if (panel.hidden) { panel.innerHTML = archiveHtml(cat); panel.hidden = false; a.textContent = "hide"; }
    else { panel.hidden = true; a.textContent = "archive"; }
  });
  $("#p-add").onclick = () => {
    const nm = $("#p-name").value.trim(); if (!nm) return;
    PROJS.push({ id: "p" + Date.now(), name: nm, pct: 0 }); $("#p-name").value = ""; persistProjs(); renderProjs();
  };
  $("#p-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#p-add").click(); });
  $("#projs").addEventListener("input", (e) => {
    if (e.target.dataset.act === "prng") {
      const projEl = e.target.closest(".proj"); const p = PROJS.find((x) => x.id === projEl.dataset.id);
      if (p) {
        p.pct = +e.target.value;
        const bar = projEl.querySelector(".bar > i"); if (bar) bar.style.width = p.pct + "%";
        const pv = projEl.querySelector(".pv"); if (pv) pv.textContent = p.pct + "%";
        $("#proj-avg").textContent = PROJS.length ? Math.round(PROJS.reduce((s, x) => s + (+x.pct || 0), 0) / PROJS.length) + "% avg" : "";
        drawChart(); persistProjs();
      }
    }
  });
  $("#projs").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("ptadd-in")) { const projEl = e.target.closest(".proj"); if (projEl) addProjTask(projEl.dataset.id, e.target); }
  });
  $("#projs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); const projEl = e.target.closest(".proj"); if (!projEl) return;
    const pid = projEl.dataset.id; const p = PROJS.find((x) => x.id === pid);
    if (!b) return;
    const act = b.dataset.act;
    if (act === "pdel") { PROJS = PROJS.filter((x) => x.id !== pid); persistProjs(); renderProjs(); return; }
    if (act === "ptadd") { const inp = projEl.querySelector(".ptadd-in"); if (inp) addProjTask(pid, inp); return; }
    const taskEl = e.target.closest(".ptask");
    if (taskEl && p) {
      const tid = taskEl.dataset.tid; const t = (p.tasks || []).find((x) => x.id === tid);
      if (act === "ptchk") { if (t) t.done = !t.done; }
      else if (act === "ptstatus") { if (t) { const i = STATUSES.indexOf(t.status || "active"); t.status = STATUSES[(i + 1) % STATUSES.length]; } }
      else if (act === "ptdel") { p.tasks = (p.tasks || []).filter((x) => x.id !== tid); }
      else return;
      persistProjs(); renderProjs();
    }
  });
  boot();
});
