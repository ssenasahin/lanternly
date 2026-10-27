// Fills a fresh database with a demo account, a handful of realistic monitors and
// 30 days of history, so charts and uptime figures have something true-to-life to
// show the first time the dashboard opens.
import {
  type DnsRecordType,
  MonitorType,
  PrismaClient,
  type AssertionOperator,
  type CheckStatus,
  type Prisma,
} from "@prisma/client";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@lanternly.dev";

interface Outage {
  daysAgo: number;
  // Unset for an outage still going on now.
  minutes?: number;
  cause: string;
  // The code that came back, when the server answered but something else was wrong.
  statusCode?: number;
}

interface DemoMonitor {
  name: string;
  type: MonitorType;
  target: string;
  intervalSec: number;
  // Typical response time; the history wanders around it.
  baseMs: number;
  slowAfterMs?: number;
  outages: Outage[];
  // An API monitor's rules, and what each failing check found.
  rules?: { path: string; operator: AssertionOperator; expected: string | null }[];
  failedRules?: Prisma.InputJsonArray;
  // What a DNS monitor asks for.
  dns?: { recordType: DnsRecordType; expected: string | null };
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
    // Its spikes cross the line now and then: degraded, not down.
    slowAfterMs: 1500,
    outages: [
      { daysAgo: 2.3, minutes: 14, cause: "Timed out after 10 s" },
      { daysAgo: 19.6, minutes: 41, cause: "HTTP 503" },
    ],
  },
  {
    name: "Mail relay",
    type: MonitorType.TCP,
    target: "smtp.gmail.com:587",
    intervalSec: 120,
    baseMs: 45,
    outages: [{ daysAgo: 9.1, minutes: 6, cause: "No connection within 10 s" }],
  },
  {
    name: "Resolver record",
    type: MonitorType.DNS,
    target: "one.one.one.one",
    intervalSec: 300,
    baseMs: 30,
    outages: [{ daysAgo: 15.8, minutes: 10, cause: "Expected 1.1.1.1, got 1.0.0.1" }],
    dns: { recordType: "A", expected: "1.1.1.1" },
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
    name: "Slides API",
    type: MonitorType.API,
    target: "https://httpbin.org/json",
    intervalSec: 300,
    baseMs: 460,
    // Answering, but no longer with what the rules expect: down for the last 80 minutes.
    outages: [
      { daysAgo: 6.25, minutes: 35, cause: "Connection refused" },
      {
        daysAgo: 80 / 1440,
        cause: 'slideshow.author should equal Lanternly Docs, got "Yours Truly"',
        statusCode: 200,
      },
    ],
    rules: [
      { path: "slideshow.title", operator: "EQUALS", expected: "Sample Slide Show" },
      { path: "slideshow.slides", operator: "EXISTS", expected: null },
      { path: "slideshow.author", operator: "EQUALS", expected: "Lanternly Docs" },
    ],
    failedRules: [
      {
        path: "slideshow.title",
        operator: "EQUALS",
        expected: "Sample Slide Show",
        passed: true,
        received: '"Sample Slide Show"',
      },
      {
        path: "slideshow.slides",
        operator: "EXISTS",
        expected: null,
        passed: true,
        received: '[{"title":"Wake up to WonderWidgets!","type":"all"},{"items":["Why <em>WonderW…',
      },
      {
        path: "slideshow.author",
        operator: "EQUALS",
        expected: "Lanternly Docs",
        passed: false,
        received: '"Yours Truly"',
      },
    ],
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
  // Only HTTP answers have a status code.
  if (m.type !== MonitorType.HTTP && m.type !== MonitorType.API) return null;
  if (!outage) return 200;
  if (outage.statusCode) return outage.statusCode;
  return outage.cause.startsWith("HTTP ") ? Number(outage.cause.slice(5)) : null;
}

// The verdict the worker would have written, a slow answer included.
function judge(m: DemoMonitor, outage: Outage | undefined, responseMs: number | null) {
  if (outage) return { status: "DOWN" as CheckStatus, error: outage.cause };
  if (m.slowAfterMs && responseMs !== null && responseMs > m.slowAfterMs) {
    const ms = (n: number) => `${n.toLocaleString("en-GB")} ms`;
    const error = `Took ${ms(responseMs)}, over the ${ms(m.slowAfterMs)} limit`;
    return { status: "DEGRADED" as CheckStatus, error };
  }
  return { status: "UP" as CheckStatus, error: null };
}

