import { describe, expect, it } from "vitest";
import { monthStart, parseMonth, systemClock } from "../../../src/lib/time.js";

describe("monthStart (UTC)", () => {
  it.each([
    { now: "2026-10-14T13:20:00Z", expected: "2026-10-01" },
    { now: "2026-10-01T00:00:00.000Z", expected: "2026-10-01" }, // first instant of the month
    { now: "2026-10-31T23:59:59.999Z", expected: "2026-10-01" }, // last instant of the month
    { now: "2026-11-01T00:00:00.000Z", expected: "2026-11-01" }, // next instant -> new month
    { now: "2026-12-31T23:59:59.999Z", expected: "2026-12-01" },
    { now: "2027-01-01T00:00:00.000Z", expected: "2027-01-01" }, // year rollover
    { now: "2028-02-29T12:00:00Z", expected: "2028-02-01" }, // leap day
  ])("$now -> $expected", ({ now, expected }) => {
    expect(monthStart(new Date(now))).toBe(expected);
  });

  it("uses UTC, not the machine's timezone", () => {
   
    expect(monthStart(new Date("2026-10-31T22:30:00Z"))).toBe("2026-10-01");
   
    expect(monthStart(new Date("2026-11-01T00:30:00+03:00"))).toBe("2026-10-01");
  });
});

describe("parseMonth", () => {
  it.each([
    { input: "2026-10", expected: "2026-10-01" },
    { input: "2026-01", expected: "2026-01-01" },
    { input: "2026-12", expected: "2026-12-01" },
    { input: "2026-13", expected: null },
    { input: "2026-00", expected: null },
    { input: "2026-1", expected: null },
    { input: "2026-10-01", expected: null },
    { input: "", expected: null },
    { input: "abcd-ef", expected: null },
  ])("'$input' -> $expected", ({ input, expected }) => {
    expect(parseMonth(input)).toBe(expected);
  });
});

describe("systemClock", () => {
  it("returns the current time", () => {
    const before = Date.now();
    const now = systemClock().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
