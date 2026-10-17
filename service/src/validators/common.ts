import { z } from "zod";

/** 'YYYY-MM' (a UTC calendar month). */
export const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must use YYYY-MM format");

export const externalIdField = z.string().trim().min(1).max(200);

/** limit/offset query parameters (query strings arrive as text, hence coerce). */
export const pagination = (defaultLimit: number, maxLimit: number) => ({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  offset: z.coerce.number().int().min(0).default(0),
});

export const uuidParams = z.object({ id: z.uuid() });
