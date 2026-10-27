import {
  ackLink,
  deliver,
  DeliveryError,
  readSteps,
  type AlertMessage,
  type EscalationJob,
  type EscalationStep,
  type IncidentEventType,
  type Mail,
  type Mailer,
  type NotificationChannel,
  type NotificationJob,
  type PrismaClient,
  type Transport,
} from "@lanternly/db";
import { formatDuration, formatUtc, incidentEmail, slowEmail } from "./notify.js";

export interface AlertDeps {
  prisma: PrismaClient;
  mailer: Mailer;
  webOrigin: string;
  // Opens channel settings and signs acknowledge links.
  encryptionKey: Buffer;
  // Queues the next escalation step, due after delayMs.
  scheduleEscalation: (job: EscalationJob, delayMs: number) => Promise<unknown>;
  transport?: Transport;
  // Waits between delivery retries; tests make it instant.
  wait?: (ms: number) => Promise<void>;
}

// Someone or something to alert. `by` names them in acknowledge links and dedupes:
// "u:<user id>" or "c:<channel id>".
type Recipient =
  | { kind: "email"; by: string; email: string }
  | { kind: "channel"; by: string; channel: NotificationChannel };

const CHANNEL_WORDS = { SLACK: "Slack", TELEGRAM: "Telegram", WEBHOOK: "the webhook" };
const describe = (r: Recipient) =>
  r.kind === "email" ? r.email : `${CHANNEL_WORDS[r.channel.type]} "${r.channel.name}"`;

const incidentInclude = {
  monitor: {
    select: {
      id: true,
      name: true,
      target: true,
      ownerId: true,
      owner: { select: { email: true, suspendedAt: true } },
      escalationPolicy: { select: { name: true, steps: true, teamId: true } },
    },
  },
} as const;

type LoadedIncident = NonNullable<Awaited<ReturnType<typeof loadIncident>>>;

function loadIncident(prisma: PrismaClient, id: string) {
  return prisma.incident.findUnique({ where: { id }, include: incidentInclude });
}

// Without a policy: the owner by email, and every channel they haven't switched off.
async function everyone(prisma: PrismaClient, ownerId: string, ownerEmail: string) {
  const channels = await prisma.notificationChannel.findMany({
    where: { ownerId, enabled: true },
    orderBy: { createdAt: "asc" },
  });
  return [
    { kind: "email", by: `u:${ownerId}`, email: ownerEmail } as Recipient,
    ...channels.map((channel): Recipient => ({ kind: "channel", by: `c:${channel.id}`, channel })),
  ];
}

// One step's targets, as they are now: a member who left the team, or a channel that
// was deleted or switched off since the policy was written, is skipped.
async function stepRecipients(
  prisma: PrismaClient,
  ownerId: string,
  teamId: string,
  step: EscalationStep,
): Promise<Recipient[]> {
  const userIds = step.targets.flatMap((t) => (t.kind === "member" ? [t.userId] : []));
  const channelIds = step.targets.flatMap((t) => (t.kind === "channel" ? [t.channelId] : []));
  const [members, channels] = await Promise.all([
    prisma.teamMember.findMany({
      where: { teamId, userId: { in: userIds } },
      select: { user: { select: { id: true, email: true } } },
    }),
    prisma.notificationChannel.findMany({
      where: { id: { in: channelIds }, ownerId, enabled: true },
    }),
  ]);
  return [
    ...members.map(({ user }): Recipient => ({
      kind: "email",
      by: `u:${user.id}`,
      email: user.email,
    })),
    ...channels.map((channel): Recipient => ({ kind: "channel", by: `c:${channel.id}`, channel })),
  ];
}

function unique(recipients: Recipient[]) {
  const seen = new Set<string>();
  return recipients.filter((r) => !seen.has(r.by) && seen.add(r.by));
}

