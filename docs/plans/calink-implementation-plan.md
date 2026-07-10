# Calink — Backend Implementation Plan (agent-executable)

> Audience: an autonomous coding agent (with the ability to spawn sub-agents) that will build/complete the Calink backend. Written to be executed top-to-bottom, one Task at a time. The frontend is **explicitly out of scope** — it will be polished later against the v6 mockups. Build a thin throwaway test UI only where needed to exercise the backend by hand.
>
> Companion docs: product/decisions in `calink-plan.md`; UI exploration in `mockups/`. This plan supersedes the build details there.

---

## 0. Orchestration contract (how the executing agent should run this)

**Work Task-by-Task, in order. Do not start a Task until the previous Task's acceptance gate is green.** Each Task below has: deliverables (as a checklist), exact files, and an acceptance gate baked into the checklist (a command that must pass + invariants).

**Use sub-agents in a builder → adversarial-verifier pattern per Task:**
1. **Builder sub-agent** implements the Task's deliverables and the happy-path tests.
2. **Verifier sub-agent** (independent context) is told to *break it*: write additional failing tests for edge cases, RFC violations, auth bypasses, timezone/DST traps, and injection. It must not edit production code except to make a test compile — it reports failures back.
3. Main agent triages verifier findings, assigns fixes, re-runs the gate.

**Global rules:**
- TypeScript strict mode on. No `any` in production code (tests may use `as`).
- Every Convex function validates args with `v.*` validators.
- Every data-access function is **ownership-scoped**: a query/mutation must verify the authenticated user owns the calendar before touching it. The verifier sub-agent must include a cross-tenant access test for every such function.
- No secret values in logs. `feedToken` and `mcpKey` are secrets.
- The feed serializer and recurrence logic are the highest-bug-risk areas — they get the deepest test matrix (Task 4).

**Provider note:** AI features call the **Anthropic API** (this is a locked product decision). Use the official `@anthropic-ai/sdk`. Default model `claude-opus-4-8`; the model client must be injected/mockable so tests never hit the network.

---

## 1. Target architecture (recap, authoritative)

```
Next.js (App Router)  ──Convex React client──▶  Convex
  (thin test UI only,                            ├─ DB: users, calendars, events, mcpKeys, changeLog
   real UI built later)                          ├─ Auth: @convex-dev/auth (Google)
                                                 ├─ queries/mutations (ownership-scoped)
                                                 ├─ actions ("use node"): aiExtract, aiChat → Anthropic SDK
                                                 └─ http.ts:
                                                     GET  /feed/:token.ics   → text/calendar
                                                     POST /mcp               → MCP Streamable-HTTP JSON-RPC (Bearer)
```

