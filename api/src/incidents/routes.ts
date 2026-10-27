import { verifyAck, type EscalationCanceller, type PrismaClient } from "@lanternly/db";
import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { authOf } from "../auth/middleware.js";
import { HttpError, validate } from "../http.js";

const listQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("all"),
  monitorId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const idParams = z.object({ id: z.uuid() });
const signed = z.object({
  by: z.string().regex(/^[uc]:[0-9a-f-]{36}$/),
  sig: z.string().min(20).max(100),
});

export interface IncidentDeps {
  prisma: PrismaClient;
  authenticate: RequestHandler;
  // Checks acknowledge links.
  encryptionKey: Buffer;
  escalations: EscalationCanceller;
}

// Marks an incident acknowledged, once, and calls off the escalation steps still
// waiting. Returns false if it was already acknowledged or is over.
async function acknowledge(
  { prisma, escalations }: Pick<IncidentDeps, "prisma" | "escalations">,
  incidentId: string,
  by: string,
): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.incident.updateMany({
    where: { id: incidentId, acknowledgedAt: null, resolvedAt: null },
    data: { acknowledgedAt: now, acknowledgedBy: by },
  });
  if (count === 0) return false;
  await prisma.incidentEvent.create({
    data: { incidentId, type: "ACKNOWLEDGED", at: now, detail: `By ${by}` },
  });
  // The worker also skips steps for an acknowledged incident; removing the jobs just
  // keeps them from waking up for nothing.
  await escalations.cancel(incidentId).catch((err) => {
    console.error("Couldn't cancel escalation jobs; the worker will skip them", err);
  });
  return true;
}

const incidentSelect = {
  id: true,
  startedAt: true,
  resolvedAt: true,
  cause: true,
  acknowledgedAt: true,
  acknowledgedBy: true,
  monitor: {
    select: {
      id: true,
      name: true,
      type: true,
      target: true,
      escalationPolicy: { select: { id: true, name: true } },
    },
  },
} as const;

export function incidentRouter(deps: IncidentDeps) {
  const { prisma, authenticate } = deps;
  const router = Router();
  router.use(authenticate);

  // Outages across all of the caller's monitors, newest first. Ownership is checked
  // through the monitor, so another user's monitor id simply matches nothing.
  router.get("/", async (req, res) => {
    const { userId } = authOf(req);
    const { status, monitorId, limit } = validate(listQuery, req.query);
    const incidents = await prisma.incident.findMany({
      where: {
        monitor: { ownerId: userId, ...(monitorId && { id: monitorId }) },
        ...(status === "open" && { resolvedAt: null }),
        ...(status === "resolved" && { resolvedAt: { not: null } }),
      },
      orderBy: { startedAt: "desc" },
      take: limit,
      select: {
        id: true,
        startedAt: true,
        resolvedAt: true,
        cause: true,
        acknowledgedAt: true,
        monitor: { select: { id: true, name: true, type: true, target: true } },
      },
    });
    res.json({ incidents });
  });

  async function findOwned(id: string, ownerId: string) {
    const incident = await prisma.incident.findFirst({
      where: { id, monitor: { ownerId } },
      select: incidentSelect,
    });
    if (!incident) throw new HttpError(404, "Incident not found");
    return incident;
  }

  // One incident and its timeline, oldest event first.
  router.get("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const incident = await findOwned(id, userId);
    const events = await prisma.incidentEvent.findMany({
      where: { incidentId: id },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { id: true, type: true, at: true, detail: true },
    });
    res.json({ incident, events: events.map((e) => ({ ...e, id: e.id.toString() })) });
  });

  router.post("/:id/ack", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    await findOwned(id, userId);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await acknowledge(deps, id, user.email);
    res.json({ incident: await findOwned(id, userId) });
  });

  return router;
}

// Acknowledging from an alert: no sign-in, the link's signature is the proof. It's
// a POST from a page, not the GET the link itself makes, so mail scanners that open
// every link can't acknowledge an outage nobody has seen.
export function ackRouter(deps: Omit<IncidentDeps, "authenticate">) {
  const { prisma, encryptionKey } = deps;
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Wait a minute and try again." },
    }),
  );

  async function check(id: string, by: string, sig: string) {
    if (!verifyAck(encryptionKey, id, by, sig)) throw new HttpError(404, "This link isn't valid");
    const incident = await prisma.incident.findUnique({ where: { id }, select: incidentSelect });
    if (!incident) throw new HttpError(404, "This incident no longer exists");
    return incident;
  }

  // Who the link was sent to, in words for the timeline.
  async function whoIs(by: string) {
    const id = by.slice(2);
    if (by.startsWith("u:")) {
      const user = await prisma.user.findUnique({ where: { id }, select: { email: true } });
      return user?.email ?? "a former team member";
    }
    const channel = await prisma.notificationChannel.findUnique({
      where: { id },
      select: { name: true },
    });
    return channel ? `someone in "${channel.name}"` : "someone in a deleted channel";
  }

  router.get("/:id", async (req, res) => {
    const { id } = validate(idParams, req.params);
    const { by, sig } = validate(signed, req.query);
    const { monitor, ...incident } = await check(id, by, sig);
    // Enough to recognise the outage; nothing about the account behind it.
    res.json({
      incident: { ...incident, monitor: { name: monitor.name } },
      as: await whoIs(by),
    });
  });

  router.post("/:id", async (req, res) => {
    const { id } = validate(idParams, req.params);
    const { by, sig } = validate(signed, req.body);
    await check(id, by, sig);
    const acknowledged = await acknowledge(deps, id, await whoIs(by));
    const { monitor, ...incident } = await check(id, by, sig);
    res.json({ acknowledged, incident: { ...incident, monitor: { name: monitor.name } } });
  });

  return router;
}
