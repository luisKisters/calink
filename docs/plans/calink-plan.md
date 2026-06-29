# Calink — Plan

> Paste anything. Get a live calendar link.

**Status:** Draft v1 · **Date:** 2026-06-29 · **Stack decided:** Next.js + Convex (Google auth) + Anthropic (Claude)

---

## 1. The one-sentence product

Calink lets you build a calendar — by typing, pasting messy text, or just chatting — and hands you a **live subscribe link** that anyone can add to Apple/Google Calendar and that stays in sync forever. An **MCP server** lets your AI agent (Claude/Codex) manage your calendars directly.

This is the SLC bet: **Simple** (one screen, one link), **Lovable** (the "paste → it just becomes events" moment), **Complete** (the link actually works in every calendar app, recurring events and all).

---

## 2. The core loop (what every user does)

1. **Sign in** with Google.
2. **Create a calendar** (name, color, timezone).
3. **Add events** three ways, all editing the same calendar:
   - ✍️ **Visual editor** — click to add/edit, including recurring rules.
   - 📋 **Paste → events** — paste an email / syllabus / itinerary / screenshot text; AI extracts structured events; you review a diff and accept.
   - 💬 **Chat** — "move the dentist to next Tue 3pm and add a 30-min buffer before each standup"; AI proposes changes; you confirm.
4. **Copy the subscribe link** (`webcal://…/feed/<token>.ics`) and share it. Subscribers' calendars refresh automatically.
5. (Power users) **Connect the MCP server** so an agent can do full CRUD + create calendars.

---

## 3. The ownership / link model (resolved)

Two different access mechanisms, on purpose:

- **Editing = Google auth (via Convex Auth).** You own your calendars; they live in your account; you manage them from a dashboard. Chosen because you wanted Google sign-in and Convex gives it for ~free.
- **Subscribing = secret unguessable link.** Calendar apps subscribe over plain HTTP and **cannot do OAuth** — so the published `.ics` feed must be reachable by an unguessable token URL, not a login. This is the "anonymous secret link" from the requirements, scoped correctly to the *feed*.

So: `feedToken` is a high-entropy random string per calendar. Anyone with it can read the feed. Rotating the token = revoking all existing subscriptions. (Nice future feature: "regenerate link".)

---

## 4. Architecture

```
┌──────────────────────── Next.js (App Router, Vercel) ────────────────────────┐
│  Dashboard · Calendar view · Visual event editor · Paste box · Chat panel      │
│  Convex React client (real-time) + Convex Auth (Google)                        │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ reactive queries/mutations + actions
┌───────────────▼───────────────────────── Convex ───────────────────────────────┐
│  DB: users, calendars, events, mcpKeys                                          │
│  Auth: @convex-dev/auth with Google provider                                    │
│  Actions: aiExtract (paste→events), aiChat (tool-using), all call Anthropic API │
│  HTTP (convex/http.ts):                                                         │
│     GET  /feed/:token.ics   → serialize VCALENDAR (text/calendar)               │
│     POST /mcp               → MCP streamable-HTTP JSON-RPC (Bearer mcpKey)       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Why Convex carries the whole backend:
- Real-time DB → the editor, paste preview, and chat all update live with no extra plumbing.
- `convex/http.ts` httpActions serve **both** the `.ics` feed and the MCP endpoint — no separate server.
- Convex Auth ships a Google provider (`@auth/core/providers/google`); redirect URI is `https://<deployment>.convex.site/api/auth/callback/google`.
- Actions can call the Anthropic API for the AI features.

### Data model (Convex schema)

```ts
// users        → provided by Convex Auth
calendars: {
  ownerId, name, color, timezone, description,
  feedToken,        // unguessable; the subscribe secret
  sequence,         // bumped on bulk changes
  createdAt
}
events: {
  calendarId, uid,  // stable iCal UID
  title, description, location,
  start, end, allDay, timezone,
  rrule,            // null | RRULE string for recurrence
  exdates,          // [] excluded instances
  overrides,        // per-instance edits ("this event only")
  status,           // confirmed | cancelled
  sequence, lastModified
}
mcpKeys: {
  ownerId, token, label, scopes, createdAt, lastUsedAt
}
```

### The iCal feed (the part that must be bulletproof)

- `GET /feed/:token.ics` → look up calendar by `feedToken` → emit `VCALENDAR` with one `VEVENT` per event.
- Recurring events emit a single `VEVENT` with `RRULE` (+ `EXDATE` for exceptions, plus override VEVENTs with `RECURRENCE-ID`).
- Deletions emit `STATUS:CANCELLED` with a bumped `SEQUENCE` so already-subscribed apps drop them.
- Headers: `Content-Type: text/calendar; charset=utf-8`, sensible `Cache-Control` (e.g. ~1h; clients poll on their own cadence anyway), `Content-Disposition` for download.
- Use a tested serializer (`ics` or hand-rolled with strict RFC 5545 line folding + escaping). **This is where correctness bugs hide — budget real test time here** (timezones, all-day vs timed, DST, special chars).

