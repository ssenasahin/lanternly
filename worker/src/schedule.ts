import { queueScheduler, schedulerKey, type CheckJob, type PrismaClient } from "@lanternly/db";
import type { Queue } from "bullmq";

// Makes Redis match the database: every active monitor has a schedule at its
// interval, and nothing else does. The API keeps them in step as monitors change;
// this repairs anything it missed, and rebuilds everything if Redis lost its data.
export async function reconcileSchedules(prisma: PrismaClient, queue: Queue<CheckJob>) {
  const scheduler = queueScheduler(queue);
  const active = await prisma.monitor.findMany({
    where: { isActive: true },
    select: { id: true, intervalSec: true, isActive: true },
  });
  const existing = new Map(
    (await queue.getJobSchedulers()).map((s) => [s.key, s.every ?? null] as const),
  );

  let changed = 0;
  for (const monitor of active) {
    // Upserting an unchanged schedule would restart its timer, so leave those alone.
    if (existing.get(schedulerKey(monitor.id)) === monitor.intervalSec * 1000) continue;
    await scheduler.sync(monitor);
    changed++;
  }

  const wanted = new Set(active.map((m) => schedulerKey(m.id)));
  for (const key of existing.keys()) {
    if (wanted.has(key)) continue;
    await queue.removeJobScheduler(key);
    changed++;
  }

  return { active: active.length, changed };
}
