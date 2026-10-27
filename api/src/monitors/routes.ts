import {
  checkApi,
  markSlow,
  openHeaders,
  Prisma,
  resolvePublicHost,
  type MonitorScheduler,
  type PrismaClient,
  type Resolve,
  type ResolveHost,
} from "@lanternly/db";
import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { authOf } from "../auth/middleware.js";
import { HttpError, validate } from "../http.js";
import {
  apiFields,
  apiRows,
  apiSettings,
  presentApi,
  toSpec,
  withStoredSecrets,
  type ApiSettings,
} from "./api-settings.js";
import { dnsFields, dnsSettings, presentDns } from "./dns-settings.js";
import { lastDayStrips, RANGES, rangeStats, uptimeWindows, type Range } from "./stats.js";
import { checkTarget } from "./target.js";

// Until the admin panel can set limits per plan, everyone gets the same cap.
export const MAX_MONITORS_PER_USER = 50;

const fields = {
  name: z.string().trim().min(1, "Give the monitor a name").max(100),
  type: z.enum(["HTTP", "API", "PING", "TCP", "DNS"]),
  target: z.string().trim().min(1, "Enter what to monitor").max(2048),
  intervalSec: z.int().min(30, "Check at most every 30 seconds").max(300),
  timeoutMs: z.int().min(1000, "Allow at least 1 second").max(30_000),
  retries: z.int().min(0).max(5),
  slowAfterMs: z.int().min(10, "Allow at least 10 ms").max(30_000).nullable(),
  // Only API monitors use it; for the other types it's ignored.
  api: apiSettings,
  // Only DNS monitors use it.
  dns: dnsSettings,
  // Null: alert the owner and every channel at once.
  escalationPolicyId: z.uuid().nullable(),
};

const createSchema = z.object({
  ...fields,
  intervalSec: fields.intervalSec.default(60),
  timeoutMs: fields.timeoutMs.default(10_000),
  retries: fields.retries.default(1),
  slowAfterMs: fields.slowAfterMs.default(null),
  api: fields.api.optional(),
  dns: fields.dns.optional(),
  escalationPolicyId: fields.escalationPolicyId.default(null),
});

const updateSchema = z.object(fields).partial();

// "Test now": an unsaved API monitor, sent once. The monitor id, when editing, lets
// secret headers the browser was never sent be filled in from what's stored.
const testSchema = z.object({
  target: fields.target,
  timeoutMs: fields.timeoutMs.default(10_000),
  slowAfterMs: fields.slowAfterMs.default(null),
  api: fields.api,
  monitorId: z.uuid().optional(),
});

const idParams = z.object({ id: z.uuid() });
const checksQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must be before to" });
const statsQuery = z.object({
  range: z.enum(Object.keys(RANGES) as [Range, ...Range[]]).default("24h"),
});

// Everything the owner may see. The owner id is left out: it's always the caller.
const monitorFields = {
  id: true,
  name: true,
  type: true,
  target: true,
  intervalSec: true,
  timeoutMs: true,
  retries: true,
  slowAfterMs: true,
  isActive: true,
  status: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
  // A heartbeat's schedule, so lists can say what it expects. Never its token: the
  // ping URL is only shown on /api/heartbeats/:id.
  heartbeat: {
    select: { periodSec: true, cron: true, timezone: true, graceSec: true, lastPingAt: true },
  },
  escalationPolicy: { select: { id: true, name: true } },
  // A server agent's host, as its last report gave it. Never its key.
  agent: { select: { hostname: true, platform: true, lastSeenAt: true, keyPrefix: true } },
  ...apiFields,
  ...dnsFields,
} satisfies Prisma.MonitorSelect;

type SelectedMonitor = Prisma.MonitorGetPayload<{ select: typeof monitorFields }>;

interface Timing {
  intervalSec: number;
  timeoutMs: number;
  retries: number;
  slowAfterMs: number | null;
}