// Sends one alert to each recipient. A failure is recorded and doesn't stop the rest:
// retrying the whole job would alert everyone who did get it a second time.
async function sendAll(
  deps: AlertDeps,
  recipients: Recipient[],
  build: (r: Recipient) => { mail: Omit<Mail, "to">; message: AlertMessage },
  incidentId: string | null,
) {
  const { prisma, mailer, encryptionKey, transport, wait = sleep } = deps;
  for (const recipient of recipients) {
    const { mail, message } = build(recipient);
    let problem: string | null = null;
    try {
      if (recipient.kind === "email") {
        await withRetries(() => mailer.send({ to: recipient.email, ...mail }), wait);
      } else {
        await deliver(recipient.channel, message, encryptionKey, { transport, wait });
      }
    } catch (err) {
      problem = err instanceof DeliveryError ? err.message : `Couldn't send: ${String(err)}`;
      console.error(`alert to ${describe(recipient)} failed:`, problem);
    }

    if (recipient.kind === "channel") {
      await prisma.notificationChannel.updateMany({
        where: { id: recipient.channel.id },
        data: { lastSentAt: new Date(), lastError: problem },
      });
    }
    if (incidentId) {
      const how =
        recipient.kind === "email"
          ? `Emailed ${recipient.email}`
          : `Sent to ${describe(recipient)}`;
      await event(
        prisma,
        incidentId,
        problem ? "NOT_DELIVERED" : "NOTIFIED",
        problem ? `Couldn't reach ${describe(recipient)}: ${problem}` : how,
      );
    }
  }
}

