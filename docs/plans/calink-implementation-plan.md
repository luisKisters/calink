# Calink — Backend Implementation Plan (agent-executable)

> Audience: an autonomous coding agent (with the ability to spawn sub-agents) that will build the Calink backend. Written to be executed top-to-bottom. The frontend is **explicitly out of scope** for this plan — it will be polished later against the v6 mockups. Build a thin throwaway test UI only where needed to exercise the backend by hand.
>
> Companion docs: product/decisions in `calink-plan.md`; UI exploration in `mockups/`. This plan supersedes the build details there.

---

## 0. Orchestration contract (how the executing agent should run this)

**Work phase-by-phase. Do not start a phase until the previous phase's acceptance gate is green.** Each phase below has: deliverables, exact files, and an **acceptance gate** (a command that must pass + invariants).

**Use sub-agents in a builder → adversarial-verifier pattern per phase:**
1. **Builder sub-agent** implements the phase's deliverables and the happy-path tests.
2. **Verifier sub-agent** (independent context) is told to *break it*: write additional failing tests for edge cases, RFC violations, auth bypasses, timezone/DST traps, and injection. It must not edit production code except to make a test compile — it reports failures back.
3. Main agent triages verifier findings, assigns fixes, re-runs the gate.

For phases that touch shared files concurrently, run builders in **git worktrees** to avoid conflicts, then merge.

**Global rules:**
- TypeScript strict mode on. No `any` in production code (tests may use `as`).
- Every Convex function validates args with `v.*` validators.
- Every data-access function is **ownership-scoped**: a query/mutation must verify the authenticated user owns the calendar before touching it. The verifier sub-agent must include a cross-tenant access test for every such function.
- No secret values in logs. `feedToken` and `mcpKey` are secrets.
- The feed serializer and recurrence logic are the highest-bug-risk areas — they get the deepest test matrix (Phase 3).
- Run `npm run lint && npm run typecheck && npm test` as the universal gate; individual phases add specifics.

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

## 2. Phase 0 — Scaffold & toolchain

**Deliverables**
- `package.json` with: `next`, `react`, `convex`, `@convex-dev/auth`, `@auth/core`, `@anthropic-ai/sdk`, dev: `typescript`, `vitest`, `convex-test`, `@edge-runtime/vm` (convex-test needs an edge-like env), `rrule` (recurrence expansion for tests + occurrences API), `node-ical` or `ical.js` (test-only ICS validator), `zod`.
- `convex/` initialized (`npx convex dev` once to generate `_generated`).
- `vitest.config.ts` configured for `convex-test` (environment `edge-runtime`, `server.deps.inline: ["convex-test"]`).
- `npm` scripts: `dev`, `lint`, `typecheck` (`tsc --noEmit`), `test`, `test:watch`.
- `.env.local` / Convex env documented (do not commit secrets): `ANTHROPIC_API_KEY` (set via `npx convex env set ANTHROPIC_API_KEY ...`), `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`.

**Acceptance gate**
- `npm run typecheck` passes; `npm test` runs (0 tests ok); `npx convex dev` boots and generates `_generated`.

---

## 3. Phase 1 — Schema, auth, ownership-scoped CRUD

**Deliverables**

