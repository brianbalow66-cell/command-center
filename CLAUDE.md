# Command Center — project guide for Claude

Personal real-time dashboard for Brian (brianbalow66@gmail.com). Live at https://command-center-app-15l.pages.dev. Sign-in is Google OAuth; only the allowed account can get in.

## This repo is the source of truth

- Cloudflare Pages (project `command-center-app`, advanced mode) builds from this repo's `main` branch. Every push to `main` deploys in about 1–2 minutes. There is no build step; the files are served as-is.
- Any other copy of these files on a computer (OneDrive folders, `Downloads\cc-src`, zip files) is stale. Always work from a fresh clone or `git pull` first.
- Files use CRLF line endings. Keep them that way so diffs stay small.
- Everything in the repo is served publicly as a static asset (including this file). Never commit secrets; they live in Cloudflare Pages environment variables.

## Files

- `_worker.js` — the whole backend (Cloudflare Worker): Google OAuth, session in KV, and the `/api/*` routes.
- `index.html` — login gate + dashboard layout. `app.js` — all front-end logic. `styles.css` — dark theme (near-black, white text, green accent).
- `manifest.webmanifest`, `icon.svg` — PWA bits.

## What the dashboard shows

- Opelius Leads band, Markets (9 tiles, Yahoo Finance with Stooq fallback, cached hourly in KV), SpaceX tracker, Rental (855 Golden Bear, from Gmail + manual portal numbers), Daily Briefing (published each morning by a scheduled task, 30-day archive).
- Upcoming (calendar): primary Google Calendar for the next 2 months, plus any iCal feeds in config. Events can be added, edited and deleted from the dashboard ("+ new", ✎, ×). Feed events (e.g. Planning Center church schedule, label "church") are read-only.
- Inbox: recent Gmail with "draft ready" badges. To-Do & Reminders and Projects: stored in KV per user.

## Backend facts that matter

- Google scopes: `openid email calendar.events gmail.modify`. The OAuth app is published ("In production") in Google Cloud project 651430261017; it is unverified, so Google shows an "unverified app" warning once per new device at sign-in (Advanced → Go to command-center-app-15l.pages.dev).
- Login always uses `prompt=consent`, so a fresh refresh token is issued at every sign-in and stored in KV (`google:refresh`, `google:refresh_email`). If a session's own refresh token dies, `freshToken` falls back to that shared one, so one sign-in on any device repairs the others.
- `/api/*` returns `401 {error:"token_expired"}` when Google is disconnected. The front end then shows a "Reconnect Google" prompt and re-runs sign-in once (at most every 30 minutes).
- Calendar routes: `GET /api/calendar`; `POST /api/calendar/events`; `PATCH|DELETE /api/calendar/events/<id>`. Bodies: `{summary,location,description,allDay,start,end,timeZone}`; all-day dates are inclusive, the worker converts to Google's exclusive end date.
- iCal feeds: `config:dashboard.icsFeeds = [{name,url}]` (set via `PUT /api/config`, or the "+ feed" control in the Upcoming header). The worker fetches each feed (15-minute KV cache), parses VEVENTs (TZID, UTC, all-day, folded lines), drops cancelled ones, and merges them into `/api/calendar` with `source` and `readOnly: true`.
- KV namespace `command-center` is bound as `KV`. Env vars: `ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STOCK_SYMBOLS`, optional `NTFY_TOKEN`.

## Working on it

- Test locally by serving the four static files with a tiny mock of the `/api` routes; the real worker needs Cloudflare + Google and is not runnable offline.
- On Brian's PC there is no `gh`; push with `git -c credential.helper= -c credential.helper=manager push origin main` (the system gitconfig uses a helper selector that otherwise pops a dialog).
- After changing anything Google-related, verify by reloading the live site; the first add/edit/delete on a device may need the one-time "Grant access" consent.
