import type { NotificationJob, PrismaClient } from "@lanternly/db";
import { runCheck } from "./checks/run.js";
import type { Resolve } from "./checks/types.js";
import { recordCheck } from "./record.js";

export interface CheckDeps {
  prisma: PrismaClient;
  notify: (job: NotificationJob) => Promise<unknown>;
  resolve?: Resolve;
}

// The whole life of one scheduled check: read the monitor as it is now, run it,
// record what happened, and queue an alert if an incident opened or closed.
export async function processCheck(monitorId: string, { prisma, notify, resolve }: CheckDeps) {
  const monitor = await prisma.monitor.findUnique({ where: { id: monitorId } });
  // Deleted or paused after this job was queued.
  if (!monitor || !monitor.isActive) return;
  // Heartbeats aren't checked; their pings and the lateness search drive them. A
  // stray job left from before a monitor's type changed has nothing to do.
  const { type } = monitor;
  if (type === "HEARTBEAT") return;

  const result = await runCheck({ ...monitor, type }, resolve);
  const alert = await recordCheck(prisma, monitor.id, monitor.status, result);
  if (alert) await notify(alert);
}
