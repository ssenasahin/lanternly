import type { Mailer, MonitorScheduler, PrismaClient } from "@lanternly/db";
import { Router } from "express";
import { auditRouter } from "./audit.js";
import { requireAdmin } from "./guard.js";
import { planAdminRouter } from "./plans.js";
import { systemRouter, type SystemProbe } from "./system.js";
import { userAdminRouter } from "./users.js";

export interface AdminDeps {
  prisma: PrismaClient;
  jwtSecret: string;
  mailer: Mailer;
  scheduler: MonitorScheduler;
  webOrigin: string;
  system: SystemProbe;
}

export function adminRouter({
  prisma,
  jwtSecret,
  mailer,
  scheduler,
  webOrigin,
  system,
}: AdminDeps) {
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

  router.use("/users", userAdminRouter({ prisma, mailer, scheduler, webOrigin }));
  router.use("/plans", planAdminRouter(prisma));
  router.use("/system", systemRouter(prisma, system));
  router.use("/audit-logs", auditRouter(prisma));

  return router;
}
