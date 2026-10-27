import { resolvePublicHost } from "@lanternly/db";
import { checkHttp } from "./http.js";
import { checkPing } from "./ping.js";
import type { Attempt, Resolve } from "./types.js";

export interface CheckSettings {
  type: "HTTP" | "PING";
  target: string;
  timeoutMs: number;
  retries: number;
}

// Runs the first attempt plus up to `retries` more, stopping at the first success.
// One dropped packet or a single slow response shouldn't wake anyone up; only when
// every attempt fails is the monitor down. Attempts run back to back, so the API's
// rule (timeout × attempts fits in the interval) keeps checks from overlapping.
export async function runCheck(
  monitor: CheckSettings,
  resolve: Resolve = (host) => resolvePublicHost(host),
): Promise<Attempt> {
  const attempt = () =>
    monitor.type === "HTTP"
      ? checkHttp(monitor.target, monitor.timeoutMs, resolve)
      : checkPing(monitor.target, monitor.timeoutMs, resolve);

  let result = await attempt();
  for (let retry = 0; retry < monitor.retries && result.status === "DOWN"; retry++) {
    result = await attempt();
  }
  return result;
}
