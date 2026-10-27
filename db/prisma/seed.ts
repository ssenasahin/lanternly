// Fills a fresh database with a demo account and a handful of realistic monitors,
// so the dashboard has something to show the first time it opens.
import { PrismaClient, MonitorType } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@lanternly.dev";

const monitors = [
  {
    name: "Marketing site",
    type: MonitorType.HTTP,
    target: "https://example.com",
    intervalSec: 60,
  },
  {
    name: "Public API",
    type: MonitorType.HTTP,
    target: "https://httpbin.org/status/200",
    intervalSec: 60,
  },
  { name: "Docs", type: MonitorType.HTTP, target: "https://www.wikipedia.org", intervalSec: 120 },
  {
    name: "Status JSON",
    type: MonitorType.HTTP,
    target: "https://httpbin.org/json",
    intervalSec: 300,
  },
  { name: "Edge resolver", type: MonitorType.PING, target: "1.1.1.1", intervalSec: 60 },
];

async function main() {
  // The demo password comes from the environment so no credential lives in the repo.
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password) {
    throw new Error("Set SEED_DEMO_PASSWORD in .env before seeding.");
  }

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: { email: DEMO_EMAIL, passwordHash: await argon2.hash(password) },
  });

  // Re-running the seed replaces the demo monitors instead of duplicating them.
  await prisma.monitor.deleteMany({ where: { ownerId: user.id } });
  await prisma.monitor.createMany({
    data: monitors.map((m) => ({ ...m, ownerId: user.id })),
  });

  console.log(`Seeded ${DEMO_EMAIL} with ${monitors.length} monitors.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
