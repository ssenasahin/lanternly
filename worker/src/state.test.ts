import { describe, expect, it } from "vitest";
import { nextState, type CheckOutcome, type MonitorStatus } from "./state.js";

describe("nextState", () => {
  it.each<[MonitorStatus, CheckOutcome, MonitorStatus, "open" | "resolve" | null, boolean?]>([
    // Going down opens an incident, from any state that wasn't already down.
    ["UP", "DOWN", "DOWN", "open"],
    ["DEGRADED", "DOWN", "DOWN", "open"],
    ["PENDING", "DOWN", "DOWN", "open"],
    // Staying down doesn't alert again.
    ["DOWN", "DOWN", "DOWN", null],
    // Coming back closes it, even if the answer is slow.
    ["DOWN", "UP", "UP", "resolve"],
    ["DOWN", "DEGRADED", "DEGRADED", "resolve"],
    // Turning slow warns once, without an incident.
    ["UP", "DEGRADED", "DEGRADED", null, true],
    ["PENDING", "DEGRADED", "DEGRADED", null, true],
    ["DEGRADED", "DEGRADED", "DEGRADED", null],
    // Everything else is quiet.
    ["PENDING", "UP", "UP", null],
    ["UP", "UP", "UP", null],
    ["DEGRADED", "UP", "UP", null],
    // A paused monitor ignores a check that was already running.
    ["PAUSED", "DOWN", "PAUSED", null],
    ["PAUSED", "UP", "PAUSED", null],
    ["PAUSED", "DEGRADED", "PAUSED", null],
  ])("%s + %s check → %s, incident: %s", (current, outcome, status, incident, warn = false) => {
    expect(nextState(current, outcome)).toEqual({ status, incident, warn });
  });

  it("alerts once per outage, however long it lasts", () => {
    const outcomes: CheckOutcome[] = ["UP", "DOWN", "DOWN", "DOWN", "UP", "UP", "DOWN", "UP"];
    let status: MonitorStatus = "PENDING";
    const events: string[] = [];
    for (const outcome of outcomes) {
      const next = nextState(status, outcome);
      if (next.incident) events.push(next.incident);
      status = next.status;
    }
    expect(events).toEqual(["open", "resolve", "open", "resolve"]);
  });
});
