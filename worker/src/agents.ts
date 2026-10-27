import type { Attempt, NotificationJob, PrismaClient } from "@lanternly/db";
import { formatUtc } from "./notify.js";
import { recordCheck } from "./record.js";

export interface AgentDeps {
  prisma: PrismaClient;
  notify: (job: NotificationJob) => Promise<unknown>;
}

// Above this, a disk is full enough to wake someone.
export const DISK_LIMIT = 90;
// Above this for CPU_MINUTES on end, the server is struggling, not just busy.
export const CPU_LIMIT = 90;
export const CPU_MINUTES = 5;
// Agents report every minute; three missed reports means it's gone.
export const SILENT_AFTER_MS = 3 * 60_000;

export interface Sample {
  at: Date;
  cpu: number;
  memory: number;
  disk: number;
}

const round = (n: number) => Math.round(n);

// Judges a server from its recent samples, oldest first. Pure, so the thresholds
// can be pinned down by tests.
export function judge(samples: Sample[], now: Date): Attempt {
  const ok: Attempt = { status: "UP", responseMs: null, statusCode: null, error: null };
  const latest = samples.at(-1);
  if (!latest) return ok;

  if (latest.disk > DISK_LIMIT) {
    return {
      ...ok,
      status: "DOWN",
      error: `Disk ${round(latest.disk)}% full, over the ${DISK_LIMIT}% limit`,
    };
  }

  // A spike is normal. Only a run of busy samples covering the whole window counts:
  // every sample in it over the limit, and the first one at least the window's
  // length (less one report) back.
  const since = now.getTime() - CPU_MINUTES * 60_000;
  const recent = samples.filter((s) => s.at.getTime() >= since);
  const span = recent.length > 0 ? latest.at.getTime() - recent[0]!.at.getTime() : 0;
  if (span >= (CPU_MINUTES - 1) * 60_000 && recent.every((s) => s.cpu > CPU_LIMIT)) {
    const average = recent.reduce((sum, s) => sum + s.cpu, 0) / recent.length;
    return {
      ...ok,
      status: "DOWN",
      error: `CPU over ${CPU_LIMIT}% for ${CPU_MINUTES} minutes (${round(average)}% on average)`,
    };
  }
  return ok;
}

// Runs after the API stores a report: the newest samples decide the server's state,
// through the same state machine as any check.
export async function evaluateAgent(
  agentId: string,
  { prisma, notify }: AgentDeps,
  now = new Date(),
) {
  const agent = await prisma.agent.findUnique({
    where: { monitorId: agentId },
    include: { monitor: { select: { status: true, isActive: true } } },
  });
  if (!agent || !agent.monitor.isActive) return;

  const samples = await prisma.agentMetric.findMany({
    where: { agentId, at: { gte: new Date(now.getTime() - (CPU_MINUTES + 1) * 60_000) } },
    orderBy: { at: "asc" },
  });
  const alert = await recordCheck(prisma, agentId, agent.monitor.status, judge(samples, now), {
    now,
  });
  if (alert) await notify(alert);
}

// Samples are kept for the 30 days the charts can show.
export async function pruneOldAgentMetrics(prisma: PrismaClient, now = new Date()) {
  const { count } = await prisma.agentMetric.deleteMany({
    where: { at: { lt: new Date(now.getTime() - 30 * 24 * 60 * 60_000) } },
  });
  return count;
}

// Runs every minute: an agent that stopped reporting goes down. Like heartbeats,
// only agents that are up are looked at: one already down has its incident, and a
// new one waits for its first report.
export async function markSilentAgents({ prisma, notify }: AgentDeps, now = new Date()) {
  const silent = await prisma.agent.findMany({
    where: {
      lastSeenAt: { lt: new Date(now.getTime() - SILENT_AFTER_MS) },
      monitor: { isActive: true, status: { in: ["UP", "DEGRADED"] } },
    },
    include: { monitor: { select: { status: true } } },
  });

  let count = 0;
  for (const agent of silent) {
    const lastSeenAt = agent.lastSeenAt!;
    const missed: Attempt = {
      status: "DOWN",
      responseMs: null,
      statusCode: null,
      error: `No report since ${formatUtc(lastSeenAt)}: the agent stopped, or the server is down`,
    };
    const alert = await recordCheck(prisma, agent.monitorId, agent.monitor.status, missed, {
      now,
      // A report that landed after we looked means it isn't silent after all.
      stillValid: async (tx) => {
        const current = await tx.agent.findUnique({
          where: { monitorId: agent.monitorId },
          select: { lastSeenAt: true },
        });
        return current?.lastSeenAt?.getTime() === lastSeenAt.getTime();
      },
    });
    if (alert) {
      count++;
      await notify(alert);
    }
  }
  return count;
}
