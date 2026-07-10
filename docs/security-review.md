# Security Review

## Feed token guessing / enumeration
PASS. Token is 20 random bytes (160 bits, base64url) from `crypto.getRandomValues` — brute-force infeasible. Feed 404 is a generic "Not found" response that does not echo the token back. `convex/backend.test.ts` verifies valid tokens return 200, unknown tokens return 404 with body "Not found".

## MCP auth bypass
PASS. `handleMcpRequest` reads the `Authorization: Bearer <token>` header and returns 401 before parsing the body if the token is absent or not found in `mcpKeys`. `convex/backend.test.ts` verifies a request without a bearer token receives 401.

## Cross-tenant function access
PASS. Every query/mutation funnels through `requireOwnedCalendar` / `requireOwnedEvent` in `convex/lib/authz.ts`, which asserts `ownerId === userId` and throws "Calendar not found" otherwise. `convex/backend.test.ts` exercises: user B cannot list, update, delete, or remove user A's calendar/events (all throw); MCP key for user B cannot access user A's feed URL (isError: true).

## Prompt injection / tenant isolation in AI actions
PASS. `ai.extractEvents` and `ai.chat` both call `getForOwner` / `listForOwner` before constructing any model request. The ownership check throws before the model is called, so injected prompts cannot cross tenants. `convex/backend.test.ts` verifies `ai.chat` throws "Calendar not found" for a cross-tenant calendar and that `modelCalls === 0` (model was never invoked).

## ICS injection — text fields (title, description, location)
PASS. `escapeText` converts `\`, `;`, `,`, and newlines (`\r\n` / `\n`) to RFC-compliant escape sequences before placing text in TEXT-type properties. `convex/lib/ics.test.ts` round-trips a title with all four special characters through `ical.js` and asserts they survive intact.

## ICS injection — URL field
PASS. `sanitizeUri` strips `\r\n` from `meetingUrl` before placing it in the `URL:` property. `convex/lib/ics.test.ts` verifies a URL containing `\r\nSUMMARY:Injected` does not produce a `SUMMARY:Injected` property.

## ICS injection — RRULE field
PASS (fix applied). Before Task 8 the `RRULE:` property value was emitted without CRLF sanitization, which would have allowed an attacker to inject new iCal property lines by embedding `\r\n` in the rrule string. `sanitizeIcsParam` is now applied to the rrule value before output. `convex/lib/ics.test.ts` verifies a rrule containing `\r\nINJECTED:evil` does not produce an `INJECTED:` property line.

## ICS injection — timezone / TZID fields
PASS (fix applied). Timezone IDs used in `VTIMEZONE` blocks, `DTSTART;TZID=` parameters, and `X-WR-TIMEZONE` are passed through `sanitizeIcsParam` (strips `\r\n`) before output. Additionally `vtimezone` adds a try-catch around `Intl.DateTimeFormat` calls so an unknown timezone after sanitization emits a minimal stub rather than crashing the feed. `convex/lib/ics.test.ts` verifies a timezone containing `\r\nINJECTED:evil` does not produce an `INJECTED:` property line.

## Secret hygiene
PASS by code review. `feedToken` is never logged or included in error messages; the feed 404 body is the generic string "Not found". `mcpKey.token` is never returned by `listMcpKeys` — only the masked form (`maskSecret`) is exposed. The `revokeMcpKey` error is "MCP key not found" (no token echo). `createMcpKey` returns the full token once at creation; after that it is stored in the DB and never retrieved by public APIs.

## Rate limiting
PASS. Both AI actions (`ai_extract` — 10/min, `ai_chat` — 20/min) and the MCP endpoint (120/min per key owner) guard calls through `rateLimits.consume`. The rate limiter uses a sliding-window token-bucket stored in the `rateLimits` table, resets on window expiry, and deduplicates stale rows. `convex/backend.test.ts` covers: rate limit trips on exhaustion, window rollover resets the count, `extractEvents` throws "Rate limit exceeded" after the limit is pre-consumed.

## Scheduled maintenance
PASS. `convex/crons.ts` schedules a daily job (03:15 UTC) that runs `maintenance.prune`. The pruner hard-deletes `cancelled` events whose `lastModified` is older than 30 days, and trims `changeLog` rows per calendar to the 200 most recent. `convex/backend.test.ts` verifies: old cancelled events are pruned while recent ones are kept; `changeLog` is trimmed to the configured maximum.

---

Automated evidence: `npm run lint`, `npm run typecheck`, and `npm test` (37 tests) passed on 2026-07-10.
