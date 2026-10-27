import { describe, expect, it } from "vitest";
import {
  cronProblem,
  expectedBy,
  lateAfter,
  nextRuns,
  type HeartbeatSchedule,
} from "./heartbeats.js";

const hourly: HeartbeatSchedule = { periodSec: 3600, cron: null, timezone: "UTC", graceSec: 300 };
// 03:00 in Istanbul is 00:00 UTC (UTC+3 all year).
const nightly: HeartbeatSchedule = {
  periodSec: null,
  cron: "0 3 * * *",
  timezone: "Europe/Istanbul",
  graceSec: 600,
};
const at = (iso: string) => new Date(iso);

describe("cronProblem", () => {
  it("accepts a classic five-field expression", () => {
    expect(cronProblem("0 3 * * *", "UTC")).toBeNull();
    expect(cronProblem("  */15  9-17 * * 1-5 ", "Europe/Istanbul")).toBeNull();
  });

  it("asks for exactly five fields", () => {
    expect(cronProblem("0 0 3 * * *", "UTC")).toMatch(/five fields/);
    expect(cronProblem("0 3 * *", "UTC")).toMatch(/five fields/);
  });

  it("rejects values out of range and unknown zones", () => {
    expect(cronProblem("61 * * * *", "UTC")).toMatch(/Not a valid cron expression/);
    expect(cronProblem("0 3 * * *", "Mars/Olympus")).toBe("Unknown time zone");
  });
});

describe("nextRuns", () => {
  it("reads the expression in the heartbeat's time zone", () => {
    const runs = nextRuns("0 3 * * *", "Europe/Istanbul", at("2026-10-27T10:00:00Z"), 2);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-10-28T00:00:00.000Z",
      "2026-10-29T00:00:00.000Z",
    ]);
  });
});

describe("expectedBy", () => {
  it("adds the period to the last ping", () => {
    expect(expectedBy(hourly, at("2026-10-27T10:07:00Z"))).toEqual(at("2026-10-27T11:07:00Z"));
  });

  it("expects the next cron run after the last ping", () => {
    // Pinged a few seconds after tonight's run: due at tomorrow's.
    expect(expectedBy(nightly, at("2026-10-28T00:00:05Z"))).toEqual(at("2026-10-29T00:00:00Z"));
  });

  it("counts a slightly early ping as that run's", () => {
    // 30 s before the 03:00 run; without the allowance it'd be due 30 s later.
    expect(expectedBy(nightly, at("2026-10-27T23:59:30Z"))).toEqual(at("2026-10-29T00:00:00Z"));
  });

  it("never lets the allowance swallow the next run of a frequent job", () => {
    const fiveMinutes = { ...nightly, cron: "*/5 * * * *", timezone: "UTC" };
    expect(expectedBy(fiveMinutes, at("2026-10-27T10:00:05Z"))).toEqual(at("2026-10-27T10:05:00Z"));
  });

  it("keeps the allowance within the grace period", () => {
    // A 30 s grace allows 30 s early, so a ping 40 s early is the run before's.
    const tight = { ...nightly, graceSec: 30 };
    expect(expectedBy(tight, at("2026-10-27T23:59:20Z"))).toEqual(at("2026-10-28T00:00:00Z"));
  });
});

describe("lateAfter", () => {
  it("is the due time plus the grace period", () => {
    expect(lateAfter(hourly, at("2026-10-27T10:00:00Z"))).toEqual(at("2026-10-27T11:05:00Z"));
    expect(lateAfter(nightly, at("2026-10-28T00:00:05Z"))).toEqual(at("2026-10-29T00:10:00Z"));
  });
});
