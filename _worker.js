/**
 * cc-notifier - Cloudflare Worker (CRON), 24/7, independent of any device.
 *
 *  Runs three things on a schedule:
 *   1. Phone reminders via ntfy (to-do / project task due times).
 *   2. Daily Briefing - generated each morning via the Anthropic API (Claude + web search),
 *      written to the same KV the dashboard reads, archiving the prior day, then a phone push.
 *   3. Email reply drafts - each morning it reads the inbox, asks Claude which emails warrant
 *      a reply, writes Gmail drafts (it CANNOT send), flags them on the dashboard, then a push.
 *
 *  Because this runs on Cloudflare's network, all of it works even when your computer
 *  and the Claude desktop app are closed.
 *
 * Setup (Cloudflare dashboard -> Workers & Pages -> cc-notifier):
 *   1. Settings -> Bindings -> KV namespace: Variable name "KV" -> "command-center".
 *   2. Settings -> Variables and Secrets (all type Secret):
 *        NTFY_TOKEN          = your ntfy access token            (already set)
 *        ANTHROPIC_API_KEY   = key from console.anthropic.com    (already set)
 *        GOOGLE_CLIENT_ID    = same value as the dashboard app   (NEW)
 *        GOOGLE_CLIENT_SECRET= same value as the dashboard app   (NEW)
 *   3. Settings -> Triggers -> Cron Triggers -> run every 5 minutes (cron: 0/5 * * * *).
 *   4. Deploy.
 *
 * Test after deploy:
 *   reminders : https://cc-notifier.<sub>.workers.dev/?run=1
 *   briefing  : https://cc-notifier.<sub>.workers.dev/?brief=1
 *   drafts    : https://cc-notifier.<sub>.workers.dev/?drafts=1
 */

const OWNER_EMAIL = "brianbalow66@gmail.com";
const DASH_URL = "https://command-center-app-15l.pages.dev/";
const MODEL = "claude-sonnet-4-6";

const BRIEFING_SYS = [
  'You are the research engine for a personal dashboard "Daily Briefing". Using web search, compile the genuinely latest developments, then output ONLY a single JSON object - no prose, no markdown, no code fences, nothing before or after the JSON.',
  "",
  "Schema (use EXACTLY these 7 section titles, in this order):",
  '{"updated":"<ISO8601>","sections":[',
  ' {"title":"Markets","items":[{"t":"one concise sentence","u":"source URL or empty string"}]},',
  ' {"title":"Crypto","items":[]},',
  ' {"title":"Business & World","items":[]},',
  ' {"title":"AI & Tech","items":[]},',
  ' {"title":"EMS Industry","items":[]},',
  ' {"title":"EMS Software","items":[]},',
  ' {"title":"College Football","items":[]}',
  "]}",
  "",
  "Rules:",
  "- 2 to 4 information-dense, one-sentence items per section. Each item is an object with keys t (text) and u (source URL).",
  "- Always include a REAL source URL in u from your web search results. Never invent a URL; if you truly have none, use an empty string.",
  "- Time window: last ~24 hours for Markets, Crypto, Business & World, and AI & Tech. Last ~5 days for EMS Industry, EMS Software, and College Football (these move slowly).",
  "- For EMS Industry / EMS Software, search vendors like ImageTrend, ESO, MP Cloud, Traumasoft, NEMSIS, and general prehospital/EMS news.",
  "- DEDUPE: the user message contains yesterday's briefing JSON. Do NOT repeat any item that already appeared there. Only include things genuinely new since then.",
  '- HONESTY ON SLOW NEWS: if a section has nothing genuinely new versus yesterday, make its FIRST item text exactly "No major new developments in the past 24h." and optionally add ONE more item beginning "Most recent (Mon DD): ..." citing the latest known item with its date. Do not pad with recycled bullets.',
  "- Prefix older/dated items in the text with the date (e.g. (Jun 14) ...) so the reader can judge freshness.",
  "Output the JSON object and nothing else.",
].join("\n");

async function ntfyPush(env, topic, payload) {
  const headers = {};
  if (env.NTFY_TOKEN) headers["Authorization"] = "Bearer " + env.NTFY_TOKEN;
  if (payload.title) headers["Title"] = payload.title;
  if (payload.tags) headers["Tags"] = payload.tags;
  if (payload.priority) headers["Priority"] = String(payload.priority);
  if (payload.click) headers["Click"] = payload.click;
  try {
    await fetch("https://ntfy.sh/" + encodeURIComponent(topic), { method: "POST", headers, body: payload.message || "" });
  } catch (e) {}
}

