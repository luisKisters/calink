# Manual Verification

## Calendar subscription

- Status: pending human verification. Automated serializer/feed tests pass, but Apple Calendar and Google Calendar subscription were not performed from this terminal.
- Steps:
  1. Run `npx convex dev`.
  2. Create a calendar with a timed event, all-day event, recurring event, and cancelled event.
  3. Subscribe to `webcal://<deployment>.convex.site/feed/<token>.ics` in Apple Calendar and Google Calendar.
  4. Confirm recurrence, cancellation refresh, and event details render as expected.

## MCP Inspector

- Status: pending human verification. Automated JSON-RPC handshake and `tools/call` tests pass, but MCP Inspector was not run against a deployed site.
- Steps:
  1. Run `npx convex dev`.
  2. Configure MCP Inspector against `https://<deployment>.convex.site/mcp`.
  3. Include `Authorization: Bearer <mcp key>`.
  4. Confirm `initialize`, `tools/list`, and `tools/call` complete.
