import { Prisma, type NotificationJob, type PrismaClient } from "@lanternly/db";
import type { Attempt } from "./checks/types.js";
import { nextState, type MonitorStatus } from "./state.js";

// Prisma's defaults (wait 2 s for a connection, run for 5 s) are tight when many checks
// finish together and the pool has to open new connections.
const TRANSACTION_LIMITS = { maxWait: 10_000, timeout: 10_000 };

// Stores a check's result and applies the state machine, all in one transaction:
// the result, the monitor's new state and the incident change land together or not
// at all. Returns the alert to send, if the check opened or closed an incident.
export async function recordCheck(
  prisma: PrismaClient,
  monitorId: string,
  // The state the monitor was in when this check started.
  from: MonitorStatus,
  result: Attempt,
  now = new Date(),
): Promise<NotificationJob | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const transition = nextState(from, result.status);
      // Compare-and-set on the state the check started from, done first so it also
      // takes the row lock: an overlapping check for the same monitor waits here, then
      // finds the state already moved on. The same goes for a pause or an edit made
      // mid-check. Either way the result is kept, but it doesn't change the state.
      const { count } = await tx.monitor.updateMany({
        where: { id: monitorId, status: from },
        data: { status: transition.status, lastCheckedAt: now },
      });
      await tx.checkResult.create({ data: { monitorId, ...result, checkedAt: now } });
      if (count === 0) {
        await tx.monitor.updateMany({ where: { id: monitorId }, data: { lastCheckedAt: now } });
        return null;
      }

      if (transition.incident === "open") {
        const incident = await tx.incident.create({
          data: { monitorId, startedAt: now, cause: result.error },
        });
        return { kind: "down", incidentId: incident.id };
      }

      if (transition.incident === "resolve") {
        const open = await tx.incident.findFirst({
          where: { monitorId, resolvedAt: null },
          orderBy: { startedAt: "desc" },
        });
        if (!open) return null;
        await tx.incident.update({ where: { id: open.id }, data: { resolvedAt: now } });
        return { kind: "up", incidentId: open.id };
      }

      return null;
    }, TRANSACTION_LIMITS);
  } catch (err) {
    // The monitor was deleted while its check was running; there's nothing to record.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") return null;
    throw err;
  }
}
