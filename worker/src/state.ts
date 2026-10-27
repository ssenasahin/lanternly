// The rules for when a monitor changes state and what that means for incidents.
// Pure on purpose: no database, no clock, no queue. Given where a monitor is and what
// the latest check found, it says where the monitor goes next, so every rule can be
// pinned down by a unit test.

export type MonitorStatus = "PENDING" | "UP" | "DOWN" | "DEGRADED" | "PAUSED";
export type CheckOutcome = "UP" | "DOWN" | "DEGRADED";

export interface Transition {
  status: MonitorStatus;
  // "open" starts an incident and alerts; "resolve" closes it and says it's back.
  incident: "open" | "resolve" | null;
  // Warn that the monitor got slow. Not an outage, so no incident: one email when it
  // starts, and none while it stays slow.
  warn: boolean;
}

export function nextState(current: MonitorStatus, outcome: CheckOutcome): Transition {
  // A check that was already running when the monitor was paused changes nothing.
  if (current === "PAUSED") return { status: "PAUSED", incident: null, warn: false };

  if (outcome === "DOWN") {
    // Still down: the incident is already open and the owner already knows.
    if (current === "DOWN") return { status: "DOWN", incident: null, warn: false };
    // Up, degraded or never checked: this is news. A brand-new monitor whose very
    // first check fails is down too, and the owner should hear about it.
    return { status: "DOWN", incident: "open", warn: false };
  }

  // Answering again, even if slowly, ends the outage. The "back up" email is enough;
  // a slowness warning on top of it would be noise.
  if (current === "DOWN") return { status: outcome, incident: "resolve", warn: false };

  // Moving between up, degraded and pending is not an outage: no incident. Only
  // turning slow is worth a word.
  return {
    status: outcome,
    incident: null,
    warn: outcome === "DEGRADED" && current !== "DEGRADED",
  };
}
