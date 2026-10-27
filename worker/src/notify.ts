import {
  emailLayout,
  escapeHtml,
  type Mail,
  type Mailer,
  type NotificationJob,
  type PrismaClient,
} from "@lanternly/db";

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

const when = (date: Date) => date.toISOString().replace("T", " ").slice(0, 16) + " UTC";

const row = (label: string, value: string) =>
  `<tr><td style="padding:6px 16px 6px 0;color:#8b939d;white-space:nowrap">${label}</td>` +
  `<td style="padding:6px 0;font-family:'JetBrains Mono',Consolas,monospace;word-break:break-all">${value}</td></tr>`;

const button = (href: string, label: string) =>
  `<p style="margin:28px 0 0"><a href="${href}" style="display:inline-block;background:#f5a524;color:#0b0d10;` +
  `text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">${label}</a></p>`;

export function incidentEmail(
  kind: NotificationJob["kind"],
  incident: IncidentDetails,
  webOrigin: string,
): Omit<Mail, "to"> {
  const { monitor } = incident;
  const link = `${webOrigin}/monitors/${monitor.id}`;
  // Everything a user typed is escaped, the monitor name and target included.
  const name = escapeHtml(monitor.name);
  const target = escapeHtml(monitor.target);

  if (kind === "down") {
    const cause = incident.cause ?? "No response";
    return {
      subject: `Down: ${monitor.name}`,
      text: [
        `${monitor.name} is down.`,
        ``,
        `Target: ${monitor.target}`,
        `Cause: ${cause}`,
        `Since: ${when(incident.startedAt)}`,
        ``,
        `Lanternly will email you again when it's back up.`,
        link,
      ].join("\n"),
      html: emailLayout(
        `<span style="color:#f04438">●</span> ${name} is down`,
        `<table style="border-collapse:collapse;font-size:14px">` +
          row("Target", target) +
          row("Cause", escapeHtml(cause)) +
          row("Since", when(incident.startedAt)) +
          `</table>` +
          `<p style="margin:20px 0 0;color:#8b939d;font-size:14px">We'll email you again when it's back up. No more alerts until then.</p>` +
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
      `Target: ${monitor.target}`,
      `Down from: ${when(incident.startedAt)}`,
      `Up again: ${when(resolvedAt)}`,
      ``,
      link,
    ].join("\n"),
    html: emailLayout(
      `<span style="color:#12b76a">●</span> ${name} is back up`,
      `<table style="border-collapse:collapse;font-size:14px">` +
        row("Target", target) +
        row("Downtime", downtime) +
        row("Down from", when(incident.startedAt)) +
        row("Up again", when(resolvedAt)) +
        `</table>` +
        button(link, "Open monitor"),
    ),
  };
}

export interface NotifyDeps {
  prisma: PrismaClient;
  mailer: Mailer;
  webOrigin: string;
}

// Runs from the notifications queue, so a mail server hiccup is retried with backoff
// instead of losing the alert or slowing down the checks.
export async function sendIncidentEmail(
  job: NotificationJob,
  { prisma, mailer, webOrigin }: NotifyDeps,
) {
  const incident = await prisma.incident.findUnique({
    where: { id: job.incidentId },
    include: {
      monitor: {
        select: { id: true, name: true, target: true, owner: { select: { email: true } } },
      },
    },
  });
  // The monitor (and with it the incident) was deleted before the email went out.
  if (!incident) return;

  const mail = incidentEmail(job.kind, incident, webOrigin);
  await mailer.send({ to: incident.monitor.owner.email, ...mail });
}
