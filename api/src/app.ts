import {
  parseEncryptionKey,
  type Mailer,
  type MonitorScheduler,
  type PingQueue,
  type PrismaClient,
  type Resolve,
  type ResolveHost,
} from "@lanternly/db";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { adminRouter } from "./admin/routes.js";
import { authRouter } from "./auth/routes.js";
import type { Env } from "./env.js";
import { heartbeatRouter } from "./heartbeats/routes.js";
import { pingRouter } from "./heartbeats/ping.js";
import { healthRouter } from "./health.js";
import { errorHandler } from "./http.js";
import { incidentRouter } from "./incidents/routes.js";
import { monitorRouter } from "./monitors/routes.js";
import { rejectCrossSiteRequests } from "./origin.js";

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  mailer: Mailer;
  scheduler: MonitorScheduler;
  // Where received heartbeat pings go for the worker to apply.
  pings: PingQueue;
  // Overridable so the health check can be tested without a database.
  checkDatabase?: () => Promise<void>;
  // Overridable so the SSRF guard can be tested without real DNS.
  resolveHost?: ResolveHost;
  // Overridable so "Test now" can reach a local test server.
  checkResolve?: Resolve;
}

// Building the app is separate from listening on a port, so tests can send
// requests to it directly and swap real dependencies for fakes.
export function createApp({
  env,
  prisma,
  mailer,
  scheduler,
  pings,
  checkDatabase,
  resolveHost,
  checkResolve,
}: AppDeps) {
  const app = express();
  const encryptionKey = parseEncryptionKey(env.ENCRYPTION_KEY);

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);
  app.use(helmet());
  // Cron jobs, not browsers, call these: no CORS, no cookies, and they read their own
  // body, so they come before the JSON parser would consume it.
  app.use("/ping", pingRouter({ prisma, pings }));
  // Only our own web app may call the API from a browser, with credentials.
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(rejectCrossSiteRequests(env.WEB_ORIGIN));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.use(
    "/api/health",
    healthRouter({
      checkDatabase:
        checkDatabase ??
        (async () => {
          await prisma.$queryRaw`SELECT 1`;
        }),
    }),
  );
  app.use("/api/auth", authRouter({ env, prisma, mailer, encryptionKey }));
  app.use(
    "/api/monitors",
    monitorRouter({
      prisma,
      scheduler,
      jwtSecret: env.JWT_SECRET,
      encryptionKey,
      resolveHost,
      checkResolve,
    }),
  );
  app.use(
    "/api/heartbeats",
    heartbeatRouter({
      prisma,
      jwtSecret: env.JWT_SECRET,
      publicUrl: (env.PUBLIC_API_URL ?? `http://localhost:${env.API_PORT}`).replace(/\/$/, ""),
    }),
  );
  app.use("/api/incidents", incidentRouter(prisma, env.JWT_SECRET));
  app.use("/api/admin", adminRouter(prisma, env.JWT_SECRET));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return app;
}
