import { createPrisma } from "@lanternly/db";

// The same test database the API's tests use, never the development one.
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgresql://lanternly:lanternly@127.0.0.1:5432/lanternly_test";

export const prisma = createPrisma(TEST_DATABASE_URL);

export async function resetDatabase() {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");
}

// A user with one monitor, ready to be checked.
export async function makeMonitor(data: { type?: "HTTP" | "API" | "PING"; target: string }) {
  const owner = await prisma.user.create({
    data: { email: "ada@example.com", passwordHash: "not-a-real-hash" },
  });
  return prisma.monitor.create({
    data: { ownerId: owner.id, name: "Marketing site", type: "HTTP", retries: 0, ...data },
  });
}

// A user with one heartbeat that expects a ping every hour, with five minutes' grace.
export async function makeHeartbeat(
  data: { status?: "PENDING" | "UP" | "DOWN"; lastPingAt?: Date; isActive?: boolean } = {},
) {
  const owner = await prisma.user.create({
    data: { email: "ada@example.com", passwordHash: "not-a-real-hash" },
  });
  return prisma.monitor.create({
    data: {
      ownerId: owner.id,
      name: "Nightly backup",
      type: "HEARTBEAT",
      target: "",
      status: data.status ?? "UP",
      isActive: data.isActive ?? true,
      heartbeat: {
        create: {
          token: `token-${Math.random()}`,
          periodSec: 3600,
          graceSec: 300,
          lastPingAt: data.lastPingAt ?? null,
        },
      },
    },
  });
}
