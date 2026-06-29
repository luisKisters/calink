/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as auth from "../auth.js";
import type * as calendars from "../calendars.js";
import type * as crons from "../crons.js";
import type * as events from "../events.js";
import type * as feed from "../feed.js";
import type * as http from "../http.js";
import type * as lib_anthropicClient from "../lib/anthropicClient.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_calendarTools from "../lib/calendarTools.js";
import type * as lib_ics from "../lib/ics.js";
import type * as lib_mcpServer from "../lib/mcpServer.js";
import type * as lib_recurrence from "../lib/recurrence.js";
import type * as lib_tokens from "../lib/tokens.js";
import type * as lib_validators from "../lib/validators.js";
import type * as maintenance from "../maintenance.js";
import type * as mcpKeys from "../mcpKeys.js";
import type * as rateLimits from "../rateLimits.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  auth: typeof auth;
  calendars: typeof calendars;
  crons: typeof crons;
  events: typeof events;
  feed: typeof feed;
  http: typeof http;
  "lib/anthropicClient": typeof lib_anthropicClient;
  "lib/authz": typeof lib_authz;
  "lib/calendarTools": typeof lib_calendarTools;
  "lib/ics": typeof lib_ics;
  "lib/mcpServer": typeof lib_mcpServer;
  "lib/recurrence": typeof lib_recurrence;
  "lib/tokens": typeof lib_tokens;
  "lib/validators": typeof lib_validators;
  maintenance: typeof maintenance;
  mcpKeys: typeof mcpKeys;
  rateLimits: typeof rateLimits;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
