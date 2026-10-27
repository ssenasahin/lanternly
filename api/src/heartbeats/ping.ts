import type { PingKind, PingQueue, PrismaClient } from "@lanternly/db";
import { Router, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";

// Enough of a job's output to see what went wrong, without storing whole logs.
export const PING_BODY_LIMIT = 10 * 1024;
// A start without a finish is forgotten after a week: whatever ends it isn't that run.
const MAX_RUN_MS = 7 * 24 * 60 * 60 * 1000;

export interface PingDeps {
  prisma: PrismaClient;
  pings: PingQueue;
}

// Reads the first `limit` bytes of the body and drains the rest, so a job that posts a
// huge log still gets its ping counted rather than a "413 Payload Too Large".
function readHead(req: Request, limit: number): Promise<string> {
  if (req.readableEnded) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      if (size < limit) chunks.push(chunk.subarray(0, limit - size));
      size += chunk.length;
    });
    // Postgres text can't hold NUL bytes, which binary output may contain.
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").replaceAll("\0", "")));
    req.on("error", reject);
  });
}

const tooMany: RequestHandler = (_req, res) => {
  res.status(429).type("text").send("Too many pings. Slow down.\n");
};

// The URLs cron jobs call: no sign-in, the token in the path is the credential. They
// answer in plain text, fast, and do only what has to happen now: store the ping and
// move the heartbeat's clock. The worker applies it to the heartbeat's state.
export function pingRouter({ prisma, pings }: PingDeps) {
  const router = Router();
  // Per address, so nobody can make the database look up tokens all day...
  const perAddress = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: tooMany,
  });
  // ...and per heartbeat, so a job stuck in a loop can't flood its own log.
  const perToken = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => String(req.params.token),
    handler: tooMany,
  });

  const receive =
    (kind: PingKind): RequestHandler =>
    async (req, res) => {
      const token = String(req.params.token);
      const body = await readHead(req, PING_BODY_LIMIT);
      const heartbeat = await prisma.heartbeat.findUnique({
        where: { token },
        select: { monitorId: true, lastStartAt: true },
      });
      if (!heartbeat) {
        res.status(404).type("text").send("No heartbeat has this URL.\n");
        return;
      }

      const now = new Date();
      const sinceStart = heartbeat.lastStartAt
        ? now.getTime() - heartbeat.lastStartAt.getTime()
        : null;
      const durationMs =
        kind !== "START" && sinceStart !== null && sinceStart <= MAX_RUN_MS ? sinceStart : null;

      const [ping] = await prisma.$transaction([
        prisma.heartbeatPing.create({
          data: {
            monitorId: heartbeat.monitorId,
            kind,
            receivedAt: now,
            durationMs,
            ip: req.ip ?? null,
            userAgent: req.get("user-agent")?.slice(0, 500) ?? null,
            body: body || null,
          },
          select: { id: true },
        }),
        prisma.heartbeat.update({
          where: { monitorId: heartbeat.monitorId },
          data: kind === "START" ? { lastStartAt: now } : { lastPingAt: now, lastStartAt: null },
        }),
      ]);

      // The ping is saved and the clock moved, so a Redis outage can't make this job
      // look late. Its state catches up with the next ping.
      if (kind !== "START") {
        try {
          await pings.add({ pingId: ping.id.toString() });
        } catch (err) {
          console.error("Couldn't queue a heartbeat ping", err);
        }
      }
      res.type("text").send("OK\n");
    };

  for (const [path, kind] of [
    ["/:token", "SUCCESS"],
    ["/:token/start", "START"],
    ["/:token/fail", "FAIL"],
  ] as const) {
    // GET for the shortest crontab line (curl URL), POST to send the job's output.
    router.get(path, perAddress, perToken, receive(kind));
    router.post(path, perAddress, perToken, receive(kind));
  }

  return router;
}
