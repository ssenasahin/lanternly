// The two BullMQ queues and how monitors map onto them. The API changes a monitor's
// schedule the moment it's edited; the worker consumes the jobs and, on start-up,
// repairs any schedule the API couldn't update (say, because Redis was down).
import type { Queue } from "bullmq";
import { Redis } from "ioredis";

export const CHECKS_QUEUE = "checks";
export const NOTIFICATIONS_QUEUE = "notifications";

// BullMQ wants a ready-made client in an ES module project. The worker waits out a
// Redis restart (maxRetriesPerRequest: null) rather than failing every job; the API
// fails fast instead, so saving a monitor never hangs on an unreachable Redis.
export function redisConnection(url: string, { failFast = false } = {}): Redis {
  return new Redis(
    url,
    failFast
      ? { maxRetriesPerRequest: 1, enableOfflineQueue: false }
      : { maxRetriesPerRequest: null },
  );
}

export interface CheckJob {
  monitorId: string;
}

export interface NotificationJob {
  kind: "down" | "up";
  incidentId: string;
}

export interface ScheduledMonitor {
  id: string;
  intervalSec: number;
  isActive: boolean;
}

export interface MonitorScheduler {
  // Starts, reschedules or stops checks to match the monitor as it is now.
  sync(monitor: ScheduledMonitor): Promise<void>;
  remove(monitorId: string): Promise<void>;
}

// One BullMQ job scheduler per monitor. Upserting under a fixed key means saving a
// monitor twice replaces its schedule instead of running it twice as often.
export function schedulerKey(monitorId: string): string {
  return `monitor:${monitorId}`;
}

export function queueScheduler(queue: Queue<CheckJob>): MonitorScheduler {
  return {
    async sync(monitor) {
      if (!monitor.isActive) {
        await queue.removeJobScheduler(schedulerKey(monitor.id));
        return;
      }
      await queue.upsertJobScheduler(
        schedulerKey(monitor.id),
        { every: monitor.intervalSec * 1000 },
        {
          name: "check",
          data: { monitorId: monitor.id },
          // Results live in Postgres; Redis only needs to remember recent failures.
          opts: { removeOnComplete: true, removeOnFail: { age: 24 * 60 * 60 } },
        },
      );
    },
    async remove(monitorId) {
      await queue.removeJobScheduler(schedulerKey(monitorId));
    },
  };
}
