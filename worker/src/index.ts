// Runs checks, opens and closes incidents, and sends notifications.
import {
  CHECKS_QUEUE,
  NOTIFICATIONS_QUEUE,
  prisma,
  redisConnection,
  smtpMailer,
  type CheckJob,
  type NotificationJob,
} from "@lanternly/db";
import { Queue, Worker } from "bullmq";
import { loadEnv } from "./env.js";
import { sendIncidentEmail } from "./notify.js";
import { processCheck } from "./process-check.js";
import { rollUpOldChecks } from "./rollup.js";
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

// Every night at 03:00, server time, when traffic is lowest.
await maintenance.upsertJobScheduler(
  "roll-up-checks",
  { pattern: "0 3 * * *" },
  { name: "roll-up-checks", opts: { removeOnComplete: true, removeOnFail: { count: 30 } } },
);

const checkWorker = new Worker<CheckJob>(
  CHECKS_QUEUE,
  (job) =>
    processCheck(job.data.monitorId, {
      prisma,
      notify: (alert) =>
        notifications.add(alert.kind, alert, {
          // One email per incident and direction, even if a check job is retried.
          jobId: `${alert.kind}-${alert.incidentId}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: true,
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        }),
    }),
  { connection, concurrency: env.CHECK_CONCURRENCY },
);

const notificationWorker = new Worker<NotificationJob>(
  NOTIFICATIONS_QUEUE,
  (job) => sendIncidentEmail(job.data, { prisma, mailer, webOrigin: env.WEB_ORIGIN }),
  { connection },
);

const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE,
  async () => {
    const { cutoff, hours } = await rollUpOldChecks(prisma);
    console.log(`rolled up ${hours} monitor-hours of results older than ${cutoff.toISOString()}`);
  },
  { connection },
);

for (const worker of [checkWorker, notificationWorker, maintenanceWorker]) {
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
  await Promise.all([checkWorker.close(), notificationWorker.close(), maintenanceWorker.close()]);
  await Promise.all([
    checks.close(),
    notifications.close(),
    maintenance.close(),
    prisma.$disconnect(),
  ]);
  await connection.quit();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
