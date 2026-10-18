import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ADMIN_TOKEN: z.string().min(8, "ADMIN_TOKEN must be at least 8 chars"),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Connections per process. Total connections to Postgres = WEB_CONCURRENCY x DB_POOL_MAX. */
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  /** Number of Node processes serving requests (1 = a single process, no cluster). All state lives in Postgres. */
  WEB_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}