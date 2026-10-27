import { Prisma, type PrismaClient, type ResolveHost } from "@lanternly/db";
import { Router } from "express";
import { z } from "zod";
import { authOf, requireAuth } from "../auth/middleware.js";
import { HttpError, validate } from "../http.js";
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
  jwtSecret: string;
  resolveHost?: ResolveHost;
}

export function monitorRouter({ prisma, jwtSecret, resolveHost }: MonitorDeps) {
  const router = Router();
  router.use(requireAuth(prisma, jwtSecret));

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
    res.json({ monitors });
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
    res.status(201).json({ monitor });
  });

  router.get("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    res.json({ monitor: await findOwned(id, userId) });
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

    res.json({ monitor: await updateOwned(id, userId, data) });
  });

  router.delete("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const { count } = await prisma.monitor.deleteMany({ where: { id, ownerId: userId } });
    if (count === 0) throw new HttpError(404, "Monitor not found");
    res.status(204).end();
  });

  router.post("/:id/pause", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const monitor = await updateOwned(id, userId, { isActive: false, status: "PAUSED" });
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
    res.json({ monitor });
  });

  return router;
}
