import { z } from "zod";

export const MAX_INT = 2_147_483_647;
export const positiveInt = () => z.number().int().positive().max(MAX_INT);