`convex/schema.ts`:
```ts
export default defineSchema({
  ...authTables, // from @convex-dev/auth
  calendars: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    color: v.string(),
    timezone: v.string(),         // IANA, e.g. "Europe/Berlin"
    description: v.optional(v.string()),
    feedToken: v.string(),        // unguessable secret
    sequence: v.number(),         // bumped on bulk ops
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"])
    .index("by_feedToken", ["feedToken"]),

  events: defineTable({
    calendarId: v.id("calendars"),
    uid: v.string(),              // stable iCal UID (e.g. `${_id}@calink.app`)
    title: v.string(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    meetingUrl: v.optional(v.string()),   // separate from location
    start: v.number(),            // epoch ms (UTC instant) OR date for all-day
    end: v.optional(v.number()),
    allDay: v.boolean(),
    timezone: v.string(),         // event-level TZID
    rrule: v.optional(v.string()),        // RFC5545 RRULE (no "RRULE:" prefix stored)
    exdates: v.array(v.number()),         // excluded occurrence start instants
    status: v.union(v.literal("confirmed"), v.literal("cancelled")),
    sequence: v.number(),
    lastModified: v.number(),
    // overrides for "this event only" edits of a recurring series:
    recurrenceId: v.optional(v.number()), // if set, this row overrides one instance
  }).index("by_calendar", ["calendarId"])
    .index("by_calendar_status", ["calendarId", "status"]),

  mcpKeys: defineTable({
    ownerId: v.id("users"),
    token: v.string(),            // secret bearer
    label: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  }).index("by_owner", ["ownerId"]).index("by_token", ["token"]),

  changeLog: defineTable({        // powers Undo for chat + MCP writes
    calendarId: v.id("calendars"),
    actorType: v.union(v.literal("user"), v.literal("agent"), v.literal("mcp")),
    op: v.string(),               // "create" | "update" | "delete" | "bulk"
    inverse: v.any(),             // payload sufficient to revert
    description: v.string(),
    createdAt: v.number(),
    undone: v.boolean(),
  }).index("by_calendar", ["calendarId"]),
});
```

`convex/auth.ts`: Convex Auth with Google provider (`import Google from "@auth/core/providers/google"`). Export `auth, signIn, signOut, store, isAuthenticated`. Redirect URI: `https://<deployment>.convex.site/api/auth/callback/google`. Set `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` via `npx convex env set`.

`convex/calendars.ts` & `convex/events.ts` — ownership-scoped queries/mutations:
- `getAuthedUserId(ctx)` helper → throws if unauthenticated.
- `requireOwnedCalendar(ctx, calendarId)` helper → loads calendar, asserts `ownerId === userId`, else throw. **Every event mutation funnels through this.**
- calendars: `list`, `create` (generates `feedToken` via crypto-random, 160+ bits, base64url), `rename/recolor/setTimezone`, `regenerateFeedToken`, `remove`.
- events: `listByCalendar`, `create`, `update`, `remove` (soft via `status:"cancelled"` + bump `sequence` so subscribers drop it; hard-delete only allowed for never-published… keep it simple: always soft-cancel, prune via cron later).
- Internal mutations (`internalMutation`) `applyCreate/applyUpdate/applyDelete` that ALSO append to `changeLog` with an inverse — reused by chat + MCP so undo works uniformly.
- `undo(calendarId)`: pops last non-undone `changeLog` row, applies inverse, marks undone.

Token generation: use Web Crypto (`crypto.getRandomValues`) in the Convex runtime; base64url-encode 20 bytes.

**Acceptance gate**
- `convex-test` suite: create-calendar sets a unique feedToken; CRUD round-trips; **cross-tenant test** — user B cannot read/update/delete user A's calendar or events (each throws); `undo` reverts the last create/update/delete. Auth-required functions throw when unauthenticated.

---

## 4. Phase 2 — Recurrence engine (pure, heavily tested)

This is pure logic with **no Convex dependency** so it's trivially unit-testable. Put it in `convex/lib/recurrence.ts` and `convex/lib/recurrence.test.ts`.

**Deliverables**
- `expandOccurrences(event, {from, to, limit})` → `Date[]` of instance starts, honoring `rrule`, `exdates`, and an optional `until`. Implement on top of `rrule` (RRule.between / .all with count), but wrap it so the rest of the code is library-agnostic.
- `applyEditScope(series, instanceStart, scope, patch)` → returns the set of DB writes for:
  - **"this event only"** → add `instanceStart` to `series.exdates` + insert an override event row with `recurrenceId = instanceStart` and the patch applied.
  - **"this and following"** → set `UNTIL` on the original series' RRULE to just before `instanceStart`; create a new series starting at `instanceStart` with the patch.
  - **"all events"** → patch the series row directly.
- Helpers to build/parse RRULE strings (freq, interval, byday, bymonthday, bysetpos, until, count) with a typed model so the AI/MCP layers and the (future) UI builder share it.

