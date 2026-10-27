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

// "30 s", "1 min", "2 min 30 s": a check interval or timeout, short.
export function formatSeconds(total: number): string {
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

// A precise timestamp for tables: "27 Oct, 14:11:56", in the viewer's time zone but in
// English like the rest of the interface.
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// "99.98%", "100%", "–" when there were no checks. Two decimals because the difference
// between 99.9% and 99.99% is most of a month's downtime budget.
export function formatPercent(ratio: number | null): string {
  if (ratio === null) return "–";
  if (ratio === 1) return "100%";
  // Never round a monitor with failures up to 100%.
  return `${(Math.floor(ratio * 10000) / 100).toFixed(2)}%`;
}

// "320 ms", "1.24 s".
export function formatMs(ms: number | null): string {
  if (ms === null) return "–";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// "35 min", "2 h 5 min", "3 d 4 h": how long an incident lasted (or has lasted).
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

// "27 Oct, 14:00–14:15": the period one chart bucket covers.
export function formatBucket(at: string, bucketSec: number): string {
  const start = new Date(at);
  const end = new Date(start.getTime() + bucketSec * 1000);
  const day = start.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time(start)}–${time(end)}`;
}
