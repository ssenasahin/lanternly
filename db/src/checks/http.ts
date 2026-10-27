import { UnsafeTargetError } from "../network.js";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch } from "undici";
import { failed, type Attempt, type Resolve } from "./types.js";

const MAX_REDIRECTS = 5;
export const USER_AGENT = "Lanternly/0.1 (uptime check; +https://github.com/ssenasahin/lanternly)";

// Requests a URL the way a visitor would, following redirects, and calls any final
// 200–399 answer up. The SSRF guard runs twice: on every redirect hop, so a public
// page can't bounce us to 169.254.169.254, and inside the connection's DNS lookup,
// so the address we connect to is the one we checked, not a later DNS answer.
export async function checkHttp(
  target: string,
  timeoutMs: number,
  resolve: Resolve,
): Promise<Attempt> {
  // A fresh connection per check: a reused one would skip the DNS, TCP and TLS work
  // a real visitor pays for, and report a response time nobody actually sees.
  const agent = new Agent({ connect: { lookup: guardedLookup(resolve) } });
  // One deadline for the whole check, redirects included.
  const signal = AbortSignal.timeout(timeoutMs);
  const started = performance.now();

  try {
    let url = new URL(target);
    for (let hop = 0; ; hop++) {
      // Connecting to an IP address skips DNS, and with it the lookup's guard.
      await resolve(url.hostname);

      const res = await fetch(url, {
        dispatcher: agent,
        signal,
        redirect: "manual",
        headers: { "user-agent": USER_AGENT },
      });
      // Only the status matters; don't download the page.
      await res.body?.cancel();

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === MAX_REDIRECTS) return failed("Too many redirects", res.status);
        url = new URL(location, url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return failed("Redirected to an address that isn't http or https", res.status);
        }
        continue;
      }

      const responseMs = Math.round(performance.now() - started);
      if (res.status >= 200 && res.status < 400) {
        return { status: "UP", responseMs, statusCode: res.status, error: null };
      }
      return { ...failed(`HTTP ${res.status}`, res.status), responseMs };
    }
  } catch (err) {
    return failed(describeError(err, signal, timeoutMs));
  } finally {
    void agent.destroy();
  }
}

// net.connect's DNS step, replaced with the guard. Node asks for either every address
// (when it races IPv4 against IPv6) or just one, so answer in the shape it asked for.
export function guardedLookup(resolve: Resolve): LookupFunction {
  return (hostname: string, options: LookupOptions, callback) => {
    resolve(hostname).then(
      (found) => {
        const addresses: LookupAddress[] = found
          .map((address) => ({ address, family: isIP(address) }))
          .filter((a) => !options.family || options.family === a.family);
        if (addresses.length === 0) {
          callback(new Error(`No usable address for ${hostname}`), "");
        } else if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      },
      (err: Error) => callback(err, ""),
    );
  };
}

const CERT_ERRORS = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const NETWORK_ERRORS: Record<string, string> = {
  ECONNREFUSED: "Connection refused",
  ECONNRESET: "Connection reset by the server",
  EHOSTUNREACH: "Host unreachable",
  ENETUNREACH: "Network unreachable",
  ENOTFOUND: "Host not found",
  EAI_AGAIN: "DNS lookup failed",
  UND_ERR_SOCKET: "The server closed the connection",
};

// fetch reports everything as "fetch failed"; the useful part is in the cause.
// These messages end up in alert emails, so they're written for people.
export function describeError(err: unknown, signal: AbortSignal, timeoutMs: number): string {
  if (signal.aborted) return `Timed out after ${timeoutMs / 1000} s`;
  if (err instanceof UnsafeTargetError) return err.message;

  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  if (cause instanceof UnsafeTargetError) return cause.message;

  // fetch refuses ports browsers block, like 25 (SMTP), so it can't be aimed at them.
  if (cause instanceof Error && cause.message === "bad port") {
    return "That port is blocked for web requests";
  }
  const code = (cause as { code?: string } | null)?.code;
  if (code && CERT_ERRORS.has(code)) return `TLS certificate problem (${code})`;
  if (code && NETWORK_ERRORS[code]) return NETWORK_ERRORS[code];
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, 200);
}