// Email gets the same patience as webhooks: three tries, a mail server hiccup is common.
async function withRetries(send: () => Promise<void>, wait: (ms: number) => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (attempt === 3) throw err;
      await wait(1000 * 2 ** (attempt - 1));
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function event(prisma: PrismaClient, incidentId: string, type: IncidentEventType, detail: string) {
  return prisma.incidentEvent.create({ data: { incidentId, type, detail } });
}

function incidentMessage(
  deps: AlertDeps,
  incident: LoadedIncident,
  kind: "down" | "up",
  recipient: Recipient,
  options: { escalated?: boolean; note?: string | null } = {},
) {
  const { monitor } = incident;
  const ack =
    kind === "down" ? ackLink(deps.webOrigin, deps.encryptionKey, incident.id, recipient.by) : null;
  const resolvedAt = incident.resolvedAt ?? new Date();
  const fields: [string, string][] =
    kind === "down"
      ? [
          ["Cause", incident.cause ?? "No response"],
          ["Since", formatUtc(incident.startedAt)],
        ]
      : [
          ["Downtime", formatDuration(resolvedAt.getTime() - incident.startedAt.getTime())],
          ["Down from", formatUtc(incident.startedAt)],
        ];
  if (monitor.target) fields.unshift(["Target", monitor.target]);

  const mail = incidentEmail(kind, incident, deps.webOrigin, { ackLink: ack, ...options });
  const message: AlertMessage = {
    kind,
    title: mail.subject,
    monitor: { id: monitor.id, name: monitor.name, target: monitor.target },
    fields,
    note: options.note ?? null,
    link: `${deps.webOrigin}/incidents/${incident.id}`,
    ackLink: ack,
    incidentId: incident.id,
    at: new Date(),
  };
  return { mail, message };
}

// What the first alert promises about the next step, if there is one.
function nextStepNote(steps: EscalationStep[], after: number): string | null {
  const next = steps[after + 1];
  if (!next) return null;
  return `If nobody acknowledges it within ${next.waitMinutes} min, Lanternly alerts the next people on call.`;
}

// Runs from the notifications queue: an incident opened or closed, or a monitor got slow.
export async function sendNotification(job: NotificationJob, deps: AlertDeps) {
  const { prisma } = deps;

  if (job.kind === "degraded") {
    const check = await prisma.checkResult.findUnique({
      where: { id: BigInt(job.checkId) },
      include: {
        monitor: {
          select: {
            id: true,
            name: true,
            target: true,
            ownerId: true,
            owner: { select: { email: true, suspendedAt: true } },
          },
        },
      },
    });
    // Deleted with its monitor, or rolled up into hourly totals already. A suspended
    // account hears nothing until an admin lets it back in.
    if (!check || check.monitor.owner.suspendedAt) return;
    const { monitor } = check;
    const mail = slowEmail(check, deps.webOrigin);
    const message: AlertMessage = {
      kind: "degraded",
      title: mail.subject,
      monitor: { id: monitor.id, name: monitor.name, target: monitor.target },
      fields: [["Detail", check.error ?? "Slower than its threshold"]],
      note: "It's still answering, so no incident is open.",
      link: `${deps.webOrigin}/monitors/${monitor.id}`,
      ackLink: null,
      incidentId: null,
      at: check.checkedAt,
    };
    // Slowness never escalates: it goes to the usual places only.
    await sendAll(
      deps,
      await everyone(prisma, monitor.ownerId, monitor.owner.email),
      () => ({ mail, message }),
      null,
    );
    return;
  }

  const incident = await loadIncident(prisma, job.incidentId);
  // The monitor (and with it the incident) was deleted before the alert went out.
  if (!incident || incident.monitor.owner.suspendedAt) return;
  const { monitor } = incident;
  const policy = monitor.escalationPolicy;
  const steps = readSteps(policy?.steps);

  if (job.kind === "down") {
    if (!policy || steps.length === 0) {
      const recipients = await everyone(prisma, monitor.ownerId, monitor.owner.email);
      await sendAll(
        deps,
        recipients,
        (r) => incidentMessage(deps, incident, "down", r),
        incident.id,
      );
      return;
    }
    const note = nextStepNote(steps, 0);
    const recipients = await stepRecipients(prisma, monitor.ownerId, policy.teamId, steps[0]!);
    await sendAll(
      deps,
      recipients,
      (r) => incidentMessage(deps, incident, "down", r, { note }),
      incident.id,
    );
    if (steps[1]) {
      await deps.scheduleEscalation(
        { incidentId: incident.id, step: 1 },
        steps[1].waitMinutes * 60_000,
      );
    }
    return;
  }

  // Back up: everyone who heard it was down hears it's over.
  const recipients =
    policy && steps.length > 0
      ? unique(
          (
            await Promise.all(
              steps
                .slice(0, incident.escalationStep + 1)
                .map((step) => stepRecipients(prisma, monitor.ownerId, policy.teamId, step)),
            )
          ).flat(),
        )
      : await everyone(prisma, monitor.ownerId, monitor.owner.email);
  await sendAll(deps, recipients, (r) => incidentMessage(deps, incident, "up", r), incident.id);
}

// Runs when a step's wait is over. Nothing happens if the incident was acknowledged
// or resolved meanwhile, or if this step already went out (a retried job).
export async function escalate(job: EscalationJob, deps: AlertDeps) {
  const { prisma } = deps;
  const incident = await loadIncident(prisma, job.incidentId);
  if (!incident || incident.resolvedAt || incident.acknowledgedAt) return;
  if (incident.monitor.owner.suspendedAt) return;
  const policy = incident.monitor.escalationPolicy;
  const steps = readSteps(policy?.steps);
  const step = steps[job.step];
  if (!policy || !step) return;

  // Claims the step: only one run moves escalationStep forward to it.
  const { count } = await prisma.incident.updateMany({
    where: {
      id: incident.id,
      escalationStep: { lt: job.step },
      acknowledgedAt: null,
      resolvedAt: null,
    },
    data: { escalationStep: job.step },
  });
  if (count === 0) return;

  await event(
    prisma,
    incident.id,
    "ESCALATED",
    `Nobody acknowledged it within ${step.waitMinutes} min; alerting step ${job.step + 1} of "${policy.name}"`,
  );
  const note = nextStepNote(steps, job.step) ?? "This is the last step of the escalation policy.";
  const recipients = await stepRecipients(prisma, incident.monitor.ownerId, policy.teamId, step);
  await sendAll(
    deps,
    recipients,
    (r) => incidentMessage(deps, incident, "down", r, { escalated: true, note }),
    incident.id,
  );
  const next = steps[job.step + 1];
  if (next) {
    await deps.scheduleEscalation(
      { incidentId: incident.id, step: job.step + 1 },
      next.waitMinutes * 60_000,
    );
  }
}