**Acceptance gate (the deep matrix — verifier sub-agent owns this)**
- Weekly-on-Mon, every-2-weeks, weekdays, Mon/Wed/Fri, monthly day-N, monthly Nth-weekday ("2nd Tuesday"), yearly.
- `UNTIL` and `COUNT` terminate correctly; `EXDATE` removes the right instances.
- DST correctness: a recurring 09:00 Europe/Berlin event stays at 09:00 local across the March/October transitions (assert the local wall-clock, not the UTC instant).
- All-day vs timed events.
- Edit-scope: "this and following" splits the series and the union of (old series ∪ new series) reproduces the original future set minus the change; "this only" produces exactly one overridden instance + one EXDATE.
- Property test (optional but recommended): random rule → expand → re-derive count matches `rrule` reference.

---

## 5. Phase 3 — iCal feed serializer + HTTP endpoint (highest-risk)

**Deliverables**

`convex/lib/ics.ts` (pure):
- `serializeCalendar(calendar, events)` → RFC 5545 string. Requirements:
  - `BEGIN:VCALENDAR` / `VERSION:2.0` / `PRODID` / `CALSCALE:GREGORIAN` / `X-WR-CALNAME` / `X-WR-TIMEZONE`.
  - One `VEVENT` per event: `UID`, `DTSTAMP` (UTC), `DTSTART`/`DTEND` (with `TZID=` for timed, `VALUE=DATE` for all-day), `SUMMARY`, `DESCRIPTION`, `LOCATION`, `URL` (meetingUrl), `RRULE`, `EXDATE` (one per excluded, matching TZID), `RECURRENCE-ID` for overrides, `STATUS`, `SEQUENCE`, `LAST-MODIFIED`.
  - **Line folding** at 75 octets (UTF-8 aware, fold with CRLF + space).
  - **Text escaping**: `\` `;` `,` and newline → `\\ \; \, \n` per spec; `SUMMARY`/`DESCRIPTION`/`LOCATION`.
  - **CRLF** line endings everywhere.
  - Emit `VTIMEZONE` blocks for referenced TZIDs (or document the decision to rely on well-known TZIDs; emitting VTIMEZONE is safer for Apple Calendar — include it).
  - Cancellations: `STATUS:CANCELLED` + bumped `SEQUENCE`.

`convex/http.ts`:
```ts
http.route({ path: "/feed/:token.ics" ... })  // see note below on path matching
```
- Convex `httpRouter` supports exact paths and `pathPrefix`. Use `pathPrefix: "/feed/"` and parse the token + strip `.ics` from `request.url` (httpRouter does not do `:param` segments — match the prefix and parse manually). Look up calendar by `feedToken` (indexed query via an `internalQuery` the action calls), 404 if absent. Return the serialized body with headers:
  - `Content-Type: text/calendar; charset=utf-8`
  - `Cache-Control: public, max-age=3600`
  - `Content-Disposition: inline; filename="<calendar>.ics"`
- The handler is an `httpAction`; it calls an `internalQuery` to fetch calendar+events by token (no auth — the token IS the auth).

**Acceptance gate**
- **Round-trip validation:** feed `serializeCalendar(...)` output is parsed by `node-ical`/`ical.js` in tests and the parsed events match input (summary, start/end, rrule, exdates, status). This is the key correctness gate.
- Folding test: a >75-octet SUMMARY folds correctly and unfolds back to the original.
- Escaping test: titles containing `,` `;` `\` and newlines round-trip.
- All-day event emits `VALUE=DATE` (no time); timed emits `TZID`.
- Cancelled event emits `STATUS:CANCELLED`.
- HTTP: GET with a valid token → 200 + `text/calendar`; unknown token → 404; the body starts with `BEGIN:VCALENDAR` and ends with `END:VCALENDAR\r\n`.
- **Manual verification (milestone, human-in-loop):** run `npx convex dev`, create a calendar with a few events incl. one recurring + one cancelled, subscribe `webcal://<deployment>.convex.site/feed/<token>.ics` in **Google Calendar and Apple Calendar**, confirm events render, recurrence repeats, and a later cancellation disappears on refresh. Document the result.

---

## 6. Phase 4 — AI: paste → events (structured extraction)

**Deliverables**

