import { type AgentReports, type MonitorScheduler, type PrismaClient } from "@lanternly/db";
import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authOf } from "../auth/middleware.js";
import { sha256 } from "../auth/tokens.js";
import { HttpError, validate } from "../http.js";
import { MAX_MONITORS_PER_USER } from "../monitors/routes.js";

const KEY_PREFIX = "lnly_ag_";

// A new agent key. Shown once; only its hash is stored.
function newKey() {
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { key, keyHash: sha256(key), keyPrefix: key.slice(0, KEY_PREFIX.length + 4) };
}

const RANGES = {
  "1h": { ms: 60 * 60_000, bucket: "1 minute" },
  "24h": { ms: 24 * 60 * 60_000, bucket: "10 minutes" },
  "7d": { ms: 7 * 24 * 60 * 60_000, bucket: "1 hour" },
  "30d": { ms: 30 * 24 * 60 * 60_000, bucket: "6 hours" },
} as const;
type Range = keyof typeof RANGES;

const idParams = z.object({ id: z.uuid() });
const createSchema = z.object({
  name: z.string().trim().min(1, "Give the server a name").max(100),
});
const metricsQuery = z.object({
  range: z.enum(Object.keys(RANGES) as [Range, ...Range[]]).default("1h"),
});

const percent = z.number().min(0).max(100);
const reportSchema = z.object({
  host: z
    .object({ hostname: z.string().max(255), platform: z.string().max(100) })
    .partial()
    .optional(),
  // Up to two hours of samples: what an agent buffers while it can't reach us.
  samples: z
    .array(z.object({ at: z.coerce.date(), cpu: percent, memory: percent, disk: percent }))
    .min(1)
    .max(120),
});

export interface AgentDeps {
  prisma: PrismaClient;
  authenticate: RequestHandler;
  scheduler: MonitorScheduler;
  reports: AgentReports;
  // The API's address as the agent will see it, for the install command.
  publicUrl: string;
}

// What the owner sees about an agent, from the dashboard.
export function agentRouter({
  prisma,
  authenticate,
  scheduler,
  publicUrl,
}: Omit<AgentDeps, "reports">) {
  const router = Router();
  router.use(authenticate);

  async function findOwned(id: string, ownerId: string) {
    const agent = await prisma.agent.findFirst({
      where: { monitorId: id, monitor: { ownerId } },
      select: {
        monitorId: true,
        keyPrefix: true,
        hostname: true,
        platform: true,
        lastSeenAt: true,
      },
    });
    if (!agent) throw new HttpError(404, "Agent not found");
    return agent;
  }

  const install = (key: string) => ({
    shell: `npm run build -w agent && LANTERNLY_URL=${publicUrl} LANTERNLY_AGENT_KEY=${key} npm run start -w agent`,
    powershell: `npm run build -w agent; $env:LANTERNLY_URL="${publicUrl}"; $env:LANTERNLY_AGENT_KEY="${key}"; npm run start -w agent`,
  });

  // An agent is a monitor of its own type, so incidents, alerts and escalation
  // work for servers exactly as they do for websites.
  router.post("/", async (req, res) => {
    const { userId } = authOf(req);
    const { name } = validate(createSchema, req.body);
    const count = await prisma.monitor.count({ where: { ownerId: userId } });
    if (count >= MAX_MONITORS_PER_USER) {
      throw new HttpError(403, `You can have up to ${MAX_MONITORS_PER_USER} monitors`);
    }
    const { key, keyHash, keyPrefix } = newKey();
    const monitor = await prisma.monitor.create({
      data: {
        ownerId: userId,
        name,
        type: "AGENT",
        target: "",
        agent: { create: { keyHash, keyPrefix } },
      },
    });
    await scheduler.sync(monitor).catch(() => {});
    res.status(201).json({ id: monitor.id, key, install: install(key) });
  });

  router.get("/:id", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const agent = await findOwned(id, userId);
    const latest = await prisma.agentMetric.findFirst({
      where: { agentId: id },
      orderBy: { at: "desc" },
      select: { at: true, cpu: true, memory: true, disk: true },
    });
    res.json({ agent: { ...agent, latest } });
  });

  // Averages per bucket, so a month of minute samples comes back as a chart, not a flood.
  router.get("/:id/metrics", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    const { range } = validate(metricsQuery, req.query);
    await findOwned(id, userId);
    const { ms, bucket } = RANGES[range];
    const rows = await prisma.$queryRaw<{ at: Date; cpu: number; memory: number; disk: number }[]>`
      SELECT date_bin(${bucket}::interval, at, TIMESTAMP '2000-01-01') AS at,
             avg(cpu)::float8 AS cpu, avg(memory)::float8 AS memory, avg(disk)::float8 AS disk
      FROM agent_metrics
      WHERE agent_id = ${id}::uuid AND at >= ${new Date(Date.now() - ms)}
      GROUP BY 1 ORDER BY 1`;
    res.json({ range, points: rows });
  });

  // A lost or leaked key: the old one stops working at once.
  router.post("/:id/key", async (req, res) => {
    const { userId } = authOf(req);
    const { id } = validate(idParams, req.params);
    await findOwned(id, userId);
    const { key, keyHash, keyPrefix } = newKey();
    await prisma.agent.update({ where: { monitorId: id }, data: { keyHash, keyPrefix } });
    res.json({ key, install: install(key) });
  });

  return router;
}

// Where agents send what they measured. They authenticate with their own key, never
// a user's session, and can do nothing else with it.
export function agentReportRouter({ prisma, reports }: Pick<AgentDeps, "prisma" | "reports">) {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => req.get("authorization") ?? req.ip ?? "",
      message: { error: "Too many reports. An agent sends one a minute." },
    }),
  );

  router.post("/metrics", async (req, res) => {
    const header = req.get("authorization");
    const key = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const agent = key.startsWith(KEY_PREFIX)
      ? await prisma.agent.findUnique({ where: { keyHash: sha256(key) } })
      : null;
    if (!agent) throw new HttpError(401, "Unknown agent key");

    const { host, samples } = validate(reportSchema, req.body);
    // Samples from the future, or older than the buffer could hold, are clock trouble.
    const now = Date.now();
    const usable = samples.filter(
      (s) => s.at.getTime() <= now + 60_000 && s.at.getTime() >= now - 2 * 60 * 60_000,
    );
    if (usable.length === 0) {
      throw new HttpError(400, "Every sample's time is off by hours. Check the server's clock.");
    }

    await prisma.$transaction([
      prisma.agentMetric.createMany({
        data: usable.map((s) => ({ agentId: agent.monitorId, ...s })),
      }),
      prisma.agent.update({
        where: { monitorId: agent.monitorId },
        data: { lastSeenAt: new Date(now), hostname: host?.hostname, platform: host?.platform },
      }),
    ]);
    // The worker judges the samples; a slow Redis mustn't make the agent resend them.
    await reports.add({ agentId: agent.monitorId }).catch((err) => {
      console.error("Couldn't queue an agent report; the next one will catch up", err);
    });
    res.status(202).json({ accepted: usable.length });
  });

  return router;
}
