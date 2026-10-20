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

  loadMarket(); loadCalendar(); loadMail(); loadResearch(); loadTracker(); loadRental(); loadLeads(); resumePendingEvent();
  // auto-refresh live data (markets refresh hourly server-side; poll every 15 min to pick up updates)
  // markets only auto-refresh between 8am and 10pm local time
  setInterval(function(){ var h = new Date().getHours(); if (h >= 8 && h < 22) loadMarket(); }, 15 * 60000);
  setInterval(loadCalendar, 5 * 60000);
  setInterval(loadMail, 3 * 60000);
  setInterval(loadResearch, 10 * 60000);
  setInterval(loadTracker, 5 * 60000);
  setInterval(loadRental, 30 * 60000);
  setInterval(loadLeads, 5 * 60000);
}

/* ---------- Opelius website leads ---------- */
const LEAD_STAGES = ["New", "Contacted", "Audit booked", "Proposal sent", "Won", "Lost"];
const LEAD_STAGE_CLS = { "New": "st-new", "Contacted": "st-contacted", "Audit booked": "st-audit", "Proposal sent": "st-proposal", "Won": "st-won", "Lost": "st-lost" };
let LEADS = [], LEADS_OPEN = {}, LEADS_SHOW_CLEARED = false;

async function loadLeads() {
  const card = $("#leads-card"); if (!card) return;
  try {
    const d = await api("/api/leads").then((r) => r.json());
    LEADS = (d && Array.isArray(d.leads)) ? d.leads : [];
    renderLeads();
  } catch (e) { card.hidden = true; }
}
function leadMeta(l) { return l.meta || {}; }
function setLeadMeta(id, patch) {
  const l = LEADS.find((x) => x.id === id);
  if (l) l.meta = Object.assign({}, l.meta || {}, patch);
  api("/api/leads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, patch }) });
}
function renderLeads() {
  const card = $("#leads-card"), el = $("#leads");
  if (!LEADS.length) { card.hidden = true; return; }
  const visible = LEADS.filter((l) => LEADS_SHOW_CLEARED || !leadMeta(l).d);
  const dayMs = 86400000, now = Date.now();
  let fresh = 0;
  const rows = visible.slice(0, LEADS_SHOW_CLEARED ? 30 : 10).map((l) => {
    const m = leadMeta(l), stage = m.s || "New";
    const t = new Date(l.time);
    const isNew = !isNaN(t) && (now - t.getTime()) < dayMs && stage === "New" && !m.d;
    if (isNew) fresh++;
    const when = isNaN(t) ? esc(l.time) : t.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const open = !!LEADS_OPEN[l.id];
    const stIdx = LEAD_STAGES.indexOf(stage);
    const segs = [0, 1, 2, 3].map((i) => '<i class="' + (stage !== "Lost" && stIdx >= i ? "on" : "") + '"></i>').join("");
    let h = '<div class="lead-row' + (isNew ? " lead-new" : "") + (m.d ? " lead-cleared" : "") + '" data-id="' + esc(l.id) + '">' +
      '<div class="lead-line">' +
      '<div class="lead-when">' + when + (isNew ? '<span class="lead-badge-new">NEW</span>' : "") + '</div>' +
      '<div class="lead-main"><b>' + esc(l.name || "(no name)") + '</b>' + (l.business ? " &middot; " + esc(l.business) : "") +
      (open ? "" : '<div class="lead-sub">' + esc(l.contact || "") + (l.summary ? " &mdash; " + esc(l.summary) : "") + "</div>") + "</div>" +
      '<div class="lead-right"><span class="lead-stage ' + (LEAD_STAGE_CLS[stage] || "") + '">' + esc(stage) + '</span>' +
      '<span class="lead-prog" title="' + esc(stage) + '">' + segs + '</span>' +
      '<span class="lead-src">' + esc(l.source || "") + '</span>' +
      '<button class="lead-x" title="Clear this lead" data-x="' + esc(l.id) + '">&times;</button></div></div>';
    if (open) {
      const c = l.contact || "";
      const isEmail = /@/.test(c), isPhone = /^[\d\s().+-]{7,}$/.test(c);
      const clink = isEmail ? ('<a href="mailto:' + esc(c) + '">' + esc(c) + "</a>")
        : (isPhone ? ('<a href="tel:' + esc(c.replace(/[^\d+]/g, "")) + '">' + esc(c) + "</a>") : esc(c));
      const gmail = "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(c) +
        "&su=" + encodeURIComponent("Re: your Opelius inquiry");
      let det = '<div class="lead-details">';
      det += '<div class="ld-row"><span>Contact</span><div>' + (clink || '<span class="muted">none</span>') + "</div></div>";
      if (l.summary) det += '<div class="ld-row"><span>Summary</span><div>' + esc(l.summary) + "</div></div>";
      const f = l.fields || {};
      Object.keys(f).forEach((k) => { if (f[k]) det += '<div class="ld-row"><span>' + esc(k) + "</span><div>" + esc(f[k]) + "</div></div>"; });
      det += '<div class="ld-row"><span>Note</span><div>' + (m.n ? esc(m.n) : '<span class="muted">none</span>') +
        ' <span class="trk-edit" data-note="' + esc(l.id) + '">&#9998; edit</span></div></div>';
      det += '<div class="ld-actions"><label class="muted" style="font-size:11px">Stage</label>' +
        '<select class="lead-sel" data-stage="' + esc(l.id) + '">' +
        LEAD_STAGES.map((s) => "<option" + (s === stage ? " selected" : "") + ">" + s + "</option>").join("") + "</select>" +
        (isEmail ? '<a class="btn ghost lead-reply" href="' + gmail + '" target="_blank" rel="noopener">Reply &#9993;</a>' : "") +
        (m.d ? '<button class="btn ghost" data-restore="' + esc(l.id) + '">Restore</button>' : "") +
        "</div></div>";
      h += det;
    }
    return h + "</div>";
  }).join("");
  el.innerHTML = rows || '<div class="muted" style="padding:8px 4px">No active leads &mdash; all cleared. &#127881;</div>';
  $("#leads-status").textContent = fresh ? (fresh + " new in last 24h") : (visible.length ? visible.length + " active" : "");
  const tog = $("#leads-toggle");
  if (tog) { tog.textContent = LEADS_SHOW_CLEARED ? "hide cleared" : "show cleared"; tog.onclick = function (e) { e.preventDefault(); LEADS_SHOW_CLEARED = !LEADS_SHOW_CLEARED; renderLeads(); }; }
  const clr = $("#leads-clear"); if (clr) clr.onclick = clearAllLeads;
  el.querySelectorAll(".lead-row").forEach((r) => r.addEventListener("click", function (ev) {
    if (ev.target.closest("a,select,button,[data-note]")) return;
    const id = r.getAttribute("data-id"); LEADS_OPEN[id] = !LEADS_OPEN[id]; renderLeads();
  }));
  el.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", function (ev) {
    ev.stopPropagation(); setLeadMeta(b.getAttribute("data-x"), { d: true }); renderLeads();
  }));
  el.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", function (ev) {
    ev.stopPropagation(); setLeadMeta(b.getAttribute("data-restore"), { d: false }); renderLeads();
  }));
  el.querySelectorAll("[data-stage]").forEach((s) => s.addEventListener("change", function () {
    setLeadMeta(s.getAttribute("data-stage"), { s: s.value }); renderLeads();
  }));
  el.querySelectorAll("[data-note]").forEach((b) => b.addEventListener("click", function (ev) {
    ev.stopPropagation();
    const id = b.getAttribute("data-note");
    const l = LEADS.find((x) => x.id === id);
    const v = prompt("Note for this lead:", (l && l.meta && l.meta.n) || "");
    if (v === null) return;
    setLeadMeta(id, { n: v }); renderLeads();
  }));
  card.hidden = false;
  if (fresh) document.title = "🔔 " + fresh + " lead" + (fresh > 1 ? "s" : "") + " · Command Center";
}
function clearAllLeads(e) {
  if (e) e.preventDefault();
  if (!confirm("Clear all leads from the dashboard? They remain in email, Gmail, and the site backup.")) return;
  const ids = LEADS.filter((l) => !leadMeta(l).d).map((l) => l.id);
  ids.forEach((id) => { const l = LEADS.find((x) => x.id === id); if (l) l.meta = Object.assign({}, l.meta || {}, { d: true }); });
  api("/api/leads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dismissAll: ids }) });
  renderLeads();
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

/* ---------- Google connection state ---------- */
// The worker answers 401 {error:"token_expired"} when Google's refresh token is dead (sign-in revoked, token aged out).
// Show a reconnect prompt in the Google-backed panels and send the user through sign-in once (not more than every 30 min).
let GOOGLE_DEAD = false;
function googleDead(r, d) { return r.status === 401 || (d && (d.error === "token_expired" || d.error === "unauthorized")); }
function reconnectHtml(what) { return '<div class="reconnect"><div>Google ' + what + ' is disconnected.</div><a class="btn ghost" href="/auth/login">Reconnect Google</a></div>'; }
function handleGoogleDead(panelEl, statusEl, what) {
  if (panelEl) panelEl.innerHTML = reconnectHtml(what);
  if (statusEl) statusEl.textContent = "disconnected";
  if (GOOGLE_DEAD) return; GOOGLE_DEAD = true;
  let last = 0; try { last = +sessionStorage.getItem("cc_reauth_at") || 0; } catch (e) {}
  if (Date.now() - last > 30 * 60000) { try { sessionStorage.setItem("cc_reauth_at", String(Date.now())); } catch (e) {} location.href = "/auth/login"; }
}

/* ---------- calendar ---------- */
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
let EVENTS = []; // last loaded events (for edit prefill)
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; } })();
// Google "date" (all-day) values are calendar dates, not instants — parse as local midnight so the day never shifts.
function evStart(e) { if (e.start && e.start.dateTime) return new Date(e.start.dateTime); if (e.start && e.start.date) return new Date(e.start.date + "T00:00:00"); return null; }
async function loadCalendar() {
  const el = $("#cal");
  try {
    const r = await api("/api/calendar"); const d = await r.json();
    if (googleDead(r, d)) { handleGoogleDead(el, $("#cal-status"), "Calendar"); return; }
    const evs = (d.events || []).filter((e) => e.status !== "cancelled");
    EVENTS = evs;
    $("#cal-status").textContent = evs.length + " events";
    if (!evs.length) { el.innerHTML = '<div class="empty">Nothing scheduled. Enjoy the calm.</div>'; return; }
    el.innerHTML = evs.map((e) => {
      const allDay = !!(e.start && e.start.date && !e.start.dateTime);
      const dt = evStart(e);
      const time = allDay ? "All day" : (dt ? dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
      const wd = dt ? dt.toLocaleDateString("en-US", { weekday: "short" }) : "";
      const loc = e.location ? " &middot; " + esc(e.location.length > 40 ? e.location.slice(0, 40) + "…" : e.location) : "";
      const tag = e.eventType === "fromGmail" ? '<span class="pill">gmail</span>' : (e.recurringEventId ? '<span class="pill">repeats</span>' : "");
      const tools = e.id ? '<div class="evtools"><button class="evbtn" data-act="evedit" title="Edit event">&#9998;</button><button class="evbtn evdel" data-act="evdel" title="Delete event">&times;</button></div>' : "";
      return '<div class="ev" data-id="' + esc(e.id || "") + '"><div class="day"><div class="d">' + (dt ? dt.getDate() : "") + '</div><div class="m">' +
        (dt ? MON[dt.getMonth()] : "") + '</div></div><div class="body"><div class="ti">' +
        esc(e.summary) + tag + '</div><div class="mt">' + wd + " &middot; " + esc(time) + loc + "</div></div>" + tools + "</div>";
    }).join("");
  } catch (err) { el.innerHTML = '<div class="err">Calendar unavailable.</div>'; }
}
/* --- add / edit / delete (writes go to Google Calendar through the worker) --- */
const p2 = (n) => String(n).padStart(2, "0");
const localD = (d) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
const localT = (d) => p2(d.getHours()) + ":" + p2(d.getMinutes());
const fmtT = (hhmm) => { const h = +hhmm.slice(0, 2), m = hhmm.slice(3, 5); const ap = h < 12 ? "AM" : "PM"; return ((h % 12) || 12) + ":" + m + " " + ap; };
const tMin = (hhmm) => (+hhmm.slice(0, 2)) * 60 + (+hhmm.slice(3, 5));
const minT = (mins) => { mins = ((mins % 1440) + 1440) % 1440; return p2(Math.floor(mins / 60)) + ":" + p2(mins % 60); };
const PENDING_KEY = "cc_pending_event";
function buildTimeOptions(sel) {
  if (sel.options.length) return;
  for (let m = 0; m < 1440; m += 15) { const v = minT(m); const o = document.createElement("option"); o.value = v; o.textContent = fmtT(v); sel.appendChild(o); }
}
function setTime(sel, hhmm) { // selects hhmm, adding it as an option if it is not on a 15-minute boundary
  buildTimeOptions(sel);
  if (![...sel.options].some((o) => o.value === hhmm)) {
    const o = document.createElement("option"); o.value = hhmm; o.textContent = fmtT(hhmm);
    const after = [...sel.options].find((x) => x.value > hhmm); sel.insertBefore(o, after || null);
  }
  sel.value = hhmm;
}
function evSetAllDay(on) {
  $("#ev-allday").checked = on;
  $("#ev-times").hidden = on;
  $("#ev-enddate-row").hidden = !on;
  if (on && (!$("#ev-enddate").value || $("#ev-enddate").value < $("#ev-date").value)) $("#ev-enddate").value = $("#ev-date").value;
}
// Fill the dialog from a plain body {summary,location,description,allDay,start,end} (start/end as the worker expects them).
function fillEventForm(b) {
  $("#ev-summary").value = b.summary || "";
  $("#ev-location").value = b.location || "";
  $("#ev-desc").value = b.description || "";
  const st = String(b.start || ""), en = String(b.end || "");
  $("#ev-date").value = st.slice(0, 10);
  if (b.allDay) {
    $("#ev-enddate").value = (en || st).slice(0, 10);
    setTime($("#ev-start-t"), "09:00"); setTime($("#ev-end-t"), "10:00");
  } else {
    const sT = st.slice(11, 16) || "09:00";
    let eT = en.slice(11, 16); if (!eT) eT = minT(tMin(sT) + 60);
    setTime($("#ev-start-t"), sT); setTime($("#ev-end-t"), eT);
    $("#ev-enddate").value = st.slice(0, 10);
  }
  evSetAllDay(!!b.allDay);
}
// Read the dialog back into a worker body. Times that end at or before the start roll over to the next day.
function readEventForm() {
  const allDay = $("#ev-allday").checked;
  const date = $("#ev-date").value;
  const b = { summary: $("#ev-summary").value.trim(), location: $("#ev-location").value.trim(), description: $("#ev-desc").value.trim(), allDay, timeZone: TZ };
  if (allDay) { b.start = date; b.end = $("#ev-enddate").value || date; }
  else {
    const sT = $("#ev-start-t").value, eT = $("#ev-end-t").value;
    let endDate = date;
    if (date && tMin(eT) <= tMin(sT)) { const x = new Date(date + "T00:00:00"); x.setDate(x.getDate() + 1); endDate = localD(x); }
    b.start = date ? date + "T" + sT : ""; b.end = endDate ? endDate + "T" + eT : "";
  }
  return b;
}
function openEventModal(e) {
  const m = $("#ev-modal"); if (!m) return;
  $("#ev-err").textContent = "";
  $("#ev-id").value = e && e.id ? e.id : "";
  $("#ev-title").textContent = e ? "Edit event" : "New event";
  if (e) {
    const allDay = !!(e.start && e.start.date && !e.start.dateTime);
    let b;
    if (allDay) {
      // Google all-day end dates are exclusive; show the inclusive last day.
      const s0 = new Date(e.start.date + "T00:00:00");
      const x = new Date((e.end && e.end.date ? e.end.date : e.start.date) + "T00:00:00"); x.setDate(x.getDate() - 1);
      b = { allDay: true, start: e.start.date, end: localD(x < s0 ? s0 : x) };
    } else {
      const s = new Date(e.start.dateTime), en = e.end && e.end.dateTime ? new Date(e.end.dateTime) : null;
      b = { allDay: false, start: localD(s) + "T" + localT(s), end: en ? localD(en) + "T" + localT(en) : "" };
    }
    b.summary = e.summary === "(no title)" ? "" : e.summary; b.location = e.location || ""; b.description = e.description || "";
    fillEventForm(b);
  } else {
    const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1);
    fillEventForm({ allDay: false, start: localD(s) + "T" + localT(s), end: "" });
  }
  const link = $("#ev-glink");
  if (link) { if (e && e.htmlLink) { link.href = e.htmlLink; link.hidden = false; } else link.hidden = true; }
  m.hidden = false;
  setTimeout(() => $("#ev-summary").focus(), 30);
}
function closeEventModal() { const m = $("#ev-modal"); if (m) m.hidden = true; }
function validateEventBody(b) {
  if (!b.summary) return { msg: "Give the event a title.", focus: "#ev-summary" };
  if (!b.start) return { msg: "Pick a date.", focus: "#ev-date" };
  if (b.allDay && b.end && b.end < b.start) return { msg: "Last day can't be before the first day.", focus: "#ev-enddate" };
  return null;
}
async function saveEvent() {
  const btn = $("#ev-save"); const errEl = $("#ev-err"); errEl.textContent = "";
  const id = $("#ev-id").value;
  const body = readEventForm();
  const bad = validateEventBody(body); if (bad) { errEl.textContent = bad.msg; $(bad.focus).focus(); return; }
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const r = await api(id ? "/api/calendar/events/" + encodeURIComponent(id) : "/api/calendar/events", { method: id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      if (r.status === 403 && j.error === "needs_consent") {
        // Remember what was typed, send the user through Google's one-time consent, and finish the save when they come back.
        lset(PENDING_KEY, { id, body });
        errEl.innerHTML = 'Google needs one-time permission to edit your calendar. <a href="/auth/login">Grant access</a> — your event is saved here and will be added when you return.';
      } else if (r.status === 401) errEl.innerHTML = 'Signed out — <a href="/auth/login">sign in again</a>.';
      else errEl.textContent = "Could not save: " + (j.error || r.status);
      return;
    }
    closeEventModal(); loadCalendar();
  } catch (e) { errEl.textContent = "Could not save — check your connection."; }
  finally { btn.disabled = false; btn.textContent = "Save"; }
}
// After the consent round-trip, submit the event that was waiting (or reopen the dialog with it if that fails).
async function resumePendingEvent() {
  const p = lget(PENDING_KEY); if (!p || !p.body) return;
  localStorage.removeItem(PENDING_KEY);
  try {
    const r = await api(p.id ? "/api/calendar/events/" + encodeURIComponent(p.id) : "/api/calendar/events", { method: p.id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p.body) });
    if (r.ok) { loadCalendar(); return; }
    let j = {}; try { j = await r.json(); } catch (e) {}
    openEventModal(null); $("#ev-id").value = p.id || ""; $("#ev-title").textContent = p.id ? "Edit event" : "New event"; fillEventForm(p.body);
    $("#ev-err").textContent = "Still couldn't save: " + (j.error || r.status) + ". Try again.";
  } catch (e) { openEventModal(null); fillEventForm(p.body); $("#ev-err").textContent = "Could not save — check your connection."; }
}
async function deleteEvent(id) {
  const e = EVENTS.find((x) => x.id === id); if (!e) return;
  const when = evStart(e);
  if (!confirm('Delete "' + e.summary + '"' + (when ? " on " + when.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "") + (e.recurringEventId ? " (this occurrence only)" : "") + " from Google Calendar?")) return;
  try {
    const r = await api("/api/calendar/events/" + encodeURIComponent(id), { method: "DELETE" });
    let j = {}; try { j = await r.json(); } catch (e2) {}
    if (!r.ok && r.status !== 404) {
      if (r.status === 403 && j.error === "needs_consent") { if (confirm("Google needs one-time permission to edit your calendar. Grant access now?")) location.href = "/auth/login"; return; }
      alert("Could not delete: " + (j.error || r.status)); return;
    }
    loadCalendar();
  } catch (e3) { alert("Could not delete — check your connection."); }
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
    const r = await api("/api/gmail"); const d = await r.json();
    if (googleDead(r, d)) { handleGoogleDead(el, $("#mail-status"), "Mail"); return; }
    const items = d.messages || [];
    const realDrafts = new Set(d.draftThreads || []);
    let unread = 0, dcount = 0;
    el.innerHTML = items.map((m) => {
      const labels = m.labelIds || [];
      const isUnread = labels.includes("UNREAD"); if (isUnread) unread++;
      const isImp = labels.includes("IMPORTANT");
      const snip = (m.snippet || "").replace(/[͏​‌‍­‎﻿\s]+/g, " ").trim();
      const draft = m.threadId && realDrafts.has(m.threadId) && DRAFTS[m.threadId];
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
async function loadResearch(){const el=$("#research");if(!el)return;try{const d=await api("/api/research").then(r=>r.json());await loadArchive();const _all=((d&&d.sections)||[]);const _tp=_all.find(s=>s&&s.title==="Top Priorities");const secs=_all.filter(s=>s&&s.title!=="Top Priorities");if(!secs.length){el.className="";el.innerHTML='<div class="empty">No briefing yet \u2014 it updates each morning.</div>';$("#research-status").textContent="";return;}$("#research-status").textContent=d.updated?("updated "+new Date(d.updated).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})):"";el.className="";el.innerHTML=(_tp?('<div style="border:2px solid var(--accent);border-radius:12px;background:rgba(59,102,245,0.10);padding:14px 18px 12px;margin-bottom:18px"><div style="font-weight:700;font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);margin-bottom:8px">&#11088; Top Priorities</div><ol style="margin:0;padding-left:22px;font-size:15px;line-height:1.7">'+((_tp.items)||[]).map(briefItem).join("")+'</ol></div>'):'')+'<div class="rcols">'+secs.map(s=>'<div class="rsec"><div class="rtitle">'+esc(s.title)+'<a class="rarch-link" href="#" data-cat="'+esc(s.title)+'">archive</a></div><ul class="rlist">'+((s.items)||[]).map(briefItem).join("")+'</ul><div class="rarch" data-cat="'+esc(s.title)+'" hidden></div></div>').join("")+'</div>';}catch(e){el.innerHTML='<div class="err">Briefing unavailable.</div>';}}
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

/* ---------- rental (Blue Gems via Gmail + portal) ---------- */
let RENTAL = {};
async function loadRental() {
  const card = $("#rental-card"); if (!card) return;
  const el = $("#rental");
  try {
    const d = await api("/api/rental").then((r) => r.json()); RENTAL = d;
    const fmtD = (s) => s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
    const lp = d.lastPayment;
    const payVal = (lp && lp.amount != null) ? ("$" + fmtNum(lp.amount)) : "—";
    const paySub = (lp && lp.date) ? ("on " + fmtD(lp.date)) : "";
    const ytd = d.ytdPayouts != null ? ("$" + fmtNum(d.ytdPayouts)) : "—";
    const st = d.lastStatement;
    const stVal = (st && st.period) ? esc(st.period) : "—";
    const stSub = (st && st.date) ? ("received " + fmtD(st.date)) : "";
    const up = d.lastUpdate;
    let upCell;
    if (up) { const url = "https://mail.google.com/mail/u/0/#all/" + encodeURIComponent(up.threadId || ""); upCell = '<div class="val" style="font-size:14px"><a href="' + url + '" target="_blank" rel="noopener">' + esc(up.subject || "Open") + ' ↗</a></div><div class="sub">' + fmtD(up.date) + '</div>'; }
    else upCell = '<div class="val" style="font-size:14px">—</div><div class="sub"></div>';
    const occVal = (d.occupancy != null) ? (d.occupancy + "%") : "—";
    const revVal = (d.revenue30d != null) ? ("$" + fmtNum(d.revenue30d)) : "—";
    const portalSub = d.asOf ? ("portal · " + fmtD(d.asOf)) : "tap edit to set";
    $("#rental-status").textContent = "Gmail + portal";
    el.innerHTML =
      '<div class="trk-cell"><div class="lab">Property</div><div class="val" style="font-size:15px">' + esc(d.property || "Rental") + '</div><div class="sub">Blue Gems · Guesty</div></div>' +
      '<div class="trk-cell"><div class="lab">Occupancy · 30d <span class="trk-edit" id="rent-edit">✎ edit</span></div><div class="val">' + occVal + '</div><div class="sub">' + portalSub + '</div></div>' +
      '<div class="trk-cell"><div class="lab">Owner revenue · 30d</div><div class="val">' + revVal + '</div><div class="sub">' + (d.asOf ? "from portal" : "—") + '</div></div>' +
      '<div class="trk-cell"><div class="lab">Last payout</div><div class="val">' + payVal + '</div><div class="sub">' + paySub + '</div></div>' +
      '<div class="trk-cell"><div class="lab">YTD payouts</div><div class="val">' + ytd + '</div><div class="sub">' + (d.paymentCount || 0) + ' payments</div></div>' +
      '<div class="trk-cell"><div class="lab">Latest statement</div><div class="val" style="font-size:14px">' + stVal + '</div><div class="sub">' + stSub + '</div></div>' +
      '<div class="trk-cell" style="flex:1.4"><div class="lab">Latest update</div>' + upCell + '</div>';
    const reb = $("#rent-edit"); if (reb) reb.onclick = editRental;
    card.hidden = false;
  } catch (e) { el.innerHTML = '<div class="err">Rental unavailable.</div>'; card.hidden = false; }
}
function editRental() {
  const occStr = prompt("Occupancy % over the past 30 days (from the Blue Gems portal):", RENTAL.occupancy != null ? RENTAL.occupancy : "");
  if (occStr === null) return;
  const occ = parseFloat(occStr);
  const revStr = prompt("Owner revenue, past 30 days (e.g. 3633.60):", RENTAL.revenue30d != null ? RENTAL.revenue30d : "");
  const rev = (revStr !== null && revStr.trim() !== "") ? parseFloat(revStr.replace(/[$,]/g, "")) : null;
  const body = { occupancy: isNaN(occ) ? null : occ, revenue30d: (rev != null && !isNaN(rev)) ? rev : null, asOf: new Date().toISOString() };
  api("/api/rental", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(() => loadRental());
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
    let due;
    if (t.due) { const dd = fmtDue(t.due); due = '<div class="rem due ' + (dd && dd.past && !t.done ? "past" : "") + '" data-act="due" title="Edit due date">&#128197; ' + esc(dd ? dd.lbl : t.due) + "</div>"; }
    else due = '<div class="rem due empty" data-act="due" title="Set a due date">&#128197; set due</div>';
    const chip = t.archived ? "" : statusChip(t.status);
    const archBtn = t.archived
      ? '<button class="arch" data-act="unarch" title="Restore to active">&#8617;</button>'
      : '<button class="arch" data-act="arch" title="Archive">&#128229;</button>';
    return '<div class="todo ' + (t.done ? "done " : "") + (t.archived ? "archived" : "") + '" data-id="' + t.id + '"><input type="checkbox" ' +
      (t.done ? "checked" : "") + ' data-act="chk"><div class="tx"><div class="tt">' + chip + esc(t.text) + "</div>" + rem + due +
      "</div>" + archBtn + '<button class="del" data-act="del" title="Delete">&times;</button></div>';
  }).join("");
}
// quick-reminder preset code -> datetime-local string (now + offset, 9am)
function presetWhen(code) {
  if (!code) return "";
  const d = new Date(); d.setHours(9, 0, 0, 0);
  if (code === "1d") d.setDate(d.getDate() + 1);
  else if (code === "1w") d.setDate(d.getDate() + 7);
  else if (code === "1m") d.setMonth(d.getMonth() + 1);
  else if (code === "6m") d.setMonth(d.getMonth() + 6);
  else if (code === "1y") d.setFullYear(d.getFullYear() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
}
// due date (YYYY-MM-DD) -> {lbl, past}
function fmtDue(s) {
  if (!s) return null;
  const dt = new Date(s + "T00:00:00"); if (isNaN(dt)) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return { lbl: "Due " + dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }), past: dt < today };
}
function addTodo() {
  const tx = $("#t-text").value.trim(); if (!tx) return;
  TODOS.push({ id: Date.now() + "" + Math.floor(Math.random() * 99), text: tx, when: $("#t-when").value || null, due: ($("#t-due") ? $("#t-due").value : "") || null, status: "active", done: false, archived: false, notified: false });
  $("#t-text").value = ""; $("#t-when").value = ""; if ($("#t-due")) $("#t-due").value = ""; persistTodos(); renderTodos();
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
function addProjTask(projId, projEl) {
  const tin = projEl.querySelector(".ptadd-in"); if (!tin) return;
  const tx = tin.value.trim(); if (!tx) return;
  const win = projEl.querySelector(".ptadd-who");
  const din = projEl.querySelector(".ptadd-when");
  const dueIn = projEl.querySelector(".ptadd-due");
  const p = PROJS.find((x) => x.id === projId); if (!p) return;
  if (!p.tasks) p.tasks = [];
  p.tasks.push({ id: "pt" + Date.now() + "" + Math.floor(Math.random() * 99), text: tx, status: "active", done: false, assignee: (win ? win.value.trim() : ""), when: (din && din.value) ? din.value : null, due: (dueIn && dueIn.value) ? dueIn.value : null, notified: false });
  tin.value = ""; if (win) win.value = ""; if (din) din.value = ""; if (dueIn) dueIn.value = ""; persistProjs(); renderProjs();
}
function renderProjs() {
  const el = $("#projs");
  $("#proj-avg").textContent = PROJS.length ? Math.round(PROJS.reduce((s, p) => s + (+p.pct || 0), 0) / PROJS.length) + "% avg" : "";
  el.innerHTML = PROJS.length ? PROJS.map((p) => {
    const tasks = p.tasks || [];
    const tasksHtml = tasks.length ? tasks.map((t) => {
      const who = t.assignee
        ? '<span class="pt-who" data-act="ptwho" title="Reassign">&#128100; ' + esc(t.assignee) + '</span>'
        : '<span class="pt-who empty" data-act="ptwho" title="Assign to a team member">+ assign</span>';
      let rem;
      if (t.when) { const r = fmtRem(t.when); rem = '<span class="pt-rem ' + (r.past && !t.done ? "past" : "") + '" data-act="ptwhen" title="Edit reminder">&#9200; ' + esc(r.lbl) + '</span>'; }
      else rem = '<span class="pt-rem empty" data-act="ptwhen" title="Add a reminder">&#9200; remind</span>';
      let pdue;
      if (t.due) { const dd = fmtDue(t.due); pdue = '<span class="pt-rem pt-due ' + (dd && dd.past && !t.done ? "past" : "") + '" data-act="ptdue" title="Edit due date">&#128197; ' + esc(dd ? dd.lbl : t.due) + '</span>'; }
      else pdue = '<span class="pt-rem pt-due empty" data-act="ptdue" title="Set a due date">&#128197; due</span>';
      return '<div class="ptask ' + (t.done ? "done" : "") + '" data-tid="' + t.id + '"><input type="checkbox" ' + (t.done ? "checked" : "") +
        ' data-act="ptchk">' + projStatusChip(t.status) + '<span class="ptt">' + esc(t.text) + '</span>' +
        who + rem + pdue + '<button class="del" data-act="ptdel" title="Delete task">&times;</button></div>';
    }).join("") : '<div class="ptask-empty">No tasks yet.</div>';
    return '<div class="proj" data-id="' + p.id + '"><div class="ph"><div class="pn">' + esc(p.name) +
      '</div><div style="display:flex;align-items:center;gap:8px"><span class="pv">' + (+p.pct) + '%</span>' +
      '<button class="del" data-act="pdel" title="Remove project">&times;</button></div></div>' +
      '<div class="bar"><i style="width:' + (+p.pct) + '%"></i></div>' +
      '<div class="prng"><input type="range" min="0" max="100" step="5" value="' + (+p.pct) + '" data-act="prng"></div>' +
      '<div class="ptasks">' + tasksHtml + '</div>' +
      '<div class="ptadd"><input type="text" class="ptadd-in" placeholder="Add task under ' + esc(p.name) + '…" maxlength="120">' +
      '<input type="text" class="ptadd-who" placeholder="Assignee" maxlength="40">' +
      '<input type="date" class="ptadd-due" title="Due date (optional)">' +
      '<select class="ptadd-remsel remsel" title="Quick reminder"><option value="">Remind…</option><option value="0">Today</option><option value="1d">Tomorrow</option><option value="1w">1 week</option><option value="1m">1 month</option><option value="6m">6 months</option><option value="1y">1 year</option></select>' +
      '<input type="datetime-local" class="ptadd-when" title="Reminder (optional)">' +
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
  let pchanged = false;
  PROJS.forEach((p) => { (p.tasks || []).forEach((t) => {
    if (t.when && !t.done && !t.notified && new Date(t.when).getTime() <= now) {
      t.notified = true; pchanged = true;
      if ("Notification" in window && Notification.permission === "granted") { try { new Notification("⏰ " + p.name, { body: t.text + (t.assignee ? " — " + t.assignee : "") }); } catch (e) {} }
    }
  }); });
  if (pchanged) { persistProjs(); renderProjs(); }
}

/* ---------- events ---------- */
document.addEventListener("DOMContentLoaded", () => {
  $("#t-add").onclick = addTodo;
  $("#t-text").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
  const tRemSel = $("#t-remsel");
  if (tRemSel) tRemSel.addEventListener("change", () => { const w = presetWhen(tRemSel.value); if (w) $("#t-when").value = w; tRemSel.value = ""; });
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
    else if (act === "due") { if (t) { const v = prompt("Due date (YYYY-MM-DD), leave blank to clear:", t.due || ""); if (v === null) return; t.due = (v.trim() || null); } }
    persistTodos(); renderTodos();
  });
  const calNew = $("#cal-new"); if (calNew) calNew.onclick = (e) => { e.preventDefault(); openEventModal(null); };
  $("#cal").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const row = b.closest(".ev"); const id = row && row.dataset.id; if (!id) return;
    if (b.dataset.act === "evedit") openEventModal(EVENTS.find((x) => x.id === id) || null);
    else if (b.dataset.act === "evdel") deleteEvent(id);
  });
  const evm = $("#ev-modal");
  if (evm) {
    buildTimeOptions($("#ev-start-t")); buildTimeOptions($("#ev-end-t"));
    $("#ev-save").onclick = saveEvent;
    $("#ev-cancel").onclick = closeEventModal;
    $("#ev-allday").addEventListener("change", () => evSetAllDay($("#ev-allday").checked));
    // keep the event's length when the start time moves (default one hour)
    let lastStart = null;
    $("#ev-start-t").addEventListener("focus", () => { lastStart = $("#ev-start-t").value; });
    $("#ev-start-t").addEventListener("change", () => {
      const s = $("#ev-start-t").value, e = $("#ev-end-t").value;
      let dur = (lastStart != null) ? tMin(e) - tMin(lastStart) : 60; if (dur <= 0) dur += 1440; if (dur <= 0 || dur > 1439) dur = 60;
      setTime($("#ev-end-t"), minT(tMin(s) + dur)); lastStart = s;
    });
    $("#ev-date").addEventListener("change", () => { if ($("#ev-allday").checked && (!$("#ev-enddate").value || $("#ev-enddate").value < $("#ev-date").value)) $("#ev-enddate").value = $("#ev-date").value; });
    evm.querySelectorAll(".chip[data-day]").forEach((c) => c.addEventListener("click", (e) => {
      e.preventDefault(); const d = new Date(); d.setDate(d.getDate() + (+c.dataset.day)); $("#ev-date").value = localD(d);
      if ($("#ev-allday").checked) $("#ev-enddate").value = localD(d);
    }));
    evm.addEventListener("click", (e) => { if (e.target === evm) closeEventModal(); });
    evm.addEventListener("keydown", (e) => { if (e.key === "Escape") closeEventModal(); if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON" && e.target.tagName !== "SELECT") { e.preventDefault(); saveEvent(); } });
  }
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
  $("#projs").addEventListener("change", (e) => {
    if (e.target.classList.contains("ptadd-remsel")) {
      const w = presetWhen(e.target.value); const row = e.target.closest(".ptadd");
      const win = row && row.querySelector(".ptadd-when"); if (w && win) win.value = w; e.target.value = "";
    }
  });
  $("#projs").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target.classList.contains("ptadd-in") || e.target.classList.contains("ptadd-who"))) { const projEl = e.target.closest(".proj"); if (projEl) addProjTask(projEl.dataset.id, projEl); }
  });
  $("#projs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); const projEl = e.target.closest(".proj"); if (!projEl) return;
    const pid = projEl.dataset.id; const p = PROJS.find((x) => x.id === pid);
    if (!b) return;
    const act = b.dataset.act;
    if (act === "pdel") { PROJS = PROJS.filter((x) => x.id !== pid); persistProjs(); renderProjs(); return; }
    if (act === "ptadd") { addProjTask(pid, projEl); return; }
    const taskEl = e.target.closest(".ptask");
    if (taskEl && p) {
      const tid = taskEl.dataset.tid; const t = (p.tasks || []).find((x) => x.id === tid);
      if (act === "ptchk") { if (t) t.done = !t.done; }
      else if (act === "ptstatus") { if (t) { const i = STATUSES.indexOf(t.status || "active"); t.status = STATUSES[(i + 1) % STATUSES.length]; } }
      else if (act === "ptdel") { p.tasks = (p.tasks || []).filter((x) => x.id !== tid); }
      else if (act === "ptwho") { if (t) { const v = prompt("Assign to (team member):", t.assignee || ""); if (v === null) return; t.assignee = v.trim(); } }
      else if (act === "ptwhen") { if (t) { const v = prompt("Reminder date/time (YYYY-MM-DDTHH:MM), leave blank to clear:", t.when || ""); if (v === null) return; t.when = (v.trim() || null); if (t.when) t.notified = false; } }
      else if (act === "ptdue") { if (t) { const v = prompt("Due date (YYYY-MM-DD), leave blank to clear:", t.due || ""); if (v === null) return; t.due = (v.trim() || null); } }
      else return;
      persistProjs(); renderProjs();
    }
  });
  boot();
});
