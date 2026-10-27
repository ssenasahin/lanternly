import type { PrismaClient } from "@lanternly/db";
import { Router } from "express";
import { z } from "zod";
import { authOf, requireAuth } from "../auth/middleware.js";
import { validate } from "../http.js";

const listQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("all"),
  monitorId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function incidentRouter(prisma: PrismaClient, jwtSecret: string) {
  const router = Router();
  router.use(requireAuth(prisma, jwtSecret));

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
        monitor: { select: { id: true, name: true, type: true, target: true } },
      },
    });
    res.json({ incidents });
  });

  return router;
}
