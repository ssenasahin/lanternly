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
  checkApi,
  MAX_RESPONSE_BYTES,
  type ApiAttempt,
  type ApiRequestSpec,
} from "./checks/api.js";
export { checkHttp } from "./checks/http.js";
export {
  describeFailure,
  PRESENCE,
  ruleProblem,
  type Operator,
  type Rule,
  type RuleResult,
} from "./checks/rules.js";
export { acceptsStatus, normaliseStatusCodes, statusCodesProblem } from "./checks/status-codes.js";
export { openHeaders, sealHeaders, toApiSpec, type StoredHeader } from "./checks/stored.js";
export { failed, markSlow, type Attempt, type Resolve } from "./checks/types.js";
export {
  cronProblem,
  expectedBy,
  isTimeZone,
  lateAfter,
  nextRuns,
  type HeartbeatSchedule,
} from "./heartbeats.js";
export {
  CHECKS_QUEUE,
  HEARTBEATS_QUEUE,
  isScheduled,
  NOTIFICATIONS_QUEUE,
  notificationJobId,
  queuePings,
  queueScheduler,
  redisConnection,
  schedulerKey,
  type CheckJob,
  type MonitorScheduler,
  type NotificationJob,
  type PingJob,
  type PingQueue,
  type ScheduledMonitor,
} from "./queues.js";

// One client per process: each PrismaClient holds its own connection pool.
export const prisma = new PrismaClient();
