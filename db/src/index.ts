import { PrismaClient } from "@prisma/client";

// Besides the Prisma client, this package holds the code the API and the worker share.
export * from "@prisma/client";
export { decryptSecret, encryptSecret, parseEncryptionKey } from "./crypto.js";
export {
  emailLayout,
  escapeHtml,
  smtpMailer,
  type Mail,
  type Mailer,
  type SmtpConfig,
} from "./mailer.js";
export {
  isPublicAddress,
  resolveHost,
  resolvePublicHost,
  UnsafeTargetError,
  type ResolveHost,
} from "./network.js";
export {
  CHECKS_QUEUE,
  NOTIFICATIONS_QUEUE,
  queueScheduler,
  redisConnection,
  schedulerKey,
  type CheckJob,
  type MonitorScheduler,
  type NotificationJob,
  type ScheduledMonitor,
} from "./queues.js";

// One client per process: each PrismaClient holds its own connection pool.
export const prisma = new PrismaClient();