### AI features (all Claude, called from Convex actions)

- **Paste → events:** action sends the pasted text to Claude with a structured-output tool; returns `Event[]`; UI shows a review diff; user accepts → mutation writes them. Handles relative dates using the calendar's timezone + "today".
- **Chat (conversational editing):** Claude with tools `create_event / update_event / delete_event / list_events` scoped to the active calendar. **Decision: "just do it" auto-apply mode** — the AI applies changes immediately (no confirm dialog), backed by a visible change log + one-click **Undo** for every action. Fast and lovable; Undo is the safety net instead of a gate. Same tool layer the MCP server exposes (build once, reuse).
- **Smart fill (optional, low-key):** fill missing end-times, infer location/timezone, suggest titles while editing.

### MCP server (full CRUD + create calendars)

- Streamable-HTTP MCP at `POST /mcp`, authenticated with a per-user `mcpKey` (**Bearer token** — decided; user pastes it into `mcp.json`). User generates/revokes keys in settings.
- Tools: `list_calendars`, `create_calendar`, `get_feed_url`, `list_events`, `create_event`, `update_event`, `delete_event`.
- Implemented as JSON-RPC directly in the httpAction (MCP streamable HTTP is just JSON-RPC over POST) so it stays inside Convex. The event tools call the **same internal mutations** the chat uses.
- Result: your own Claude/Codex can spin up a calendar and fill it, then you grab the subscribe link. This is the "AI support + MCP" story end-to-end.

---

## 5. Scope — explicitly minimal

### In v1
- Google sign-in; multiple calendars per user.
- Visual event editor **including recurring rules** (RRULE builder: daily/weekly/monthly, interval, until/count, by-day; this/following/all edit semantics).
- Paste → events (AI extract with review).
- Chat editing (propose → confirm).
- Live `.ics` subscribe link per calendar.
- MCP server (full CRUD + create calendars) with revocable keys.

### Deliberately OUT (keeps it minimal)
- ❌ **Luma integration** — dropped. Luma already syncs to Google Calendar, so it's redundant.
- ❌ Two-way sync with Google Calendar (we *publish* a feed; we don't import/mirror).
- ❌ Teams, shared editing, granular permissions (secret link is the only sharing).
- ❌ Reminders/notifications engine (`VALARM` can come later).
- ❌ Native mobile app, billing, multi-AI-provider support.
- ❌ Image upload OCR in v1 — "paste text" only (screenshots can be pasted as text later).

---

## 6. Milestones

| # | Milestone | Outcome |
|---|-----------|---------|
| M0 | Scaffold | Next.js + Convex + Convex Auth (Google) + Tailwind/shadcn; deploy skeleton |
| M1 | Calendars + manual editor + **feed** | Create calendar, CRUD events, working `.ics` link in real calendar apps |
| M2 | Paste → events | Paste box → Claude extract → review diff → write |
| M3 | Chat editing | Tool-using Claude, propose→confirm, undo |
| M4 | MCP server | `/mcp` endpoint, key management, full CRUD tools |
| M5 | Recurring polish | RRULE builder + this/following/all + DST/timezone correctness tests |

M1 alone is already a usable product. Everything after is the "lovable" layering.

---

## 7. Open questions / risks to revisit

1. **Subscribe refresh latency.** Apple/Google poll feeds on *their* schedule (can be hours). Set expectations in UI ("changes appear in subscribers' calendars within ~1 hour"). Consider a "force fresh" note.
2. **Anthropic cost guardrails.** Paste/chat call Claude; add per-user rate limits early (esp. since chat auto-applies — also rate-limit/undo-window the writes).
3. **Recurring edit semantics** are the deepest rabbit hole — worth a focused spike in M5.

**Resolved:** MCP auth = Bearer token in `mcp.json`. Chat = "just do it" auto-apply with Undo (not confirm-first).

---

## 8. UI exploration (separate deliverable)

**Current set — v2** (built by 5 independent design sub-agents, using the `ui-ux-pro-max` design DB for real palettes/fonts; deliberately clean, restrained, anti-"AI-slop"):

- Open `docs/plans/mockups/v2/index.html` (switch directions from the top nav).
- Directions: **(1) Neo-Brutalism** · **(2) Swiss / International Typographic** · **(3) Editorial Monochrome** · **(4) Warm Calm Minimal** · **(5) Refined Dark Mono**.
- All five render the *same* sample calendar (Acme Team) and the same core surfaces: agenda/week view, paste→events, event editor with recurring (RRULE), subscribe link, MCP.

> v1 (`docs/plans/mockups/index.html`) is kept for reference but was rejected as too generic.
