const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

// "just now", "4 minutes ago", "yesterday".
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(Math.round(seconds / 60), "minute");
}

// The first matching pattern wins, so Edge is tested before the Chrome it contains.
const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
  [/curl\//, "curl"],
];
const SYSTEMS: [RegExp, string][] = [
  [/Windows/, "Windows"],
  [/iPhone|iPad/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

// Enough of a user agent to recognise a device: "Chrome on Windows".
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? userAgent.slice(0, 40);
}

// Only same-site paths are followed after sign-in, so a crafted ?next= link
// cannot bounce someone to another site. Browsers read "\" as "/", so "/\evil.com"
// would be as dangerous as "//evil.com".
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\")
    ? next
    : "/";
}
