import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../errors/app-error.js";

/** Every error response has the same shape: { error: { code, message, details? } } */
const body = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(body("route_not_found", "Route not found")));

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reply.status(400).send(body("validation_error", "Invalid request", details));
    }
    // Errors raised by Fastify itself for bad requests (e.g. malformed JSON) carry a 4xx statusCode.
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.status(status).send(body("bad_request", (err as Error).message));
    }
    // A bug or an infrastructure failure: log everything, tell the client nothing.
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send(body("internal_error", "Internal server error"));
  });
}
