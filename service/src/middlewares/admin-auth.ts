import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors/app-error.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function requireAdmin(adminToken: string) {
  const expected = digest(adminToken);
  return async (req: FastifyRequest): Promise<void> => {
    const given = req.headers["x-admin-token"];
    // Comparing fixed-length digests in constant time avoids leaking the token through timing.
    if (typeof given !== "string" || !timingSafeEqual(digest(given), expected)) {
      throw new UnauthorizedError("invalid_admin_token", "Missing or invalid X-Admin-Token");
    }
  };
}
