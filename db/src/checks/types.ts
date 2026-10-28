import type { CheckStatus } from "../generated/prisma/client.js";
import type { RuleResult } from "./rules.js";

// What one attempt found. Shaped like a check_results row, so it can be stored as is.
export interface Attempt {
  status: CheckStatus;
  responseMs: number | null;
  statusCode: number | null;
  error: string | null;
  // An API check's rule verdicts, when there are any to keep.
  rules?: RuleResult[];
}

// Turns a host name (or IP) into addresses that are safe to connect to, or throws.
// In production that's the SSRF guard; tests swap in one that allows a local server.
export type Resolve = (hostname: string) => Promise<string[]>;

export function failed(error: string, statusCode: number | null = null): Attempt {
  return { status: "DOWN", responseMs: null, statusCode, error };
}

// A monitor that answers, but slower than its owner allows, is degraded rather than
// up: it still works, so it opens no incident, but someone should know.
export function markSlow<T extends Attempt>(attempt: T, slowAfterMs: number | null): T {
  const { status, responseMs } = attempt;
  if (status !== "UP" || slowAfterMs === null || responseMs === null || responseMs <= slowAfterMs) {
    return attempt;
  }
  const ms = (n: number) => `${n.toLocaleString("en-GB")} ms`;
  return {
    ...attempt,
    status: "DEGRADED",
    error: `Took ${ms(responseMs)}, over the ${ms(slowAfterMs)} limit`,
  };
}