- **Editing/ownership** = Google account (Convex Auth). **Subscribing** = unguessable `feedToken` URL (calendar apps can't OAuth).
- **Chat = "just do it" auto-apply** with a `changeLog` + one-click Undo (decided).
- **MCP auth = Bearer token** in `mcp.json` (decided). Full CRUD + create-calendars.

---

## 2. Development Approach

- **Reconcile, don't clobber.** This repo may ALREADY contain a working implementation of some or all Tasks (the backend was implemented once). For each Task: first read the existing code, then treat the Task's checklist as an **acceptance specification** — add what's missing, fix what's wrong, and strengthen the test matrix. Do NOT delete/rewrite working code just to "start fresh." Every Task is idempotent: if its gate already passes, extend the tests to prove it and move on.
- **Testing approach**: co-locate tests with the module. Pure logic (`convex/lib/recurrence.ts`, `convex/lib/ics.ts`) needs no Convex harness. Convex functions use `convex-test` (edge-runtime env). AI actions inject a fake Anthropic client — never hit the network.
- Complete each Task fully before moving to the next.
- **CRITICAL: every Task MUST include new/updated tests.**
- **CRITICAL: all tests must pass before starting the next Task.**
- **Project validation commands** (the universal gate — run to validate each Task):
  - `npm run lint` — ESLint, `--max-warnings=0`.
  - `npm run typecheck` — `tsc --noEmit` (strict).
  - `npm test` — Vitest (`vitest run`).
  - All three must pass before a Task is complete. CI (GitHub Actions) must also be green before opening/merging the PR.
- **Convex codegen**: run `npx convex codegen` (or a booted `npx convex dev`) whenever schema/functions change so `convex/_generated` stays in sync and typecheck passes.

## 3. Implementation Steps

### Task 1: Scaffold & toolchain

**Files:**
- Create/verify: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `convex/` (with generated `convex/_generated`)

- [x] Ensure `package.json` has runtime deps `next`, `react`, `convex`, `@convex-dev/auth`, `@auth/core`, `@anthropic-ai/sdk` and dev deps `typescript`, `vitest`, `convex-test`, `@edge-runtime/vm`, `rrule`, `node-ical` or `ical.js` (test-only ICS validator), `zod`.
- [x] Ensure `convex/` is initialized and `convex/_generated` exists (`npx convex codegen`).
- [x] Ensure `vitest.config.ts` is configured for `convex-test`: environment `edge-runtime`, `server.deps.inline: ["convex-test"]`.
- [x] Ensure npm scripts exist: `dev`, `lint`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:watch`.
- [x] Document Convex env (do not commit secrets) in `.env.example`: `ANTHROPIC_API_KEY` (set via `npx convex env set ANTHROPIC_API_KEY ...`), `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`.
- [x] **Gate:** `npm run typecheck` passes; `npm test` runs (0 tests ok); `convex/_generated` present. Run `npm run lint && npm run typecheck && npm test`.

### Task 2: Schema, auth, ownership-scoped CRUD + Undo

**Files:**
- Create/verify: `convex/schema.ts`, `convex/auth.ts`, `convex/calendars.ts`, `convex/events.ts`, `convex/mcpKeys.ts`
- Create/verify: `convex/backend.test.ts` (or split per-module test files)

- [x] `convex/schema.ts` defines tables per spec: `...authTables`, `calendars` (ownerId, name, color, timezone IANA, description?, feedToken secret, sequence, createdAt; indexes `by_owner`, `by_feedToken`), `events` (calendarId, uid, title, description?, location?, meetingUrl?, start epoch-ms, end?, allDay, timezone TZID, rrule? (no `RRULE:` prefix), exdates[], status confirmed|cancelled, sequence, lastModified, recurrenceId?; indexes `by_calendar`, `by_calendar_status`), `mcpKeys` (ownerId, token secret, label, createdAt, lastUsedAt?; indexes `by_owner`, `by_token`), `changeLog` (calendarId, actorType user|agent|mcp, op, inverse, description, createdAt, undone; index `by_calendar`).
- [x] `convex/auth.ts`: Convex Auth with Google provider (`import Google from "@auth/core/providers/google"`). Export `auth, signIn, signOut, store, isAuthenticated`. Document redirect URI `https://<deployment>.convex.site/api/auth/callback/google`.
- [x] Helpers: `getAuthedUserId(ctx)` throws if unauthenticated; `requireOwnedCalendar(ctx, calendarId)` loads calendar, asserts `ownerId === userId` else throws. **Every event mutation funnels through it.**
- [x] `calendars`: `list`, `create` (generates `feedToken` via Web Crypto `crypto.getRandomValues`, 20 bytes → base64url), `rename/recolor/setTimezone`, `regenerateFeedToken`, `remove`.
- [x] `events`: `listByCalendar`, `create`, `update`, `remove` (soft: `status:"cancelled"` + bump `sequence`; prune later via cron).
- [x] Internal mutations `applyCreate/applyUpdate/applyDelete` that ALSO append to `changeLog` with an inverse — reused by chat + MCP so undo works uniformly. `undo(calendarId)` pops last non-undone `changeLog` row, applies inverse, marks undone.
- [x] Tests (`convex-test`): create-calendar sets a unique feedToken; CRUD round-trips; **cross-tenant test** — user B cannot read/update/delete user A's calendar or events (each throws); `undo` reverts the last create/update/delete; auth-required functions throw when unauthenticated.
- [x] **Gate:** `npm run lint && npm run typecheck && npm test`.

### Task 3: Recurrence engine (pure, heavily tested)

**Files:**
- Create/verify: `convex/lib/recurrence.ts`, `convex/lib/recurrence.test.ts`

- [x] `expandOccurrences(event, {from, to, limit})` → `Date[]` of instance starts honoring `rrule`, `exdates`, optional `until`. Implement on top of `rrule` (RRule.between / .all with count) but wrap it so the rest of the code is library-agnostic.
- [x] `applyEditScope(series, instanceStart, scope, patch)` → returns the set of DB writes for: **"this event only"** (add `instanceStart` to `series.exdates` + insert override row with `recurrenceId = instanceStart` + patch); **"this and following"** (set `UNTIL` on original RRULE to just before `instanceStart`; create new series starting at `instanceStart` with patch); **"all events"** (patch the series row directly).
- [x] Helpers to build/parse RRULE strings (freq, interval, byday, bymonthday, bysetpos, until, count) with a typed model shared by the AI/MCP layers and the future UI builder.
- [x] Deep test matrix (verifier owns this): weekly-on-Mon, every-2-weeks, weekdays, Mon/Wed/Fri, monthly day-N, monthly Nth-weekday ("2nd Tuesday"), yearly; `UNTIL`/`COUNT` terminate correctly; `EXDATE` removes the right instances; **DST**: a recurring 09:00 Europe/Berlin event stays at 09:00 local across March/October transitions (assert local wall-clock); all-day vs timed; edit-scope splits verified (union of old ∪ new reproduces original future set minus the change; "this only" = exactly one override + one EXDATE). Optional property test: random rule → expand → count matches `rrule` reference.
- [x] **Gate:** `npm run lint && npm run typecheck && npm test`.

### Task 4: iCal feed serializer + HTTP endpoint (highest-risk)

**Files:**
- Create/verify: `convex/lib/ics.ts`, `convex/lib/ics.test.ts`, `convex/http.ts`, `convex/feed.ts`

- [x] `serializeCalendar(calendar, events)` → RFC 5545 string: `BEGIN:VCALENDAR`/`VERSION:2.0`/`PRODID`/`CALSCALE:GREGORIAN`/`X-WR-CALNAME`/`X-WR-TIMEZONE`; one `VEVENT` per event with `UID`, `DTSTAMP` (UTC), `DTSTART`/`DTEND` (`TZID=` for timed, `VALUE=DATE` for all-day), `SUMMARY`, `DESCRIPTION`, `LOCATION`, `URL` (meetingUrl), `RRULE`, `EXDATE` (one per excluded, matching TZID), `RECURRENCE-ID` for overrides, `STATUS`, `SEQUENCE`, `LAST-MODIFIED`.
- [x] **Line folding** at 75 octets (UTF-8 aware, fold with CRLF + space); **text escaping** `\ ; ,` and newline → `\\ \; \, \n`; **CRLF** everywhere; emit `VTIMEZONE` blocks for referenced TZIDs (safer for Apple Calendar); cancellations emit `STATUS:CANCELLED` + bumped `SEQUENCE`.
- [x] `convex/http.ts`: `httpRouter` with `pathPrefix: "/feed/"`; parse token + strip `.ics` from `request.url` manually. `httpAction` calls an `internalQuery` (in `feed.ts`) to fetch calendar+events by `feedToken` (no auth — the token IS the auth); 404 if absent. Headers: `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: public, max-age=3600`, `Content-Disposition: inline; filename="<calendar>.ics"`.
- [x] Tests: **round-trip** — `serializeCalendar(...)` output parsed by `node-ical`/`ical.js` matches input (summary, start/end, rrule, exdates, status); folding test (>75-octet SUMMARY folds + unfolds); escaping test (`, ; \` + newlines round-trip); all-day emits `VALUE=DATE`, timed emits `TZID`; cancelled emits `STATUS:CANCELLED`; HTTP GET valid token → 200 + `text/calendar`, unknown token → 404, body starts `BEGIN:VCALENDAR` and ends `END:VCALENDAR\r\n`.
- [x] **Manual milestone (human-in-loop, document result):** subscribe `webcal://<deployment>.convex.site/feed/<token>.ics` in Google + Apple Calendar; confirm events render, recurrence repeats, a later cancellation disappears on refresh. [x] manual test (skipped - not automatable)
- [x] **Gate:** `npm run lint && npm run typecheck && npm test`.

### Task 5: AI — paste → events (structured extraction)

**Files:**
- Create/verify: `convex/ai.ts` (action, `"use node"`), `convex/rateLimits.ts`, tests alongside

- [x] `extractEvents({ calendarId, text, now, timezone })`: build an Anthropic request using **structured outputs** to force a typed `{ events: Array<{title, description?, location?, meetingUrl?, startISO, endISO?, allDay, rrule?}> }`. Model constant `claude-opus-4-8` (allow `claude-haiku-4-5` for the cheap path). Thinking off. System prompt: "Extract calendar events from the user's pasted text. Resolve relative dates against `now` in `timezone`. Output RRULE strings for anything repeating. Do not invent events." Write immediately + surface Undo (writes go through `applyCreate`, so they append to `changeLog`).
- [x] Anthropic client behind a small `getModelClient()` indirection so tests inject a fake.
- [x] Per-user rate-limit guard (max N extract calls / minute; token-bucket mutation or table in `rateLimits.ts`).
- [x] Tests (mocked model client): canned structured response maps to event rows with correct fields; writes append to `changeLog` (Undo works); prompt includes `now`/`timezone`; no real network call; rate-limit trips.
- [x] **Gate:** `npm run lint && npm run typecheck && npm test`.

### Task 6: AI — conversational editing (tool-using, auto-apply + Undo)

**Files:**
- Create/verify: `convex/ai.ts` (`chat` action, `"use node"`), shared tool definitions, tests alongside

- [x] `chat({ calendarId, messages })`: manual agentic loop — `client.messages.create({ model: "claude-opus-4-8", thinking: { type: "adaptive" }, tools, messages })`; while `stop_reason === "tool_use"`, execute each tool, append `tool_result` blocks, re-call; stop on `end_turn`.
- [x] **Tools** (defined once, shared with MCP — Task 7): `list_events`, `create_event`, `update_event`, `delete_event`. Each handler calls the same internal `applyCreate/applyUpdate/applyDelete` mutations so every change lands in `changeLog` and is undoable. **Auto-apply**: tools mutate immediately; the action returns assistant text + applied `changeLog` entries. Recurrence edits go through `applyEditScope` (Task 3); `update_event`/`delete_event` take `scope: "this" | "following" | "all"`. Use SDK-parsed `block.input` — never raw-string-match.
- [x] Tests (mocked model): scripted turn calling `create_event` then `end_turn` → one new event + one `changeLog` entry; `update_event` with `scope:"this"` → override + EXDATE (assert via recurrence helpers); Undo reverts a chat-applied change; chat on a non-owned calendar throws before any model call.
- [x] **Gate:** `npm run lint && npm run typecheck && npm test`.

### Task 7: MCP server (Streamable HTTP, Bearer, full CRUD)

**Files:**
- Create/verify: `convex/http.ts` (`POST /mcp`), `convex/mcpKeys.ts` (management), tests alongside

- [ ] `POST /mcp` (`httpAction`): **Auth** — read `Authorization: Bearer <token>`, look up `mcpKeys.by_token`, 401 if missing/invalid, stamp `lastUsedAt`; the key's `ownerId` scopes every op. **Transport** — Streamable HTTP; accept a single JSON-RPC request (+ batches) per POST; respond `application/json`. Methods: `initialize` (protocol version + `tools: {}` capabilities), `tools/list` (catalog), `tools/call` (dispatch by name); unknown methods → JSON-RPC error `-32601`.
- [ ] **Tools (full CRUD + create calendars):** `list_calendars`, `create_calendar`, `get_feed_url`, `list_events`, `create_event`, `update_event` (with `scope`), `delete_event` — each scoped to the key's `ownerId`, reusing the same internal mutations (writes hit `changeLog`).
- [ ] `mcpKeys` management: `createMcpKey(label)` (full token shown once), `listMcpKeys` (masked token + label + lastUsedAt), `revokeMcpKey(id)`. Document the `mcp.json` snippet (URL `https://<deployment>.convex.site/mcp`, `Authorization` bearer header).
- [ ] Tests: `initialize` returns capabilities; `tools/list` lists all 8 tools with valid JSON Schemas; `tools/call create_event` creates an event + returns id; missing/invalid Bearer → 401; a key for user A cannot touch user B's calendar (404/forbidden); malformed JSON-RPC → proper error object. Optional: MCP Inspector smoke against a local deployment (document result).
- [ ] **Gate:** `npm run lint && npm run typecheck && npm test`.

### Task 8: Hardening, scheduled cleanup, security review

**Files:**
- Create/verify: `convex/crons.ts`, `convex/maintenance.ts`, `convex/rateLimits.ts`; security checklist doc

- [ ] **Cron** (`convex/crons.ts` + `maintenance.ts`): daily job pruning `cancelled` events older than N days and trimming `changeLog` to a bounded history per calendar.
- [ ] **Rate limits**: both AI actions and `/mcp` have per-owner throttles.
- [ ] **Secret hygiene**: confirm `feedToken`/`mcpKey` never appear in logs or error messages; feed 404 is generic (no token echo).
- [ ] **Security review** (dedicated verifier sub-agent): attempt feed-token guessing/enumeration, MCP auth bypass, cross-tenant access through every function, prompt-injection in pasted text trying to exfiltrate other calendars (assert owner-scoping blocks it), and ICS injection (newline/escape attacks in titles reaching the feed — verify Task 4 escaping holds).
- [ ] Produce a security checklist with each item marked pass/fail + evidence; re-run the manual subscribe verification (Task 4) end-to-end.
- [ ] **Gate:** full `npm run lint && npm run typecheck && npm test` green; CI green before merging the PR.

---

## 4. Test infrastructure summary

- **Framework:** `vitest` + `convex-test` (edge-runtime env). `import.meta.glob("./**/*.ts")` to load modules for `convexTest(schema, modules)`.
- **Pure-logic tests** (recurrence, ics) need no Convex harness — fastest, deepest matrix.
- **Convex tests**: auth scoping, CRUD, undo, http actions (`t.fetch("/feed/...")`, `t.fetch("/mcp", {...})`).
- **AI tests:** inject a fake Anthropic client; never hit the network. Assert request shape (model id, tools, structured-output schema) and that responses map to the right DB writes + changeLog.
- **Third-party ICS validation:** parse generated feeds with `node-ical`/`ical.js` and assert round-trip — the single most valuable correctness test.
- **Manual gates:** real calendar-app subscription (Task 4) and MCP Inspector handshake (Task 7) — human-in-the-loop, documented.

---

## 5. Build order / dependency graph

```
Task 1 (scaffold)
  └▶ Task 2 (schema/auth/CRUD/undo)
        ├▶ Task 3 (recurrence)  ──┐
        ├▶ Task 4 (ics + feed)  ──┤ (4 depends on 3 for occurrence/override shaping)
        ├▶ Task 5 (paste→events) │ (depends on 2; uses 3 for rrule)
        ├▶ Task 6 (chat)         │ (depends on 2,3; reuses internal mutations)
        └▶ Task 7 (MCP)          │ (depends on 2; reuses tools from 6)
                                 ▼
                           Task 8 (hardening + security review)
```

Tasks 3 and 4 are the correctness core — do them carefully and first after the schema.

---

## 6. Open questions to surface to the user (don't block on these)

1. **Override modelling**: separate `events` rows with `recurrenceId` vs an embedded array. Plan assumes separate rows (cleaner for the feed). Confirm.
2. **Hard delete vs always-cancel**: plan always soft-cancels then prunes. Confirm acceptable.
3. **AI model tier**: default `claude-opus-4-8`; offer `claude-haiku-4-5` for the cheap extraction path. Confirm cost/quality preference.
4. **MCP protocol surface**: tools-only (no resources/prompts) in v1. Confirm.