// ---------- Reminders ----------
async function checkAndPush(env) {
  let topic = "";
  try { topic = (await env.KV.get("ntfy:topic")) || ""; } catch (e) {}
  if (!topic) return { ok: false, error: "no_topic" };
  const now = Date.now();
  let last = now - 30 * 60 * 1000;
  try { const l = await env.KV.get("ntfy:lastcheck"); if (l) last = parseInt(l, 10); } catch (e) {}
  const due = [];
  const consider = (items, label) => {
    (items || []).forEach((t) => {
      if (t && t.when && !t.done) {
        const w = new Date(t.when).getTime();
        if (!isNaN(w) && w > last && w <= now) due.push({ text: t.text, assignee: t.assignee || "", label });
      }
    });
  };
  try { const td = await env.KV.get("data:" + OWNER_EMAIL + ":todos"); if (td) consider(JSON.parse(td), "To-Do"); } catch (e) {}
  try { const pr = await env.KV.get("data:" + OWNER_EMAIL + ":projects"); if (pr) JSON.parse(pr).forEach((p) => consider(p.tasks, p.name)); } catch (e) {}
  for (const d of due) {
    await ntfyPush(env, topic, { title: "Reminder: " + (d.label || ""), message: d.text + (d.assignee ? " - " + d.assignee : ""), tags: "alarm_clock", click: DASH_URL });
  }
  await env.KV.put("ntfy:lastcheck", String(now));
  return { ok: true, pushed: due.length };
}

// ---------- Daily briefing ----------
async function runBriefing(env) {
  if (!env.ANTHROPIC_API_KEY) return { error: "no_api_key" };
  let prevRaw = "";
  try { prevRaw = (await env.KV.get("research:latest")) || ""; } catch (e) {}
  const user = "Yesterday's briefing JSON (do NOT repeat any of its items):\n" + (prevRaw || "(none)") + "\n\nResearch now and output today's briefing JSON.";
  let data;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        system: BRIEFING_SYS,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
        messages: [{ role: "user", content: user }],
      }),
    });
    data = await resp.json();
  } catch (e) {
    return { error: "fetch_failed" };
  }
  if (!data || data.error) return { error: "api_error", detail: data && data.error };
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i < 0 || j < 0) return { error: "no_json", sample: text.slice(0, 300) };
  let briefing;
  try { briefing = JSON.parse(text.slice(i, j + 1)); } catch (e) { return { error: "parse_failed", sample: text.slice(i, i + 300) }; }
  if (!briefing || !Array.isArray(briefing.sections) || !briefing.sections.length) return { error: "bad_shape" };
  briefing.updated = new Date().toISOString();
  try {
    if (prevRaw) {
      const pj = JSON.parse(prevRaw);
      let arr = [];
      try { const a = await env.KV.get("research:archive"); if (a) arr = JSON.parse(a); } catch (e) {}
      if (!arr.length || arr[0].updated !== pj.updated) arr.unshift(pj);
      arr = arr.slice(0, 30);
      await env.KV.put("research:archive", JSON.stringify(arr));
    }
  } catch (e) {}
  await env.KV.put("research:latest", JSON.stringify(briefing));
  try {
    const topic = (await env.KV.get("ntfy:topic")) || "";
    if (topic) await ntfyPush(env, topic, { title: "Daily briefing ready", message: "Your Command Center briefing refreshed.", tags: "newspaper", click: DASH_URL });
  } catch (e) {}
  return { ok: true, sections: briefing.sections.length };
}

async function maybeDailyBriefing(env) {
  try {
    const now = new Date();
    if (now.getUTCHours() < 11) return { skipped: "before window" };
    const today = now.toISOString().slice(0, 10);
    let lr = "";
    try { lr = (await env.KV.get("briefing:lastrun")) || ""; } catch (e) {}
    if (lr === today) return { skipped: "already ran today" };
    await env.KV.put("briefing:lastrun", today);
    return await runBriefing(env);
  } catch (e) {
    return { error: String(e) };
  }
}

// ---------- Email reply drafts ----------
async function googleToken(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  let rt = "";
  try { rt = (await env.KV.get("google:refresh")) || ""; } catch (e) {}
  if (!rt) return null;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: rt }),
    });
    if (!r.ok) return null;
    const t = await r.json();
    return t.access_token || null;
  } catch (e) {
    return null;
  }
}

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function emailAddr(from) {
  const m = /<([^>]+)>/.exec(from || "");
  return m ? m[1] : (from || "").trim();
}

function gfetch(url, token, opts) {
  const o = opts || {};
  const h = Object.assign({ authorization: "Bearer " + token }, o.headers || {});
  return fetch(url, Object.assign({}, o, { headers: h }));
}

