import type { CheckOutcome } from "../state.js";

// What one attempt found. Shaped like a check_results row, so it can be stored as is.
export interface Attempt {
  status: CheckOutcome;
  responseMs: number | null;
  statusCode: number | null;
  error: string | null;
}

// Turns a host name (or IP) into addresses that are safe to connect to, or throws.
// In production that's the SSRF guard; tests swap in one that allows a local server.
export type Resolve = (hostname: string) => Promise<string[]>;

export function failed(error: string, statusCode: number | null = null): Attempt {
  return { status: "DOWN", responseMs: null, statusCode, error };
}