function history(m: DemoMonitor, monitorId: string, now: number, rand: () => number) {
  const step = m.intervalSec * 1000;
  const windows = m.outages.map((o) => {
    const start = Math.floor((now - o.daysAgo * DAY) / step) * step;
    return { ...o, start, end: o.minutes === undefined ? Infinity : start + o.minutes * 60_000 };
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
    // A server that answered gets a time even when its answer was wrong.
    const answered = !outage || outage.statusCode !== undefined;
    const responseMs = answered
      ? Math.round(m.baseMs * load * spike * (0.85 + rand() * 0.3))
      : null;

    if (t >= rawSince) {
      raw.push({
        monitorId,
        ...judge(m, outage, responseMs),
        responseMs,
        statusCode: statusCode(m, outage),
        rules: outage?.statusCode ? m.failedRules : undefined,
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
    resolvedAt: w.end === Infinity ? null : new Date(w.end),
    cause: w.cause,
  }));
  return { raw, rollups, incidents };
}

// Documentation addresses (RFC 5737), never a real machine.
const JOB_HOST = { ip: "203.0.113.7", userAgent: "curl/8.5.0" };
// Random like real ones: a public demo must not have guessable ping URLs.
const newToken = () => randomBytes(16).toString("base64url");
const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

// Two heartbeats: a nightly backup that's timed, was slow once and missed a night,
// and an hourly export that went quiet two hours ago and is down right now.
async function seedHeartbeats(ownerId: string, now: number, rand: () => number) {
  const backup = await prisma.monitor.create({
    data: {
      ownerId,
      name: "Nightly backup",
      type: MonitorType.HEARTBEAT,
      target: "",
      intervalSec: 0,
      status: "UP",
      // 03:00 in Istanbul is midnight UTC.
      heartbeat: {
        create: {
          token: newToken(),
          cron: "0 3 * * *",
          timezone: "Europe/Istanbul",
          graceSec: 1800,
        },
      },
    },
  });
  const pings: Prisma.HeartbeatPingCreateManyInput[] = [];
  const checks: Prisma.CheckResultCreateManyInput[] = [];
  const incidents: Prisma.IncidentCreateManyInput[] = [];
  const today = Math.floor(now / DAY) * DAY;
  let lastPingAt = 0;
  let missedSince = 0;
  for (let day = HISTORY_DAYS; day >= 0; day--) {
    const start = today - day * DAY + Math.round(rand() * 20_000);
    if (start > now) continue;
    if (day === 17) {
      // The run never happened: down once the grace ran out, back with the next ping.
      const lateAt = start + 30 * 60_000;
      missedSince = lateAt;
      checks.push({
        monitorId: backup.id,
        status: "DOWN",
        checkedAt: new Date(lateAt),
        error: `No ping since ${utc(lastPingAt)}; one was due by ${utc(today - day * DAY)}`,
      });
      continue;
    }
    const slow = day === 9;
    const durationMs = slow ? 610_000 : Math.round(230_000 + rand() * 40_000);
    const end = start + durationMs;
    if (end > now) continue;
    const size = (2.3 + rand() * 0.3).toFixed(2);
    pings.push({ monitorId: backup.id, kind: "START", receivedAt: new Date(start), ...JOB_HOST });
    pings.push({
      monitorId: backup.id,
      kind: "SUCCESS",
      receivedAt: new Date(end),
      durationMs,
      body: `pg_dump finished: ${size} GB written to s3://backups/${new Date(start).toISOString().slice(0, 10)}.dump`,
      ...JOB_HOST,
    });
    checks.push({
      monitorId: backup.id,
      status: slow ? "DEGRADED" : "UP",
      responseMs: durationMs,
      checkedAt: new Date(end),
      error: slow ? "Ran for 10 min, more than twice the usual 4 min" : null,
    });
    if (missedSince) {
      incidents.push({
        monitorId: backup.id,
        startedAt: new Date(missedSince),
        resolvedAt: new Date(end),
        cause: checks.at(-2)!.error ?? null,
      });
      missedSince = 0;
    }
    lastPingAt = end;
  }
  await prisma.heartbeat.update({
    where: { monitorId: backup.id },
    data: { lastPingAt: new Date(lastPingAt) },
  });

  // Hourly, never timed (no start pings), quiet for the last two hours.
  const quietSince = now - 2 * HOUR - 13 * 60_000;
  const lateAt = quietSince + HOUR + 5 * 60_000;
  const cause = `No ping since ${utc(quietSince)}; one was due by ${utc(quietSince + HOUR)}`;
  const exportJob = await prisma.monitor.create({
    data: {
      ownerId,
      name: "Invoice export",
      type: MonitorType.HEARTBEAT,
      target: "",
      intervalSec: 3600,
      status: "DOWN",
      lastCheckedAt: new Date(lateAt),
      heartbeat: {
        create: {
          token: newToken(),
          periodSec: 3600,
          graceSec: 300,
          lastPingAt: new Date(quietSince),
        },
      },
    },
  });
  for (let at = quietSince - HISTORY_DAYS * DAY; at <= quietSince; at += HOUR) {
    pings.push({ monitorId: exportJob.id, kind: "SUCCESS", receivedAt: new Date(at), ...JOB_HOST });
    checks.push({ monitorId: exportJob.id, status: "UP", checkedAt: new Date(at) });
  }
  checks.push({
    monitorId: exportJob.id,
    status: "DOWN",
    checkedAt: new Date(lateAt),
    error: cause,
  });
  incidents.push({ monitorId: exportJob.id, startedAt: new Date(lateAt), cause });

  await prisma.heartbeatPing.createMany({ data: pings });
  await prisma.checkResult.createMany({ data: checks });
  await prisma.incident.createMany({ data: incidents });
  return 2;
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
        slowAfterMs: demo.slowAfterMs,
        status: demo.outages.some((o) => o.minutes === undefined) ? "DOWN" : "UP",
        lastCheckedAt: new Date(now),
        ...(demo.rules && {
          apiRequest: { create: { expectedStatus: "200-299" } },
          assertions: { create: demo.rules.map((r, position) => ({ position, ...r })) },
        }),
        ...(demo.dns && { dnsQuery: { create: demo.dns } }),
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
  const heartbeats = await seedHeartbeats(user.id, now, rand);

  console.log(
    `Seeded ${DEMO_EMAIL} with ${monitors.length} monitors, ${heartbeats} heartbeats, ${checks} recent checks and ${HISTORY_DAYS} days of history.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
