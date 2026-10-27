import { Prisma, type MonitorScheduler, type PrismaClient, type ResolveHost } from "@lanternly/db";
import { Router } from "express";
import { z } from "zod";
import { authOf, requireAuth } from "../auth/middleware.js";
import { HttpError, validate } from "../http.js";
import { lastDayStrips, RANGES, rangeStats, uptimeWindows, type Range } from "./stats.js";
import { checkTarget } from "./target.js";

// Until the admin panel can set limits per plan, everyone gets the same cap.
export const MAX_MONITORS_PER_USER = 50;

const fields = {
  name: z.string().trim().min(1, "Give the monitor a name").max(100),
  type: z.enum(["HTTP", "PING"]),
  target: z.string().trim().min(1, "Enter what to monitor").max(2048),
  intervalSec: z.int().min(30, "Check at most every 30 seconds").max(300),
  timeoutMs: z.int().min(1000, "Allow at least 1 second").max(30_000),
  retries: z.int().min(0).max(5),
};

const createSchema = z.object({
  ...fields,
  intervalSec: fields.intervalSec.default(60),
  timeoutMs: fields.timeoutMs.default(10_000),
  retries: fields.retries.default(1),
});

const updateSchema = z.object(fields).partial();

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
  isActive: true,
  status: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MonitorSelect;

interface Timing {
  intervalSec: number;
  timeoutMs: number;
  retries: number;
}

// A check is the first attempt plus its retries. If they could all time out and
// still be running when the next check starts, checks would pile up on each other.
function assertFitsInterval({ intervalSec, timeoutMs, retries }: Timing) {
  if (timeoutMs * (retries + 1) > intervalSec * 1000) {
    throw new HttpError(400, "Invalid request", {
      timeoutMs: ["The timeout times every attempt must fit within the check interval"],
    });
  }
}

export interface MonitorDeps {
  prisma: PrismaClient;
  scheduler: MonitorScheduler;
  jwtSecret: string;
  resolveHost?: ResolveHost;
}

export function monitorRouter({ prisma, scheduler, jwtSecret, resolveHost }: MonitorDeps) {
  const router = Router();
  router.use(requireAuth(prisma, jwtSecret));

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
    res.json({ monitors: monitors.map((m) => ({ ...m, lastDay: strips.get(m.id) })) });
  });

  router.post("/", async (req, res) => {
    const { userId } = authOf(req);
    const input = validate(createSchema, req.body);
    assertFitsInterval(input);

    const count = await prisma.monitor.count({ where: { ownerId: userId } });
    if (count >= MAX_MONITORS_PER_USER) {
      throw new HttpError(403, `You can have up to ${MAX_MONITORS_PER_USER} monitors`);
    }

    const target = await checkTarget(input.type, input.target, resolveHost);
    const monitor = await prisma.monitor.create({
      data: { ...input, target, ownerId: userId },
      select: monitorFields,
    });
    await reschedule(() => scheduler.sync(monitor));
    res.status(201).json({ monitor });
  });

  router.get("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const monitor = await findOwned(id, userId);
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
        checkedAt: true,
      },
    });
    // Check ids are BigInts, which JSON can't carry; as strings they're just keys.
    res.json({ checks: checks.map((c) => ({ ...c, id: c.id.toString() })) });
  });

  router.patch("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const input = validate(updateSchema, req.body);
    const current = await findOwned(id, userId);

    const next = { ...current, ...input };
    assertFitsInterval(next);

    const data: Prisma.MonitorUpdateInput = { ...input };
    // Switching between HTTP and ping changes what the target means, so recheck it.
    if (input.target !== undefined || input.type !== undefined) {
      data.target = await checkTarget(next.type, next.target, resolveHost);
      // The old results describe a different target; wait for a fresh check.
      if (data.target !== current.target || next.type !== current.type) {
        data.status = current.isActive ? "PENDING" : "PAUSED";
      }
    }

    const monitor = await updateOwned(id, userId, data);
    await reschedule(() => scheduler.sync(monitor));
    res.json({ monitor });
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
    res.json({ monitor });
  });

  router.post("/:id/resume", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const current = await findOwned(id, userId);
    if (current.isActive) {
      res.json({ monitor: current });
      return;
    }
    // Its last known state is stale after a pause; the next check decides it again.
    const monitor = await updateOwned(id, userId, { isActive: true, status: "PENDING" });
    await reschedule(() => scheduler.sync(monitor));
    res.json({ monitor });
  });

  return router;
}
