import { emailLayout, escapeHtml, type Mail } from "@lanternly/db";

export interface IncidentDetails {
  monitor: { id: string; name: string; target: string };
  startedAt: Date;
  resolvedAt: Date | null;
  cause: string | null;
}

// "35 s", "4 min", "2 h 5 min": how long an outage lasted, for people.
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export const formatUtc = (date: Date) => date.toISOString().replace("T", " ").slice(0, 16) + " UTC";

const row = (label: string, value: string) =>
  `<tr><td style="padding:6px 16px 6px 0;color:#8b939d;white-space:nowrap">${label}</td>` +
  `<td style="padding:6px 0;font-family:'JetBrains Mono',Consolas,monospace;word-break:break-all">${value}</td></tr>`;

const button = (href: string, label: string) =>
  `<p style="margin:28px 0 0"><a href="${href}" style="display:inline-block;background:#f5a524;color:#0b0d10;` +
  `text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">${label}</a></p>`;

// Heartbeats have no target to show: the job calls Lanternly, not the other way round.
const targetRow = (target: string) => (target ? row("Target", escapeHtml(target)) : "");
const targetLine = (target: string) => (target ? [`Target: ${target}`] : []);

export interface IncidentEmailOptions {
  // A signed link that acknowledges the incident without signing in.
  ackLink?: string | null;
  // Sent because nobody acknowledged the first alert in time.
  escalated?: boolean;
  // Said under the details instead of the default: what happens next.
  note?: string | null;
}

export function incidentEmail(
  kind: "down" | "up",
  incident: IncidentDetails & { id?: string },
  webOrigin: string,
  { ackLink = null, escalated = false, note = null }: IncidentEmailOptions = {},
): Omit<Mail, "to"> {
  const { monitor } = incident;
  const link = `${webOrigin}/monitors/${monitor.id}`;
  // Everything a user typed is escaped, the monitor name and target included.
  const name = escapeHtml(monitor.name);

  if (kind === "down") {
    const cause = incident.cause ?? "No response";
    const still = escalated ? "still " : "";
    const next = note ?? "Lanternly will email you again when it's back up.";
    return {
      subject: `${escalated ? "Still down" : "Down"}: ${monitor.name}`,
      text: [
        `${monitor.name} is ${still}down.`,
        ``,
        ...targetLine(monitor.target),
        `Cause: ${cause}`,
        `Since: ${formatUtc(incident.startedAt)}`,
        ``,
        next,
        link,
        ...(ackLink ? [``, `Acknowledge it: ${ackLink}`] : []),
      ].join("\n"),
      html: emailLayout(
        `<span style="color:#f04438">●</span> ${name} is ${still}down`,
        `<table style="border-collapse:collapse;font-size:14px">` +
          targetRow(monitor.target) +
          row("Cause", escapeHtml(cause)) +
          row("Since", formatUtc(incident.startedAt)) +
          `</table>` +
          `<p style="margin:20px 0 0;color:#8b939d;font-size:14px">${escapeHtml(next)}</p>` +
          (ackLink ? button(ackLink, "Acknowledge") : "") +
          button(link, "Open monitor"),
      ),
    };
  }

  const resolvedAt = incident.resolvedAt ?? new Date();
  const downtime = formatDuration(resolvedAt.getTime() - incident.startedAt.getTime());
  return {
    subject: `Back up: ${monitor.name} (down for ${downtime})`,
    text: [
      `${monitor.name} is back up after ${downtime}.`,
      ``,
      ...targetLine(monitor.target),
      `Down from: ${formatUtc(incident.startedAt)}`,
      `Up again: ${formatUtc(resolvedAt)}`,
      ``,
      link,
    ].join("\n"),
    html: emailLayout(
      `<span style="color:#12b76a">●</span> ${name} is back up`,
      `<table style="border-collapse:collapse;font-size:14px">` +
        targetRow(monitor.target) +
        row("Downtime", downtime) +
        row("Down from", formatUtc(incident.startedAt)) +
        row("Up again", formatUtc(resolvedAt)) +
        `</table>` +
        button(link, "Open monitor"),
    ),
  };
}

export interface SlowCheckDetails {
  monitor: { id: string; name: string; target: string };
  checkedAt: Date;
  // What made it slow, in words: the check stores it as its error.
  error: string | null;
}

export function slowEmail(check: SlowCheckDetails, webOrigin: string): Omit<Mail, "to"> {
  const { monitor } = check;
  const link = `${webOrigin}/monitors/${monitor.id}`;
  const detail = check.error ?? "Slower than its threshold";
  return {
    subject: `Slow: ${monitor.name}`,
    text: [
      `${monitor.name} is slower than usual.`,
      ``,
      ...targetLine(monitor.target),
      `Detail: ${detail}`,
      `At: ${formatUtc(check.checkedAt)}`,
      ``,
      `It's still answering, so no incident is open. Lanternly won't warn again until it's back to normal.`,
      link,
    ].join("\n"),
    html: emailLayout(
      `<span style="color:#f5a524">●</span> ${escapeHtml(monitor.name)} is slow`,
      `<table style="border-collapse:collapse;font-size:14px">` +
        targetRow(monitor.target) +
        row("Detail", escapeHtml(detail)) +
        row("At", formatUtc(check.checkedAt)) +
        `</table>` +
        `<p style="margin:20px 0 0;color:#8b939d;font-size:14px">It's still answering, so no incident is open. No more warnings until it's back to normal.</p>` +
        button(link, "Open monitor"),
    ),
  };
}
