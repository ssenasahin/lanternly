import {
  parseEncryptionKey,
  type AgentReports,
  type EscalationCanceller,
  type Mailer,
  type MonitorScheduler,
  type PingQueue,
  type PrismaClient,
  type Resolve,
  type ResolveHost,
  type Transport,
} from "@lanternly/db";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { adminRouter } from "./admin/routes.js";
import { agentReportRouter, agentRouter } from "./agents/routes.js";
import { apiKeyRouter, requireApiKey } from "./api-keys/routes.js";
import { requireAuth } from "./auth/middleware.js";
import { authRouter } from "./auth/routes.js";
import { channelRouter } from "./channels/routes.js";
import type { Env } from "./env.js";
import { heartbeatRouter } from "./heartbeats/routes.js";
import { pingRouter } from "./heartbeats/ping.js";
import { healthRouter } from "./health.js";
import { errorHandler } from "./http.js";
import { escalationRouter } from "./escalation/routes.js";
import { ackRouter, incidentRouter } from "./incidents/routes.js";
import { monitorRouter } from "./monitors/routes.js";
import { rejectCrossSiteRequests } from "./origin.js";
import { teamRouter } from "./team/routes.js";
import { openApi } from "./v1/openapi.js";

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  mailer: Mailer;
  scheduler: MonitorScheduler;
  // Where received heartbeat pings go for the worker to apply.
  pings: PingQueue;
  // Calls off waiting escalation steps when an incident is acknowledged.
  escalations: EscalationCanceller;
  // Where stored agent reports go for the worker to judge.
  agentReports: AgentReports;
  // Overridable so the health check can be tested without a database.
  checkDatabase?: () => Promise<void>;
  // Overridable so the SSRF guard can be tested without real DNS.
  resolveHost?: ResolveHost;
  // Overridable so "Test now" can reach a local test server.
  checkResolve?: Resolve;
  // Overridable so alert deliveries can be caught in tests.
  channelTransport?: Transport;
}

// Building the app is separate from listening on a port, so tests can send
// requests to it directly and swap real dependencies for fakes.
export function createApp({
  env,
  prisma,
  mailer,
  scheduler,
  pings,
  escalations,
  agentReports,
  checkDatabase,
  resolveHost,
  checkResolve,
  channelTransport,
}: AppDeps) {
  const app = express();
  const encryptionKey = parseEncryptionKey(env.ENCRYPTION_KEY);
  const authenticate = requireAuth(prisma, env.JWT_SECRET);
  // The API's address as cron jobs and agents see it.
  const publicApiUrl = (env.PUBLIC_API_URL ?? `http://localhost:${env.API_PORT}`).replace(
    /\/$/,
    "",
  );

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
      authenticate,
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
      publicUrl: publicApiUrl,
    }),
  );
  app.use(
    "/api/channels",
    channelRouter({
      prisma,
      authenticate,
      encryptionKey,
      webOrigin: env.WEB_ORIGIN,
      resolveHost,
      transport: channelTransport,
    }),
  );
  app.use("/api/incidents", incidentRouter({ prisma, authenticate, encryptionKey, escalations }));
  app.use("/api/ack", ackRouter({ prisma, encryptionKey, escalations }));
  app.use("/api/team", teamRouter({ prisma, mailer, authenticate, webOrigin: env.WEB_ORIGIN }));
  app.use("/api/escalation-policies", escalationRouter(prisma, authenticate));
  app.use("/api/agents", agentRouter({ prisma, authenticate, scheduler, publicUrl: publicApiUrl }));
  app.use("/api/agent", agentReportRouter({ prisma, reports: agentReports }));
  app.use("/api/api-keys", apiKeyRouter(prisma, authenticate));

  // The public REST API: the same monitor routes the dashboard uses, behind an API
  // key instead of a session, and rate-limited per key.
  app.use(
    "/api/v1/monitors",
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => req.get("authorization") ?? req.ip ?? "",
      message: { error: "Slow down: 120 requests a minute per key." },
    }),
    monitorRouter({
      prisma,
      scheduler,
      authenticate: requireApiKey(prisma),
      encryptionKey,
      resolveHost,
      checkResolve,
    }),
  );
  app.get("/docs/openapi.json", (_req, res) => {
    res.json(openApi);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApi, { customSiteTitle: "Lanternly API" }));
  app.use("/api/admin", adminRouter(prisma, env.JWT_SECRET));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return app;
}
