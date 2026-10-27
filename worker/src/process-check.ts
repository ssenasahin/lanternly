import { toApiSpec, type NotificationJob, type PrismaClient, type Resolve } from "@lanternly/db";
import { runCheck } from "./checks/run.js";
import { recordCheck } from "./record.js";

export interface CheckDeps {
  prisma: PrismaClient;
  notify: (job: NotificationJob) => Promise<unknown>;
  // Opens an API monitor's stored headers.
  encryptionKey: Buffer;
  resolve?: Resolve;
}

// The whole life of one scheduled check: read the monitor as it is now, run it,
// record what happened, and queue an alert if an incident opened or closed.
export async function processCheck(
  monitorId: string,
  { prisma, notify, encryptionKey, resolve }: CheckDeps,
) {
  const monitor = await prisma.monitor.findUnique({
    where: { id: monitorId },
    include: {
      apiRequest: true,
      assertions: { orderBy: { position: "asc" } },
      dnsQuery: true,
    },
  });
  // Deleted or paused after this job was queued.
  if (!monitor || !monitor.isActive) return;
  // Heartbeats aren't checked; their pings and the lateness search drive them. A
  // stray job left from before a monitor's type changed has nothing to do.
  const { type, apiRequest, assertions, dnsQuery } = monitor;
  if (type === "HEARTBEAT" || type === "AGENT") return;

  const api =
    type === "API" && apiRequest
      ? toApiSpec(monitor.target, apiRequest, assertions, encryptionKey)
      : null;
  const dns = type === "DNS" ? (dnsQuery ?? null) : null;
  const result = await runCheck({ ...monitor, type, api, dns }, resolve);
  const alert = await recordCheck(prisma, monitor.id, monitor.status, result);
  if (alert) await notify(alert);
}
