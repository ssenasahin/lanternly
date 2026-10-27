import { resolvePublicHost, UnsafeTargetError, type ResolveHost } from "@lanternly/db";
import { isIP } from "node:net";
import { HttpError } from "../http.js";

export type MonitorKind = "HTTP" | "API" | "PING";

// One DNS label: letters, digits and inner hyphens, at most 63 characters.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Parses what the user typed into the form the worker will use, and refuses anything
// that isn't on the public internet. Returns the normalised target to store.
export async function checkTarget(
  type: MonitorKind,
  target: string,
  resolve?: ResolveHost,
): Promise<string> {
  const { normalised, hostname } = type === "PING" ? parseHost(target) : parseUrl(target);
  try {
    await resolvePublicHost(hostname, resolve);
  } catch (err) {
    if (err instanceof UnsafeTargetError) throw targetError(err.message);
    throw err;
  }
  return normalised;
}

function parseUrl(target: string) {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw targetError("Enter a full URL, starting with https://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw targetError("Only http:// and https:// URLs can be monitored");
  }
  // Credentials in a URL would be stored in plain text and shown back on every screen.
  if (url.username || url.password) {
    throw targetError("Remove the user name and password from the URL");
  }
  // The URL parser already turns tricks like http://2130706433 into 127.0.0.1.
  return { normalised: url.href, hostname: url.hostname };
}

function parseHost(target: string) {
  const host = target.toLowerCase();
  if (isIP(host)) return { normalised: host, hostname: host };

  const labels = host.replace(/\.$/, "").split(".");
  // An all-digit last label is a short IPv4 form like 127.1, never a real domain.
  if (
    host.length > 253 ||
    !labels.every((label) => LABEL.test(label)) ||
    /^\d+$/.test(labels.at(-1)!)
  ) {
    throw targetError("Enter a host name like example.com, or an IP address");
  }
  return { normalised: host, hostname: host };
}

function targetError(message: string) {
  return new HttpError(400, "Invalid request", { target: [message] });
}
