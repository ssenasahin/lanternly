// Fills a fresh database with a demo account, a handful of realistic monitors and
// 30 days of history, so charts and uptime figures have something true-to-life to
// show the first time the dashboard opens.
import { MonitorType, PrismaClient, type Prisma } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@lanternly.dev";

interface Outage {
  daysAgo: number;
  minutes: number;
  cause: string;
}

interface DemoMonitor {
  name: string;
  type: MonitorType;
  target: string;
  intervalSec: number;
  // Typical response time; the history wanders around it.
  baseMs: number;
  outages: Outage[];
}

const monitors: DemoMonitor[] = [
  {
    name: "Marketing site",
    type: MonitorType.HTTP,
    target: "https://example.com/",
    intervalSec: 60,
    baseMs: 180,
    outages: [{ daysAgo: 12.4, minutes: 23, cause: "HTTP 502" }],
  },
  {
    name: "Public API",
    type: MonitorType.HTTP,
    target: "https://httpbin.org/status/200",
    intervalSec: 60,
    baseMs: 420,
    outages: [
      { daysAgo: 2.3, minutes: 14, cause: "Timed out after 10 s" },
      { daysAgo: 19.6, minutes: 41, cause: "HTTP 503" },
    ],
  },
  {
    name: "Docs",
    type: MonitorType.HTTP,
    target: "https://www.wikipedia.org/",
    intervalSec: 120,
    baseMs: 240,
    outages: [],
  },
  {
    name: "Status JSON",
    type: MonitorType.HTTP,
    target: "https://httpbin.org/json",
    intervalSec: 300,
    baseMs: 460,
    outages: [{ daysAgo: 0.25, minutes: 35, cause: "Connection refused" }],
  },
  {
    name: "Edge resolver",
    type: MonitorType.PING,
    target: "1.1.1.1",
    intervalSec: 60,
    baseMs: 14,
    outages: [{ daysAgo: 5.1, minutes: 6, cause: "No reply within 10 s" }],
  },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HISTORY_DAYS = 30;
// Matches the worker's nightly job: older results only survive as hourly rollups.
const RAW_DAYS = 7;

// A small seeded generator, so every run produces the same history.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// What an HTTP check would have recorded: 200 when up, the code from an "HTTP 502"
// cause when the server answered badly, nothing when it didn't answer at all.
function statusCode(m: DemoMonitor, outage: Outage | undefined): number | null {
  if (m.type !== MonitorType.HTTP) return null;
  if (!outage) return 200;
  return outage.cause.startsWith("HTTP ") ? Number(outage.cause.slice(5)) : null;
}

function history(m: DemoMonitor, monitorId: string, now: number, rand: () => number) {
  const step = m.intervalSec * 1000;
  const windows = m.outages.map((o) => {
    const start = Math.floor((now - o.daysAgo * DAY) / step) * step;
    return { ...o, start, end: start + o.minutes * 60_000 };
  });
  const rawSince = now - RAW_DAYS * DAY;
  const raw: Prisma.CheckResultCreateManyInput[] = [];
  const hours = new Map<number, { checks: number; failures: number; times: number[] }>();

  for (let t = Math.floor((now - HISTORY_DAYS * DAY) / step) * step; t <= now; t += step) {
    const outage = windows.find((w) => t >= w.start && t < w.end);
    // Slower in the European afternoon, with the odd spike.
    const hourOfDay = new Date(t).getUTCHours();
    const load = 1 + 0.25 * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);
    const spike = rand() < 0.015 ? 2 + rand() * 3 : 1;
    const responseMs = outage ? null : Math.round(m.baseMs * load * spike * (0.85 + rand() * 0.3));

    if (t >= rawSince) {
      raw.push({
        monitorId,
        status: outage ? "DOWN" : "UP",
        responseMs,
        statusCode: statusCode(m, outage),
        error: outage?.cause ?? null,
        checkedAt: new Date(t),
      });
      continue;
    }
    const hour = Math.floor(t / HOUR) * HOUR;
    const bucket = hours.get(hour) ?? { checks: 0, failures: 0, times: [] };
    bucket.checks++;
    if (outage) bucket.failures++;
    if (responseMs !== null) bucket.times.push(responseMs);
    hours.set(hour, bucket);
  }

  const rollups: Prisma.CheckRollupCreateManyInput[] = [...hours].map(([hour, b]) => {
    const sorted = b.times.sort((a, z) => a - z);
    return {
      monitorId,
      hour: new Date(hour),
      checks: b.checks,
      failures: b.failures,
      responseCount: sorted.length,
      responseAvgMs: sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : null,
      responseP95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null,
    };
  });

  const incidents = windows.map((w) => ({
    monitorId,
    startedAt: new Date(w.start),
    resolvedAt: new Date(w.end),
    cause: w.cause,
  }));
  return { raw, rollups, incidents };
}

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

  // Re-running the seed replaces the demo monitors (and, by cascade, their history)
  // instead of duplicating them.
  await prisma.monitor.deleteMany({ where: { ownerId: user.id } });

  const now = Date.now();
  const rand = random(42);
  let checks = 0;
  for (const demo of monitors) {
    const monitor = await prisma.monitor.create({
      data: {
        ownerId: user.id,
        name: demo.name,
        type: demo.type,
        target: demo.target,
        intervalSec: demo.intervalSec,
        status: "UP",
        lastCheckedAt: new Date(now),
      },
    });
    const { raw, rollups, incidents } = history(demo, monitor.id, now, rand);
    for (let i = 0; i < raw.length; i += 5000) {
      await prisma.checkResult.createMany({ data: raw.slice(i, i + 5000) });
    }
    await prisma.checkRollup.createMany({ data: rollups });
    await prisma.incident.createMany({ data: incidents });
    checks += raw.length;
  }

  console.log(
    `Seeded ${DEMO_EMAIL} with ${monitors.length} monitors, ${checks} recent checks and ${HISTORY_DAYS} days of history.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
