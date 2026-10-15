import type { Rule, Scope } from "./types.js";

export const maxPerRequest = (scope: Scope): Rule => ({
  scope,
  name: "max_per_request",
  check: ({ units, limits }) => {
    const limit = limits[scope].maxPerRequest;
    return units <= limit ? { ok: true } : { ok: false, limit };
  },
});
