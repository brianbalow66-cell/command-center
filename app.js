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

  loadMarket(); loadCalendar(); loadMail(); loadResearch();
  // auto-refresh live data
  setInterval(loadMarket, 60000);
  setInterval(loadCalendar, 5 * 60000);
  setInterval(loadMail, 3 * 60000);
  setInterval(loadResearch, 10 * 60000);
}

/* ---------- markets ---------- */
const fmtNum = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
async function loadMarket() {
  const el = $("#mkt");
  try {
    const d = await api("/api/markets").then((r) => r.json());
    const arr = d.markets || [];
    $("#mkt-status").textContent = "live";
    el.className = "mkt";
    el.innerHTML = arr.map((q) => {
      const px = q.price != null ? fmtNum(q.price) : "—";
      const ch = q.change, chp = q.changePercent;
      const up = ch != null ? ch >= 0 : true;
      const chTxt = ch != null ? ((up ? "+" : "") + fmtNum(ch) + (chp != null ? "  (" + (up ? "+" : "") + chp.toFixed(2) + "%)" : "")) : "";
      return '<div class="tile"><div class="nm">' + esc(q.name) + '</div><div class="px">' + px +
        '</div><div class="ch ' + (up ? "up" : "down") + '">' + chTxt + "</div></div>";
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
async function loadMail() {
  const el = $("#mail");
  try {
    const d = await api("/api/gmail").then((r) => r.json());
    const items = d.messages || [];
    let unread = 0;
    el.innerHTML = items.map((m) => {
      const labels = m.labelIds || [];
      const isUnread = labels.includes("UNREAD"); if (isUnread) unread++;
      const isImp = labels.includes("IMPORTANT");
      const snip = (m.snippet || "").replace(/[͏​‌‍­‎﻿\s]+/g, " ").trim();
      return '<div class="ml"><span class="dot ' + (isUnread ? "unread" : "") + '"></span>' +
        '<div style="flex:1;min-width:0"><div class="from">' + (isImp ? '<span class="imp">&#9733; </span>' : "") + esc(nmeOf(m.sender)) +
        '</div><div class="subj">' + esc(m.subject) + '</div><div class="snip">' + esc(snip.slice(0, 90)) +
        '</div></div><div class="when">' + (m.date ? ago(m.date) : "") + "</div></div>";
    }).join("") || '<div class="empty">Inbox zero.</div>';
    $("#mail-status").textContent = unread + " unread";
  } catch (err) { el.innerHTML = '<div class="err">Mail unavailable.</div>'; }
}

async function loadResearch(){const el=$("#research");if(!el)return;try{const d=await api("/api/research").then(r=>r.json());const secs=(d&&d.sections)||[];if(!secs.length){el.className="";el.innerHTML='<div class="empty">No briefing yet \u2014 it updates each morning.</div>';$("#research-status").textContent="";return;}$("#research-status").textContent=d.updated?("updated "+new Date(d.updated).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})):"";el.className="rcols";el.innerHTML=secs.map(s=>'<div class="rsec"><div class="rtitle">'+esc(s.title)+'</div><ul class="rlist">'+((s.items)||[]).map(it=>"<li>"+esc(it)+"</li>").join("")+'</ul></div>').join("");}catch(e){el.innerHTML='<div class="err">Briefing unavailable.</div>';}}
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
function renderTodos() {
  const el = $("#todos");
  $("#todo-count").textContent = TODOS.filter((t) => !t.done).length + " open";
  if (!TODOS.length) { el.innerHTML = '<div class="empty">No tasks yet. Add one above.</div>'; return; }
  TODOS.sort((a, b) => (a.done - b.done) || ((a.when || "9") > (b.when || "9") ? 1 : -1));
  el.innerHTML = TODOS.map((t) => {
    let rem = "";
    if (t.when) { const r = fmtRem(t.when); rem = '<div class="rem ' + (r.past && !t.done ? "past" : "") + '">&#9200; ' + esc(r.lbl) + "</div>"; }
    return '<div class="todo ' + (t.done ? "done" : "") + '" data-id="' + t.id + '"><input type="checkbox" ' +
      (t.done ? "checked" : "") + ' data-act="chk"><div class="tx"><div class="tt">' + esc(t.text) + "</div>" + rem +
      '</div><button class="del" data-act="del" title="Delete">&times;</button></div>';
  }).join("");
}
function addTodo() {
  const tx = $("#t-text").value.trim(); if (!tx) return;
  TODOS.push({ id: Date.now() + "" + Math.floor(Math.random() * 99), text: tx, when: $("#t-when").value || null, done: false, notified: false });
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
  else pchart = new Chart(cv, { type: "doughnut", data: { labels: ["Done", "Left"], datasets: [{ data: [done, 100 - done], backgroundColor: ["#3b66f5", "#eef1f7"], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: "72%", plugins: { legend: { display: false }, tooltip: { enabled: false } } } });
}
function renderProjs() {
  const el = $("#projs");
  $("#proj-avg").textContent = PROJS.length ? Math.round(PROJS.reduce((s, p) => s + (+p.pct || 0), 0) / PROJS.length) + "% avg" : "";
  el.innerHTML = PROJS.length ? PROJS.map((p) =>
    '<div class="proj" data-id="' + p.id + '"><div class="ph"><div class="pn">' + esc(p.name) +
    '</div><div style="display:flex;align-items:center;gap:8px"><span class="pv">' + (+p.pct) + '%</span>' +
    '<button class="del" data-act="pdel" title="Remove">&times;</button></div></div><div class="bar"><i style="width:' + (+p.pct) +
    '%"></i></div><div class="prng"><input type="range" min="0" max="100" step="5" value="' + (+p.pct) + '" data-act="prng"></div></div>'
  ).join("") : '<div class="empty">No projects. Add one above.</div>';
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
    if (b.dataset.act === "del") TODOS = TODOS.filter((t) => t.id !== id);
    else if (b.dataset.act === "chk") { const t = TODOS.find((x) => x.id === id); if (t) t.done = !t.done; }
    persistTodos(); renderTodos();
  });
  $("#p-add").onclick = () => {
    const nm = $("#p-name").value.trim(); if (!nm) return;
    PROJS.push({ id: "p" + Date.now(), name: nm, pct: 0 }); $("#p-name").value = ""; persistProjs(); renderProjs();
  };
  $("#p-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#p-add").click(); });
  $("#projs").addEventListener("input", (e) => {
    if (e.target.dataset.act === "prng") { const id = e.target.closest(".proj").dataset.id; const p = PROJS.find((x) => x.id === id); if (p) { p.pct = +e.target.value; persistProjs(); renderProjs(); } }
  });
  $("#projs").addEventListener("click", (e) => {
    if (e.target.dataset.act === "pdel") { const id = e.target.closest(".proj").dataset.id; PROJS = PROJS.filter((x) => x.id !== id); persistProjs(); renderProjs(); }
  });
  boot();
});