`convex/ai.ts` (action with `"use node"` so the Anthropic SDK runs):
- `extractEvents(args: { calendarId, text, now, timezone })`:
  - Builds an Anthropic request using **structured outputs** to force a typed array of events. Use `client.messages.parse({ model, output_config: { format: <json schema> } })` (or `output_config.format` with a hand-written JSON schema) — schema = `{ events: Array<{title, description?, location?, meetingUrl?, startISO, endISO?, allDay, rrule?}> }`.
  - Model: `claude-opus-4-8` for quality (or `claude-haiku-4-5` for cost — structured outputs are supported on Haiku 4.5; make the model a config constant). Thinking off for extraction.
  - System prompt: "Extract calendar events from the user's pasted text. Resolve relative dates against `now` in `timezone`. Output RRULE strings for anything described as repeating. Do not invent events."
  - Returns the parsed events to the caller; the **mutation that writes them is separate** (review-then-apply, but per the auto-apply decision the chat path applies immediately — for paste, write immediately and surface Undo).
- The Anthropic client is created behind a small `getModelClient()` indirection so tests inject a fake.

**Acceptance gate**
- Unit test with a **mocked** model client: given a canned structured response, `extractEvents` maps it to event rows with correct fields and the writes append to `changeLog` (so Undo works). Relative-date prompt includes `now`/`timezone`. No real network call in tests.
- Add a per-user rate-limit guard (simple: max N extract calls / minute, tracked in a table or via a token-bucket mutation) and test it trips.

---

## 7. Phase 5 — AI: conversational editing (tool-using, auto-apply + Undo)

**Deliverables**

