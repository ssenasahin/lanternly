// Runs checks, opens and closes incidents, and sends notifications.
import {
  CHECKS_QUEUE,
  HEARTBEATS_QUEUE,
  NOTIFICATIONS_QUEUE,
  notificationJobId,
  prisma,
  redisConnection,
  smtpMailer,
  type CheckJob,
  type NotificationJob,
  type PingJob,
} from "@lanternly/db";
import { Queue, Worker } from "bullmq";
import { loadEnv } from "./env.js";
import { markLateHeartbeats, processPing } from "./heartbeats.js";
import { sendNotification } from "./notify.js";
import { processCheck } from "./process-check.js";
import { pruneOldPings, rollUpOldChecks } from "./rollup.js";
import { reconcileSchedules } from "./schedule.js";

const RECONCILE_EVERY_MS = 5 * 60 * 1000;
// Housekeeping that runs on a clock rather than per monitor.
const MAINTENANCE_QUEUE = "maintenance";

const env = loadEnv();
const connection = redisConnection(env.REDIS_URL);
connection.on("error", (err) => console.error("redis:", err.message));
const mailer = smtpMailer({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  user: env.SMTP_USER,
  pass: env.SMTP_PASS,
  from: env.MAIL_FROM,
});

const checks = new Queue<CheckJob>(CHECKS_QUEUE, { connection });
const notifications = new Queue<NotificationJob>(NOTIFICATIONS_QUEUE, { connection });
const maintenance = new Queue(MAINTENANCE_QUEUE, { connection });
const heartbeats = new Queue<PingJob>(HEARTBEATS_QUEUE, { connection });

const notify = (alert: NotificationJob) =>
  notifications.add(alert.kind, alert, {
    jobId: notificationJobId(alert),
    attempts: 5,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  });

// Every night at 03:00, server time, when traffic is lowest.
await maintenance.upsertJobScheduler(
  "roll-up-checks",
  { pattern: "0 3 * * *" },
  { name: "roll-up-checks", opts: { removeOnComplete: true, removeOnFail: { count: 30 } } },
);
// Silent heartbeats are looked for every minute, so an alert is at most a minute late.
await heartbeats.upsertJobScheduler(
  "find-late-heartbeats",
  { every: 60_000 },
  { name: "find-late", opts: { removeOnComplete: true, removeOnFail: { count: 30 } } },
);

const checkWorker = new Worker<CheckJob>(
  CHECKS_QUEUE,
  (job) => processCheck(job.data.monitorId, { prisma, notify }),
  { connection, concurrency: env.CHECK_CONCURRENCY },
);

// One job at a time, so pings apply in the order they arrived: a start and a success
// sent a second apart must not be read the other way round. Each is a few queries.
const heartbeatWorker = new Worker<PingJob>(
  HEARTBEATS_QUEUE,
  async (job) => {
    if (job.name === "ping") {
      await processPing(job.data.pingId, { prisma, notify });
      return;
    }
    const late = await markLateHeartbeats({ prisma, notify });
    if (late > 0) console.log(`${late} heartbeats went quiet`);
  },
  { connection },
);

const notificationWorker = new Worker<NotificationJob>(
  NOTIFICATIONS_QUEUE,
  (job) => sendNotification(job.data, { prisma, mailer, webOrigin: env.WEB_ORIGIN }),
  { connection },
);

const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE,
  async () => {
    const { cutoff, hours } = await rollUpOldChecks(prisma);
    console.log(`rolled up ${hours} monitor-hours of results older than ${cutoff.toISOString()}`);
    const pings = await pruneOldPings(prisma);
    if (pings > 0) console.log(`deleted ${pings} heartbeat pings older than a month`);
  },
  { connection },
);

for (const worker of [checkWorker, notificationWorker, maintenanceWorker, heartbeatWorker]) {
  worker.on("failed", (job, err) => {
    console.error(`${worker.name} job ${job?.id ?? "?"} failed:`, err.message);
  });
}

async function reconcile() {
  try {
    const { active, changed } = await reconcileSchedules(prisma, checks);
    if (changed > 0) console.log(`schedules: ${active} active monitors, ${changed} updated`);
  } catch (err) {
    console.error("Couldn't reconcile check schedules:", err);
  }
}

await reconcile();
const timer = setInterval(() => void reconcile(), RECONCILE_EVERY_MS);
console.log(`lanternly worker running ${env.CHECK_CONCURRENCY} checks at a time`);

// Let running checks finish, then close Redis and database connections.
async function shutdown() {
  clearInterval(timer);
  await Promise.all([
    checkWorker.close(),
    notificationWorker.close(),
    maintenanceWorker.close(),
    heartbeatWorker.close(),
  ]);
  await Promise.all([
    checks.close(),
    notifications.close(),
    maintenance.close(),
    heartbeats.close(),
    prisma.$disconnect(),
  ]);
  await connection.quit();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
