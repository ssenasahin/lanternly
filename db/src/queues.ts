// The BullMQ queues and how monitors map onto them. The API changes a monitor's
// schedule the moment it's edited; the worker consumes the jobs and, on start-up,
// repairs any schedule the API couldn't update (say, because Redis was down).
import type { Queue } from "bullmq";
import { Redis } from "ioredis";

export const CHECKS_QUEUE = "checks";
export const NOTIFICATIONS_QUEUE = "notifications";
// Pings to apply to their heartbeat, plus the once-a-minute search for silent ones.
export const HEARTBEATS_QUEUE = "heartbeats";

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

// "down" and "up" follow an incident; "degraded" is a warning about one check (slow,
// but answering) and opens no incident.
export type NotificationJob =
  { kind: "down" | "up"; incidentId: string } | { kind: "degraded"; checkId: string };

// One email per incident and direction, or per slow check, even if the job that
// raised it is retried.
export function notificationJobId(job: NotificationJob): string {
  return job.kind === "degraded" ? `degraded-${job.checkId}` : `${job.kind}-${job.incidentId}`;
}

export interface PingJob {
  // HeartbeatPing ids are BigInts; queues carry JSON, so it travels as a string.
  pingId: string;
}

// Hands a received ping to the worker, which applies it to the heartbeat's state.
export interface PingQueue {
  add(job: PingJob): Promise<void>;
}

export function queuePings(queue: Queue<PingJob>): PingQueue {
  return {
    async add(job) {
      await queue.add("ping", job, {
        jobId: `ping-${job.pingId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 60 * 60 },
      });
    },
  };
}

export interface ScheduledMonitor {
  id: string;
  type: "HTTP" | "API" | "PING" | "HEARTBEAT";
  intervalSec: number;
  isActive: boolean;
}

// Heartbeats are never checked on a schedule: they wait for the job to ping them.
export function isScheduled(monitor: Pick<ScheduledMonitor, "type" | "isActive">): boolean {
  return monitor.isActive && monitor.type !== "HEARTBEAT";
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
      if (!isScheduled(monitor)) {
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
