

const pad = (n: number) => String(n).padStart(2, "0");

/** First day of the UTC month containing `now`, as 'YYYY-MM-01' (matches usage_counters.window_start). */
export function monthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`;
}

/** Parses a 'YYYY-MM' query value into 'YYYY-MM-01', or null if it is not a valid month. */
export function parseMonth(value: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return m ? `${m[1]}-${m[2]}-01` : null;
}
