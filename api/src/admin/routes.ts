import type { PrismaClient } from "@lanternly/db";
import { Router } from "express";
import { requireAdmin } from "./guard.js";

export function adminRouter(prisma: PrismaClient, jwtSecret: string) {
  const router = Router();
  // Applied to the whole router, so a new admin endpoint can't be added unguarded.
  router.use(...requireAdmin(prisma, jwtSecret));

  router.get("/overview", async (_req, res) => {
    const [users, monitors, liveSessions] = await Promise.all([
      prisma.user.count(),
      prisma.monitor.count(),
      prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    res.json({ users, monitors, liveSessions });
  });

  return router;
}