`convex/ai.ts` → `chat(args: { calendarId, messages })` action (`"use node"`):
- Implements a **manual agentic loop** (the skill's manual-loop pattern): call `client.messages.create({ model: "claude-opus-4-8", thinking: { type: "adaptive" }, tools, messages })`; while `stop_reason === "tool_use"`, execute each tool, append `tool_result` blocks, re-call; stop on `end_turn`.
- **Tools** (defined once, shared with MCP — see Phase 6): `list_events`, `create_event`, `update_event`, `delete_event`. Each tool handler calls the same internal `applyCreate/applyUpdate/applyDelete` mutations from Phase 1, so every change lands in `changeLog` and is undoable.
- **Auto-apply** (decided): tools mutate immediately; the action returns the assistant text + the list of applied `changeLog` entries (for the UI to show "applied · Undo").
- Recurrence edits go through `applyEditScope` (Phase 2) — the `update_event`/`delete_event` tools take a `scope: "this" | "following" | "all"` arg.
- Tool inputs parsed with `JSON.parse` semantics already handled by the SDK (`block.input` is parsed) — never raw-string-match.

**Acceptance gate**
- Mocked-model test: a scripted assistant turn that calls `create_event` then `end_turn` results in one new event + one `changeLog` entry; a turn that calls `update_event` with `scope:"this"` produces an override + EXDATE (delegates to Phase 2, assert via the recurrence tests' helpers).
- Undo test: after a chat-applied change, `undo(calendarId)` reverts it.
- Ownership: chat on a calendar the user doesn't own throws before any model call.

---

## 8. Phase 6 — MCP server (Streamable HTTP, Bearer, full CRUD)

> This is a server **we expose** for the user's own agent (Claude/Codex) to call — not the Anthropic MCP *connector*. Implement the MCP spec's JSON-RPC over HTTP.

**Deliverables**

`convex/http.ts` → `POST /mcp` (`httpAction`):
- **Auth:** read `Authorization: Bearer <token>`; look up `mcpKeys.by_token`; 401 if missing/invalid; stamp `lastUsedAt`. The key's `ownerId` scopes every operation.
- **Transport:** Streamable HTTP. Accept a single JSON-RPC request (and JSON-RPC batches) per POST; respond `application/json`. Implement methods:
  - `initialize` → returns protocol version + server capabilities (`tools: {}`).
  - `tools/list` → the tool catalog.
  - `tools/call` → dispatch by tool name.
  - Reply to unknown methods with JSON-RPC error `-32601`.
- **Tools (full CRUD + create calendars):** `list_calendars`, `create_calendar`, `get_feed_url`, `list_events`, `create_event`, `update_event` (with `scope`), `delete_event`. Each is scoped to the key's `ownerId` and reuses the same internal mutations (writes hit `changeLog`).
- `mcpKeys` management functions (Phase 1 already has the table): `createMcpKey(label)`, `listMcpKeys` (return masked token + label + lastUsedAt), `revokeMcpKey(id)`. The full token is shown once at creation.
- Document the `mcp.json` snippet the user pastes (URL `https://<deployment>.convex.site/mcp`, `Authorization` header with the bearer).

**Acceptance gate**
- HTTP tests against the action: `initialize` returns capabilities; `tools/list` lists all 8 tools with valid JSON Schemas; `tools/call create_event` creates an event and returns its id; missing/invalid Bearer → 401; a key for user A cannot touch user B's calendar (404/forbidden); malformed JSON-RPC → proper error object.
- Spec-conformance smoke: optionally run the public MCP Inspector against a local deployment and confirm the handshake + a `tools/call`. Document the result.

---

## 9. Phase 7 — Hardening, scheduled cleanup, security review

**Deliverables**
- **Cron** (`convex/crons.ts`): daily job to prune `cancelled` events older than N days and trim `changeLog` to a bounded history per calendar.
- **Rate limits**: ensure both AI actions and `/mcp` have per-owner throttles.
- **Secret hygiene**: confirm `feedToken`/`mcpKey` never appear in logs or error messages; feed 404 is generic (no token echo).
- **Security review** (dedicated verifier sub-agent): attempt feed-token guessing/enumeration, MCP auth bypass, cross-tenant access through every function, prompt-injection in pasted text that tries to exfiltrate other calendars (the AI tools are owner-scoped, so injection can't cross tenants — assert this), and ICS injection (newline/escape attacks in event titles reaching the feed — covered by Phase 3 escaping; verify).

**Acceptance gate**
- Full `npm run lint && npm run typecheck && npm test` green.
- Security checklist documented with each item marked pass/fail + evidence.
- Manual subscribe verification (Phase 3) re-run end-to-end after all phases.

---

## 10. Test infrastructure summary

- **Framework:** `vitest` + `convex-test` (edge-runtime env). `import.meta.glob("./**/*.ts")` to load modules for `convexTest(schema, modules)`.
- **Pure-logic tests** (recurrence, ics) need no Convex harness — fastest, deepest matrix.
- **Convex tests** (`convexTest`): auth scoping, CRUD, undo, http actions (`t.fetch("/feed/...")`, `t.fetch("/mcp", {...})`).
- **AI tests:** inject a fake Anthropic client; never hit the network. Assert request shape (model id, tools, structured-output schema) and that responses map to the right DB writes + changeLog.
- **Third-party ICS validation:** parse generated feeds with `node-ical`/`ical.js` and assert round-trip — this is the single most valuable correctness test.
- **Manual gates:** real calendar-app subscription (Phase 3) and MCP Inspector handshake (Phase 6) — human-in-the-loop, documented.

---

## 11. Build order / dependency graph

```
Phase 0 (scaffold)
  └▶ Phase 1 (schema/auth/CRUD/undo)
        ├▶ Phase 2 (recurrence)  ──┐
        ├▶ Phase 3 (ics + feed)  ──┤ (3 depends on 2 for occurrence/override shaping)
        ├▶ Phase 4 (paste→events) │ (depends on 1; uses 2 for rrule)
        ├▶ Phase 5 (chat)         │ (depends on 1,2; reuses internal mutations)
        └▶ Phase 6 (MCP)          │ (depends on 1; reuses tools from 5)
                                  ▼
                            Phase 7 (hardening + security review)
```

Phases 2 and 3 are the correctness core — do them carefully and first after the schema. 4/5/6 can be built in parallel worktrees by separate builder sub-agents once 1 & 2 land, because they all reuse the Phase 1 internal mutations and Phase 2 recurrence helpers.

---

## 12. Open questions to surface to the user before/while building (don't block on these)

1. **Override modelling**: storing overrides as separate `events` rows with `recurrenceId` vs an embedded array. Plan assumes separate rows (cleaner for the feed). Confirm.
2. **Hard delete vs always-cancel**: plan always soft-cancels so subscribers drop events cleanly, then prunes. Confirm acceptable.
3. **AI model tier**: default `claude-opus-4-8`; offer `claude-haiku-4-5` for the cheap extraction path. Confirm cost/quality preference.
4. **MCP protocol surface**: tools-only (no resources/prompts) in v1. Confirm.