function assertTiming({ intervalSec, timeoutMs, retries, slowAfterMs }: Timing) {
  // A check is the first attempt plus its retries. If they could all time out and
  // still be running when the next check starts, checks would pile up on each other.
  if (timeoutMs * (retries + 1) > intervalSec * 1000) {
    throw new HttpError(400, "Invalid request", {
      timeoutMs: ["The timeout times every attempt must fit within the check interval"],
    });
  }
  // An answer that slow has already timed out: the limit could never be reached.
  if (slowAfterMs !== null && slowAfterMs >= timeoutMs) {
    throw new HttpError(400, "Invalid request", {
      slowAfterMs: ["Set it below the timeout, or it can never be reached"],
    });
  }
}

export interface MonitorDeps {
  prisma: PrismaClient;
  scheduler: MonitorScheduler;
  // A session in the dashboard, an API key on /api/v1: either way, req.auth is set.
  authenticate: RequestHandler;
  // Seals and opens API monitors' headers.
  encryptionKey: Buffer;
  resolveHost?: ResolveHost;
  // How "Test now" turns a host into addresses: the SSRF guard, unless a test needs
  // to reach a local server.
  checkResolve?: Resolve;
}

export function monitorRouter({
  prisma,
  scheduler,
  authenticate,
  encryptionKey,
  resolveHost,
  checkResolve = (host) => resolvePublicHost(host, resolveHost),
}: MonitorDeps) {
  const router = Router();
  router.use(authenticate);

  // Each test is a real request to someone's server, sent on the user's say-so.
  const testLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => authOf(req).userId,
    message: { error: "That's a lot of tests. Wait a minute and try again." },
  });

  // The monitor as the browser sees it: API settings unwrapped, secrets left out.
  function present({ apiRequest, assertions, dnsQuery, ...monitor }: SelectedMonitor) {
    return {
      ...monitor,
      api: presentApi({ apiRequest, assertions }, encryptionKey),
      dns: presentDns(dnsQuery),
    };
  }

  // The headers to store or send: the ones given, with secrets the browser left out
  // filled in from the monitor's stored ones.
  function resolveHeaders(api: ApiSettings, current?: SelectedMonitor | null) {
    const stored = openHeaders(current?.apiRequest?.headers ?? null, encryptionKey);
    return withStoredSecrets(api.headers, stored);
  }

  // A policy belongs to the caller's team, or it doesn't exist as far as they know.
  async function checkPolicy(id: string | null | undefined, ownerId: string) {
    if (!id) return;
    const policy = await prisma.escalationPolicy.findFirst({ where: { id, team: { ownerId } } });
    if (!policy) {
      throw new HttpError(400, "Invalid request", {
        escalationPolicyId: ["No such escalation policy"],
      });
    }
  }

  // The database is the source of truth; the schedule follows it. If Redis is briefly
  // unreachable the change still saves, and the worker repairs the schedule on its
  // next reconcile instead of the user seeing an error for something that worked.
  async function reschedule(work: () => Promise<void>) {
    try {
      await work();
    } catch (err) {
      console.error("Couldn't update the check schedule; the worker will repair it", err);
    }
  }

  // Every lookup filters by owner as well as id, so another user's monitor is
  // indistinguishable from one that doesn't exist: both are a 404.
  async function findOwned(id: string, ownerId: string) {
    const monitor = await prisma.monitor.findFirst({
      where: { id, ownerId },
      select: monitorFields,
    });
    if (!monitor) throw new HttpError(404, "Monitor not found");
    return monitor;
  }

  async function updateOwned(id: string, ownerId: string, data: Prisma.MonitorUpdateInput) {
    try {
      return await prisma.monitor.update({ where: { id, ownerId }, data, select: monitorFields });
    } catch (err) {
      // Deleted between our read and this write.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new HttpError(404, "Monitor not found");
      }
      throw err;
    }
  }

  router.get("/", async (req, res) => {
    const { userId } = authOf(req);
    const monitors = await prisma.monitor.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
      select: monitorFields,
    });
    // The last 24 hours of each, hour by hour, for the strip beside every row.
    const strips = await lastDayStrips(
      prisma,
      monitors.map((m) => m.id),
    );
    res.json({
      monitors: monitors.map((m) => ({ ...present(m), lastDay: strips.get(m.id) })),
    });
  });

  router.post("/", async (req, res) => {
    const { userId } = authOf(req);
    const { api, dns, ...input } = validate(createSchema, req.body);
    assertTiming(input);
    await checkPolicy(input.escalationPolicyId, userId);

    const count = await prisma.monitor.count({ where: { ownerId: userId } });
    if (count >= MAX_MONITORS_PER_USER) {
      throw new HttpError(403, `You can have up to ${MAX_MONITORS_PER_USER} monitors`);
    }

    const target = await checkTarget(input.type, input.target, resolveHost);
    let settings = {};
    if (input.type === "API") {
      const given = api ?? apiSettings.parse({});
      const { request, assertions } = apiRows(given, resolveHeaders(given), encryptionKey);
      settings = { apiRequest: { create: request }, assertions: { create: assertions } };
    }
    if (input.type === "DNS") {
      settings = { dnsQuery: { create: dns ?? dnsSettings.parse({}) } };
    }
    const monitor = await prisma.monitor.create({
      data: { ...input, target, ownerId: userId, ...settings },
      select: monitorFields,
    });
    await reschedule(() => scheduler.sync(monitor));
    res.status(201).json({ monitor: present(monitor) });
  });

  // Sends an API monitor's request once, as the form stands, and reports what came
  // back and how each rule fared. Nothing is saved.
  router.post("/test", testLimit, async (req, res) => {
    const { userId } = authOf(req);
    const { target, timeoutMs, slowAfterMs, api, monitorId } = validate(testSchema, req.body);
    if (slowAfterMs !== null && slowAfterMs >= timeoutMs) {
      throw new HttpError(400, "Invalid request", {
        slowAfterMs: ["Set it below the timeout, or it can never be reached"],
      });
    }
    const url = await checkTarget("API", target, resolveHost);
    const current = monitorId ? await findOwned(monitorId, userId) : null;
    const spec = toSpec(url, api, resolveHeaders(api, current));
    const result = markSlow(await checkApi(spec, timeoutMs, checkResolve), slowAfterMs);
    res.json({ result });
  });

  router.get("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const monitor = present(await findOwned(id, userId));
    // The outage in progress, if any: what the "is down" email links to.
    const openIncident = await prisma.incident.findFirst({
      where: { monitorId: id, resolvedAt: null },
      orderBy: { startedAt: "desc" },
      select: { id: true, startedAt: true, cause: true },
    });
    res.json({ monitor, openIncident });
  });

  // Uptime over the three standard windows (24h, 7d, 30d), plus uptime, response times
  // and a chart series for the range the user picked.
  router.get("/:id/stats", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const { range } = validate(statsQuery, req.query);
    await findOwned(id, userId);
    const [windows, stats] = await Promise.all([
      uptimeWindows(prisma, id),
      rangeStats(prisma, id, range),
    ]);
    res.json({ range, windows, ...stats });
  });

  // Individual results, newest first, optionally between from and to.
  router.get("/:id/checks", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const { limit, from, to } = validate(checksQuery, req.query);
    await findOwned(id, userId);
    const checks = await prisma.checkResult.findMany({
      where: { monitorId: id, checkedAt: { gte: from, lte: to } },
      orderBy: { checkedAt: "desc" },
      take: limit,
      select: {
        id: true,
        status: true,
        responseMs: true,
        statusCode: true,
        error: true,
        rules: true,
        checkedAt: true,
      },
    });
    // Check ids are BigInts, which JSON can't carry; as strings they're just keys.
    res.json({ checks: checks.map((c) => ({ ...c, id: c.id.toString() })) });
  });

  router.patch("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const { api, dns, escalationPolicyId, ...input } = validate(updateSchema, req.body);
    const current = await findOwned(id, userId);
    await checkPolicy(escalationPolicyId, userId);
    // A heartbeat has a schedule rather than a target and an interval.
    if (current.type === "HEARTBEAT") {
      throw new HttpError(400, "Edit a heartbeat at /api/heartbeats/:id");
    }
    // An agent has no target or timing to edit: only its name and who hears about it.
    if (current.type === "AGENT") {
      if (Object.keys(input).some((k) => k !== "name") || api || dns) {
        throw new HttpError(400, "Only a server agent's name and escalation policy can change");
      }
      const data: Prisma.MonitorUpdateInput = { name: input.name };
      if (escalationPolicyId !== undefined) {
        data.escalationPolicy = escalationPolicyId
          ? { connect: { id: escalationPolicyId } }
          : { disconnect: true };
      }
      res.json({ monitor: present(await updateOwned(id, userId, data)) });
      return;
    }

    const next = { ...current, ...input, type: input.type ?? current.type };
    assertTiming(next);

    const data: Prisma.MonitorUpdateInput = { ...input };
    if (escalationPolicyId !== undefined) {
      data.escalationPolicy = escalationPolicyId
        ? { connect: { id: escalationPolicyId } }
        : { disconnect: true };
    }
    if (next.type === "API") {
      // New settings replace the old ones whole. A monitor turned into an API monitor
      // without any starts from the defaults.
      if (api || !current.apiRequest) {
        const given = api ?? apiSettings.parse({});
        const headers = resolveHeaders(given, current);
        const { request, assertions } = apiRows(given, headers, encryptionKey);
        data.apiRequest = { upsert: { create: request, update: request } };
        data.assertions = { deleteMany: {}, create: assertions };
      }
    } else if (current.apiRequest) {
      // No longer an API monitor: its request and rules mean nothing now.
      data.apiRequest = { delete: true };
      data.assertions = { deleteMany: {} };
    }
    if (next.type === "DNS") {
      if (dns || !current.dnsQuery) {
        const query = dns ?? dnsSettings.parse({});
        data.dnsQuery = { upsert: { create: query, update: query } };
      }
    } else if (current.dnsQuery) {
      data.dnsQuery = { delete: true };
    }
    // Switching types changes what the target means, so recheck it.
    if (input.target !== undefined || input.type !== undefined) {
      data.target = await checkTarget(next.type, next.target, resolveHost);
      // The old results describe a different target; wait for a fresh check.
      if (data.target !== current.target || next.type !== current.type) {
        data.status = current.isActive ? "PENDING" : "PAUSED";
      }
    }

    const monitor = await updateOwned(id, userId, data);
    await reschedule(() => scheduler.sync(monitor));
    res.json({ monitor: present(monitor) });
  });

  router.delete("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const { count } = await prisma.monitor.deleteMany({ where: { id, ownerId: userId } });
    if (count === 0) throw new HttpError(404, "Monitor not found");
    await reschedule(() => scheduler.remove(id));
    res.status(204).end();
  });

  router.post("/:id/pause", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const monitor = await updateOwned(id, userId, { isActive: false, status: "PAUSED" });
    await reschedule(() => scheduler.sync(monitor));
    res.json({ monitor: present(monitor) });
  });

  router.post("/:id/resume", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const current = await findOwned(id, userId);
    if (current.isActive) {
      res.json({ monitor: present(current) });
      return;
    }
    // Its last known state is stale after a pause; the next check decides it again.
    const monitor = await updateOwned(id, userId, { isActive: true, status: "PENDING" });
    await reschedule(() => scheduler.sync(monitor));
    res.json({ monitor: present(monitor) });
  });

  return router;
}
