import {
  cronProblem,
  expectedBy,
  isTimeZone,
  lateAfter,
  nextRuns,
  Prisma,
  type PrismaClient,
} from "@lanternly/db";
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authOf, requireAuth } from "../auth/middleware.js";
import { HttpError, validate } from "../http.js";
import { MAX_MONITORS_PER_USER } from "../monitors/routes.js";

const scheduleFields = {
  // A fixed period, from one minute to a week...
  periodSec: z
    .int()
    .min(60, "Expect a ping at most every minute")
    .max(7 * 24 * 60 * 60)
    .nullable(),
  // ...or a cron expression, read in a time zone.
  cron: z.string().trim().min(1).max(100).nullable(),
  timezone: z.string().trim().min(1).max(64),
  graceSec: z
    .int()
    .min(60, "Allow at least a minute")
    .max(24 * 60 * 60),
};

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the heartbeat a name").max(100),
  periodSec: scheduleFields.periodSec.default(null),
  cron: scheduleFields.cron.default(null),
  timezone: scheduleFields.timezone.default("UTC"),
  graceSec: scheduleFields.graceSec.default(300),
});

const updateSchema = createSchema.partial();
const previewSchema = z.object({ cron: z.string().trim().max(100), timezone: z.string().trim() });
const idParams = z.object({ id: z.uuid() });
const pingsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

interface Schedule {
  periodSec: number | null;
  cron: string | null;
  timezone: string;
}

// Exactly one of a period and a cron expression, and the expression must parse.
function checkSchedule({ periodSec, cron, timezone }: Schedule): Schedule {
  const invalid = (field: string, message: string) =>
    new HttpError(400, "Invalid request", { [field]: [message] });
  if ((periodSec === null) === (cron === null)) {
    throw invalid("periodSec", "Choose either a period or a cron expression");
  }
  if (!isTimeZone(timezone)) throw invalid("timezone", "Unknown time zone");
  if (cron !== null) {
    const problem = cronProblem(cron, timezone);
    if (problem) throw invalid("cron", problem);
    // Stored with single spaces, so it reads the same wherever it's shown.
    return { periodSec: null, cron: cron.split(/\s+/).join(" "), timezone };
  }
  return { periodSec, cron: null, timezone };
}

