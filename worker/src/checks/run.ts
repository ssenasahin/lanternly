import {
  checkApi,
  checkHttp,
  markSlow,
  resolvePublicHost,
  type ApiRequestSpec,
  type Attempt,
  type Resolve,
} from "@lanternly/db";
import { checkDns, type DnsSettings } from "./dns.js";
import { checkPing } from "./ping.js";
import { checkTcp } from "./tcp.js";

export interface CheckSettings {
  type: "HTTP" | "API" | "PING" | "TCP" | "DNS";
  target: string;
  timeoutMs: number;
  retries: number;
  slowAfterMs: number | null;
  // How to call an API monitor; null for the other types.
  api: Omit<ApiRequestSpec, "url"> | null;
  // What a DNS monitor asks for; null for the other types.
  dns: DnsSettings | null;
}

// Runs the first attempt plus up to `retries` more, stopping at the first success.
// One dropped packet or a single slow response shouldn't wake anyone up; only when
// every attempt fails is the monitor down. Attempts run back to back, so the API's
// rule (timeout × attempts fits in the interval) keeps checks from overlapping.
export async function runCheck(
  monitor: CheckSettings,
  resolve: Resolve = (host) => resolvePublicHost(host),
): Promise<Attempt> {
  const attempt = async (): Promise<Attempt> => {
    if (monitor.type === "PING") return checkPing(monitor.target, monitor.timeoutMs, resolve);
    if (monitor.type === "TCP") return checkTcp(monitor.target, monitor.timeoutMs, resolve);
    if (monitor.type === "DNS") {
      // A DNS monitor's target is the name it asks about, so the SSRF guard has no
      // say: nothing connects to it. The server it asks is checked instead.
      const dns = monitor.dns ?? { recordType: "A", expected: null, resolver: null };
      return checkDns(monitor.target, dns, monitor.timeoutMs);
    }
    if (monitor.type === "HTTP" || !monitor.api) {
      return checkHttp(monitor.target, monitor.timeoutMs, resolve);
    }
    const {
      response: _response,
      rules,
      ...result
    } = await checkApi({ ...monitor.api, url: monitor.target }, monitor.timeoutMs, resolve);
    // The verdicts are kept only when one failed: that's when someone will ask why.
    return rules.some((r) => !r.passed) ? { ...result, rules } : result;
  };
  let result = await attempt();
  for (let retry = 0; retry < monitor.retries && result.status === "DOWN"; retry++) {
    result = await attempt();
  }
  // Slowness is judged on the answer that counted, after any retries.
  return markSlow(result, monitor.slowAfterMs);
}
