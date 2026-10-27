import {
  expectedBy,
  lateAfter,
  type Attempt,
  type HeartbeatPing,
  type NotificationJob,
  type PrismaClient,
} from "@lanternly/db";
import { formatDuration, formatUtc } from "./notify.js";
import { recordCheck } from "./record.js";

export interface HeartbeatDeps {
  prisma: PrismaClient;
  notify: (job: NotificationJob) => Promise<unknown>;
}

// A run is slow when it takes more than twice the average of the runs before it.
const SLOW_FACTOR = 2;
const SLOW_SAMPLE = 20;
// Too few runs make a meaningless average; the first few are never called slow.
const SLOW_MIN_SAMPLES = 5;

const firstLine = (text: string | null) => text?.trim().split("\n", 1)[0]?.slice(0, 200) || null;

// A failure ping: the job ran and said it went wrong. Its output's first line is
// usually the error, and the best summary for the incident.
function failedRun(ping: HeartbeatPing): Attempt {
  const detail = firstLine(ping.body);
  return {
    status: "DOWN",
    responseMs: ping.durationMs,
    statusCode: null,
    error: detail ? `The job reported a failure: ${detail}` : "The job reported a failure",
  };
}

// A success ping, compared with the runs before it when it was timed.
async function finishedRun(prisma: PrismaClient, ping: HeartbeatPing): Promise<Attempt> {
  const ok: Attempt = { status: "UP", responseMs: ping.durationMs, statusCode: null, error: null };
  if (ping.durationMs === null) return ok;

  const previous = await prisma.heartbeatPing.findMany({
    where: {
      monitorId: ping.monitorId,
      kind: "SUCCESS",
      durationMs: { not: null },
      id: { lt: ping.id },
    },
    orderBy: { id: "desc" },
    take: SLOW_SAMPLE,
    select: { durationMs: true },
  });
  if (previous.length < SLOW_MIN_SAMPLES) return ok;

  const usual = previous.reduce((sum, p) => sum + p.durationMs!, 0) / previous.length;
  if (ping.durationMs <= usual * SLOW_FACTOR) return ok;
  return {
    ...ok,
    status: "DEGRADED",
    error: `Ran for ${formatDuration(ping.durationMs)}, more than twice the usual ${formatDuration(usual)}`,
  };
}

// Applies one received ping to its heartbeat. The API has already stored it and moved
// the heartbeat's clock; this is the part that changes state and may alert.
export async function processPing(pingId: string, { prisma, notify }: HeartbeatDeps) {
  const ping = await prisma.heartbeatPing.findUnique({
    where: { id: BigInt(pingId) },
    include: {
      heartbeat: { select: { monitor: { select: { id: true, status: true, isActive: true } } } },
    },
  });
  // Deleted with its heartbeat; or paused, when pings are logged but change nothing.
  if (!ping || !ping.heartbeat.monitor.isActive) return;
  // A start ping only starts the clock, which the API did.
  if (ping.kind === "START") return;

  const { monitor } = ping.heartbeat;
  const result = ping.kind === "FAIL" ? failedRun(ping) : await finishedRun(prisma, ping);
  const alert = await recordCheck(prisma, monitor.id, monitor.status, result, {
    now: ping.receivedAt,
  });
  if (alert) await notify(alert);
}

// Runs every minute: any heartbeat whose ping is overdue by more than its grace
// period goes down, through the same state machine as a failed check. Only
// heartbeats that are up (or slow) are looked at: one that is down already has its
// incident, and one that is pending, new or just resumed, waits for its first ping.
export async function markLateHeartbeats({ prisma, notify }: HeartbeatDeps, now = new Date()) {
  const watched = await prisma.heartbeat.findMany({
    where: {
      lastPingAt: { not: null },
      monitor: { isActive: true, status: { in: ["UP", "DEGRADED"] } },
    },
    include: { monitor: { select: { status: true } } },
  });

  let late = 0;
  for (const heartbeat of watched) {
    const lastPingAt = heartbeat.lastPingAt!;
    if (now <= lateAfter(heartbeat, lastPingAt)) continue;

    const missed: Attempt = {
      status: "DOWN",
      responseMs: null,
      statusCode: null,
      error: `No ping since ${formatUtc(lastPingAt)}; one was due by ${formatUtc(expectedBy(heartbeat, lastPingAt))}`,
    };
    const alert = await recordCheck(prisma, heartbeat.monitorId, heartbeat.monitor.status, missed, {
      now,
      // A ping that landed after we read the heartbeat means it isn't late after all.
      stillValid: async (tx) => {
        const current = await tx.heartbeat.findUnique({
          where: { monitorId: heartbeat.monitorId },
          select: { lastPingAt: true },
        });
        return current?.lastPingAt?.getTime() === lastPingAt.getTime();
      },
    });
    if (alert) {
      late++;
      await notify(alert);
    }
  }
  return late;
}