// The monitor fields the owner sees, as on /api/monitors.
const monitorFields = {
  id: true,
  name: true,
  type: true,
  isActive: true,
  status: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MonitorSelect;

const heartbeatFields = {
  token: true,
  periodSec: true,
  cron: true,
  timezone: true,
  graceSec: true,
  lastPingAt: true,
  lastStartAt: true,
} satisfies Prisma.HeartbeatSelect;

type Row = Prisma.MonitorGetPayload<{
  select: typeof monitorFields & { heartbeat: { select: typeof heartbeatFields } };
}>;

export interface HeartbeatDeps {
  prisma: PrismaClient;
  jwtSecret: string;
  // Ping URLs start with this.
  publicUrl: string;
}

export function heartbeatRouter({ prisma, jwtSecret, publicUrl }: HeartbeatDeps) {
  const router = Router();
  router.use(requireAuth(prisma, jwtSecret));

  // What the owner needs to set the job up and to know where it stands. The token
  // appears only inside the ping URL, and only here, never in monitor lists.
  function present({ heartbeat, ...monitor }: Row) {
    const { token, ...schedule } = heartbeat!;
    const { lastPingAt } = schedule;
    return {
      monitor,
      heartbeat: {
        ...schedule,
        pingUrl: `${publicUrl}/ping/${token}`,
        // Nothing is expected until the first ping: that's when watching starts.
        expectedAt: lastPingAt ? expectedBy(schedule, lastPingAt) : null,
        lateAt: lastPingAt ? lateAfter(schedule, lastPingAt) : null,
      },
    };
  }

  const select = { ...monitorFields, heartbeat: { select: heartbeatFields } };

  async function findOwned(id: string, ownerId: string) {
    const row = await prisma.monitor.findFirst({
      where: { id, ownerId, type: "HEARTBEAT" },
      select,
    });
    if (!row) throw new HttpError(404, "Heartbeat not found");
    return row;
  }

  // Validates a cron expression and lists its next runs, for the form's preview.
  router.post("/schedule-preview", (req, res) => {
    const { cron, timezone } = validate(previewSchema, req.body);
    const problem = cronProblem(cron, timezone);
    if (problem) throw new HttpError(400, "Invalid request", { cron: [problem] });
    res.json({ next: nextRuns(cron, timezone, new Date(), 3) });
  });

  router.get("/", async (req, res) => {
    const { userId } = authOf(req);
    const rows = await prisma.monitor.findMany({
      where: { ownerId: userId, type: "HEARTBEAT" },
      orderBy: { createdAt: "asc" },
      select,
    });
    res.json({ heartbeats: rows.map(present) });
  });

  router.post("/", async (req, res) => {
    const { userId } = authOf(req);
    const input = validate(createSchema, req.body);
    const schedule = checkSchedule(input);

    // Heartbeats are monitors, and count towards the same limit.
    const count = await prisma.monitor.count({ where: { ownerId: userId } });
    if (count >= MAX_MONITORS_PER_USER) {
      throw new HttpError(403, `You can have up to ${MAX_MONITORS_PER_USER} monitors`);
    }

    const row = await prisma.monitor.create({
      data: {
        ownerId: userId,
        name: input.name,
        type: "HEARTBEAT",
        // Nothing to check: the job calls us.
        target: "",
        intervalSec: schedule.periodSec ?? 0,
        heartbeat: {
          create: {
            ...schedule,
            graceSec: input.graceSec,
            // 128 random bits: guessing a URL is hopeless, and none hints at another.
            token: randomBytes(16).toString("base64url"),
          },
        },
      },
      select,
    });
    res.status(201).json(present(row));
  });

  router.get("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    res.json(present(await findOwned(id, userId)));
  });

  router.patch("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const input = validate(updateSchema, req.body);
    const current = await findOwned(id, userId);
    const was = current.heartbeat!;

    // Setting one kind of schedule clears the other.
    const merged: Schedule =
      input.periodSec != null
        ? { periodSec: input.periodSec, cron: null, timezone: input.timezone ?? was.timezone }
        : input.cron != null
          ? { periodSec: null, cron: input.cron, timezone: input.timezone ?? was.timezone }
          : { periodSec: was.periodSec, cron: was.cron, timezone: input.timezone ?? was.timezone };
    const schedule = checkSchedule(merged);

    try {
      const row = await prisma.monitor.update({
        where: { id },
        data: {
          name: input.name,
          intervalSec: schedule.periodSec ?? 0,
          heartbeat: { update: { ...schedule, graceSec: input.graceSec } },
        },
        select,
      });
      res.json(present(row));
    } catch (err) {
      // Deleted between our read and this write.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new HttpError(404, "Heartbeat not found");
      }
      throw err;
    }
  });

  router.delete("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const { count } = await prisma.monitor.deleteMany({
      where: { id, ownerId: userId, type: "HEARTBEAT" },
    });
    if (count === 0) throw new HttpError(404, "Heartbeat not found");
    res.status(204).end();
  });

  // Recent pings, newest first, with what each request carried.
  router.get("/:id/pings", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const { limit } = validate(pingsQuery, req.query);
    await findOwned(id, userId);
    const pings = await prisma.heartbeatPing.findMany({
      where: { monitorId: id },
      orderBy: { id: "desc" },
      take: limit,
      select: {
        id: true,
        kind: true,
        receivedAt: true,
        durationMs: true,
        ip: true,
        userAgent: true,
        body: true,
      },
    });
    res.json({ pings: pings.map((p) => ({ ...p, id: p.id.toString() })) });
  });

  return router;
}
