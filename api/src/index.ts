import {
  AGENTS_QUEUE,
  CHECKS_QUEUE,
  ESCALATIONS_QUEUE,
  HEARTBEATS_QUEUE,
  prisma,
  queueAgentReports,
  queueEscalationCanceller,
  queuePings,
  queueScheduler,
  redisConnection,
  smtpMailer,
  type CheckJob,
  type PingJob,
} from "@lanternly/db";
import { Queue } from "bullmq";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const mailer = smtpMailer({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  user: env.SMTP_USER,
  pass: env.SMTP_PASS,
  from: env.MAIL_FROM,
});
const redis = redisConnection(env.REDIS_URL, { failFast: true });
// Without a listener, a lost Redis connection would crash the process.
redis.on("error", (err) => console.error("redis:", err.message));
const checks = new Queue<CheckJob>(CHECKS_QUEUE, { connection: redis });
const heartbeats = new Queue<PingJob>(HEARTBEATS_QUEUE, { connection: redis });
const escalations = new Queue(ESCALATIONS_QUEUE, { connection: redis });
const agents = new Queue(AGENTS_QUEUE, { connection: redis });
const app = createApp({
  env,
  prisma,
  mailer,
  scheduler: queueScheduler(checks),
  pings: queuePings(heartbeats),
  escalations: queueEscalationCanceller(escalations),
  agentReports: queueAgentReports(agents),
});

const server = app.listen(env.API_PORT, () => {
  console.log(`lanternly api listening on http://localhost:${env.API_PORT}`);
});

// Finish in-flight requests and close database connections before exiting.
function shutdown() {
  server.close(() => {
    void Promise.all([
      Promise.all([checks.close(), heartbeats.close(), escalations.close(), agents.close()]).then(
        () => redis.quit(),
      ),
      prisma.$disconnect(),
    ]).then(() => process.exit(0));
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
