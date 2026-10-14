import type { Rule, Scope } from "./types.js";

/** The request itself may not be larger than the plan's per-request limit. */
export const maxPerRequest = (scope: Scope): Rule => ({
  scope,
  name: "max_per_request",
  check: ({ units, limits }) => {
    const limit = limits[scope].maxPerRequest;
    return units <= limit ? { ok: true } : { ok: false, limit };
  },
});