async function runEmailDrafts(env) {
  if (!env.ANTHROPIC_API_KEY) return { error: "no_api_key" };
  const token = await googleToken(env);
  if (!token) return { error: "no_google_token - sign out/in on the dashboard and confirm GOOGLE_CLIENT_ID/SECRET secrets" };
  let list;
  try {
    const q = encodeURIComponent("in:inbox -in:chats newer_than:7d");
    list = await gfetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?q=" + q + "&maxResults=15", token).then((r) => r.json());
  } catch (e) {
    return { error: "list_failed" };
  }
  const ids = (list.messages || []).map((m) => m.id);
  if (!ids.length) return { ok: true, drafts: 0, note: "inbox empty" };
  const drafted = new Set();
  try {
    const dl = await gfetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=100", token).then((r) => r.json());
    (dl.drafts || []).forEach((d) => { if (d.message && d.message.threadId) drafted.add(d.message.threadId); });
  } catch (e) {}
  const metas = await Promise.all(ids.map((id) => {
    const u = "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID";
    return gfetch(u, token).then((r) => r.json()).catch(() => null);
  }));
  const emails = [];
  metas.forEach((m) => {
    if (!m || !m.payload) return;
    if (drafted.has(m.threadId)) return;
    const hs = {};
    (m.payload.headers || []).forEach((h) => { hs[h.name.toLowerCase()] = h.value; });
    emails.push({ id: m.id, threadId: m.threadId, from: hs.from || "", subject: hs.subject || "(no subject)", messageId: hs["message-id"] || "", snippet: m.snippet || "" });
  });
  if (!emails.length) return { ok: true, drafts: 0, note: "nothing new to draft" };
  const sys = [
    "You are an executive assistant triaging Brian's inbox. For each email decide if it genuinely warrants a personal reply from Brian.",
    "Skip newsletters, promotions, receipts, automated/no-reply notifications, and anything that needs no response.",
    "For those that do warrant a reply, write a concise, professional reply in Brian's first-person voice - courteous and to the point, ending with a line: Best, Brian.",
    'Output ONLY JSON of the form {"drafts":[{"i":0,"body":"reply text"}]}, including only emails that warrant a reply. If none qualify, output {"drafts":[]}.',
  ].join(" ");
  const listText = emails.map((e, idx) => "[" + idx + "] From: " + e.from + "\nSubject: " + e.subject + "\nPreview: " + e.snippet).join("\n\n");
  let data;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2500, system: sys, messages: [{ role: "user", content: "Emails:\n\n" + listText + "\n\nReturn the JSON now." }] }),
    });
    data = await resp.json();
  } catch (e) {
    return { error: "anthropic_failed" };
  }
  if (!data || data.error) return { error: "anthropic_error", detail: data && data.error };
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const i0 = text.indexOf("{");
  const j0 = text.lastIndexOf("}");
  if (i0 < 0 || j0 < 0) return { error: "no_json", sample: text.slice(0, 200) };
  let parsed;
  try { parsed = JSON.parse(text.slice(i0, j0 + 1)); } catch (e) { return { error: "parse_failed", sample: text.slice(0, 200) }; }
  const wanted = (parsed && parsed.drafts) || [];
  const items = [];
  let created = 0;
  for (const w of wanted) {
    const e = emails[w.i];
    if (!e || !w.body) continue;
    let subj = e.subject || "";
    if (!/^re:/i.test(subj)) subj = "Re: " + subj;
    const lines = ["To: " + emailAddr(e.from), "Subject: " + subj];
    if (e.messageId) { lines.push("In-Reply-To: " + e.messageId); lines.push("References: " + e.messageId); }
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push("MIME-Version: 1.0");
    const raw = b64url(lines.join("\r\n") + "\r\n\r\n" + w.body);
    try {
      const cr = await gfetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { threadId: e.threadId, raw: raw } }),
      });
      if (cr.ok) { created++; items.push({ threadId: e.threadId, subject: e.subject, summary: w.body.slice(0, 120) }); }
    } catch (e2) {}
  }
  await env.KV.put("drafts:latest", JSON.stringify({ updated: new Date().toISOString(), items: items }));
  try {
    const topic = (await env.KV.get("ntfy:topic")) || "";
    if (topic && created > 0) await ntfyPush(env, topic, { title: created + " reply draft(s) ready", message: "Review in Gmail or on your dashboard.", tags: "email", click: DASH_URL });
  } catch (e) {}
  return { ok: true, considered: emails.length, drafts: created };
}

async function maybeDailyDrafts(env) {
  try {
    const now = new Date();
    const h = now.getUTCHours();
    const mi = now.getUTCMinutes();
    if (h < 10 || (h === 10 && mi < 45)) return { skipped: "before window" };
    const today = now.toISOString().slice(0, 10);
    let lr = "";
    try { lr = (await env.KV.get("drafts:lastrun")) || ""; } catch (e) {}
    if (lr === today) return { skipped: "already ran today" };
    await env.KV.put("drafts:lastrun", today);
    return await runEmailDrafts(env);
  } catch (e) {
    return { error: String(e) };
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([checkAndPush(env), maybeDailyBriefing(env), maybeDailyDrafts(env)]));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("run") === "1") {
      const r = await checkAndPush(env);
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    }
    if (url.searchParams.get("brief") === "1") {
      const r = await runBriefing(env);
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    }
    if (url.searchParams.get("drafts") === "1") {
      const r = await runEmailDrafts(env);
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    }
    return new Response("cc-notifier alive");
  },
};
