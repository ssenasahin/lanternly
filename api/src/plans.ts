import type { PrismaClient } from "@lanternly/db";
import { HttpError } from "./http.js";

export interface Limits {
  plan: string;
  maxMonitors: number;
  maxChannels: number;
  maxApiKeys: number;
  minIntervalSec: number;
}

// Used only if the plans table has no default, which the migration makes unlikely.
export const BUILT_IN_LIMITS: Limits = {
  plan: "Built-in",
  maxMonitors: 50,
  maxChannels: 20,
  maxApiKeys: 10,
  minIntervalSec: 30,
};

const limitFields = {
  name: true,
  maxMonitors: true,
  maxChannels: true,
  maxApiKeys: true,
  minIntervalSec: true,
} as const;

// The account's own plan if an admin gave it one, otherwise the default plan.
export async function limitsOf(prisma: PrismaClient, userId: string): Promise<Limits> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: { select: limitFields } },
  });
  const plan =
    user?.plan ??
    (await prisma.plan.findFirst({ where: { isDefault: true }, select: limitFields }));
  if (!plan) return BUILT_IN_LIMITS;
  const { name, ...limits } = plan;
  return { plan: name, ...limits };
}

const COUNTERS = {
  monitors: {
    limit: (l: Limits) => l.maxMonitors,
    count: (p: PrismaClient, ownerId: string) => p.monitor.count({ where: { ownerId } }),
    message: (n: number) => `Your plan allows up to ${n} monitors`,
  },
  channels: {
    limit: (l: Limits) => l.maxChannels,
    count: (p: PrismaClient, ownerId: string) =>
      p.notificationChannel.count({ where: { ownerId } }),
    message: (n: number) => `Your plan allows up to ${n} channels`,
  },
  apiKeys: {
    limit: (l: Limits) => l.maxApiKeys,
    count: (p: PrismaClient, ownerId: string) =>
      p.apiKey.count({ where: { ownerId, revokedAt: null } }),
    message: (n: number) =>
      `Your plan allows up to ${n} active keys. Revoke one you no longer use.`,
  },
};

// Refuses to add one more of something once the plan's limit is reached.
export async function assertRoomFor(
  prisma: PrismaClient,
  userId: string,
  what: keyof typeof COUNTERS,
): Promise<Limits> {
  const limits = await limitsOf(prisma, userId);
  const counter = COUNTERS[what];
  const max = counter.limit(limits);
  if ((await counter.count(prisma, userId)) >= max) {
    throw new HttpError(403, counter.message(max));
  }
  return limits;
}

export function assertInterval(limits: Limits, intervalSec: number) {
  if (intervalSec < limits.minIntervalSec) {
    throw new HttpError(400, "Check less often", {
      intervalSec: [`Your plan checks at most every ${limits.minIntervalSec} seconds`],
    });
  }
}
