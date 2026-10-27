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
import { reconcileSchedules } from "./schedule.js";

const RECONCILE_EVERY_MS = 5 * 60 * 1000;

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

for (const worker of [checkWorker, notificationWorker]) {
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
  await Promise.all([checkWorker.close(), notificationWorker.close()]);
  await Promise.all([checks.close(), notifications.close(), prisma.$disconnect()]);
  await connection.quit();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
