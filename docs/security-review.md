# Security Review

- Feed-token guessing/enumeration: pass. `convex/backend.test.ts` verifies valid feed tokens return 200, unknown tokens return generic 404, and the unknown token is not echoed.
- MCP auth bypass: pass. `convex/backend.test.ts` verifies missing Bearer auth returns 401 and valid keys are required before JSON-RPC handling.
- Cross-tenant function access: pass. `convex/backend.test.ts` verifies user B cannot list, update, delete, or remove user A's calendar/events, and an MCP key for user B cannot access user A's feed URL.
- Prompt injection against AI tools: pass for tenant isolation. `convex/backend.test.ts` verifies `ai.chat` checks calendar ownership before the model client is called, so injected tool requests cannot cross tenants.
- ICS injection through text fields: pass. `convex/lib/ics.test.ts` verifies escaped text round-trips and CR/LF in `URL` values cannot inject a new property.
- Secret logging: pass by review. Production code does not log `feedToken` or `mcpKey`; public feed 404 and MCP 401 responses are generic.
- Rate-limit rollover: pass. `convex/backend.test.ts` covers expired-window reset without duplicate `rateLimits` rows.

Automated evidence: `npm run lint`, `npm run typecheck`, and `npm test` passed on June 29, 2026.
