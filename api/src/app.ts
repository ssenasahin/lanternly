import type { PrismaClient } from "@lanternly/db";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { authRouter } from "./auth/routes.js";
import type { Env } from "./env.js";
import { healthRouter } from "./health.js";
import { errorHandler } from "./http.js";

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  // Overridable so the health check can be tested without a database.
  checkDatabase?: () => Promise<void>;
}

// Building the app is separate from listening on a port, so tests can send
// requests to it directly and swap real dependencies for fakes.
export function createApp({ env, prisma, checkDatabase }: AppDeps) {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);
  app.use(helmet());
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
  app.use("/api/auth", authRouter(env, prisma));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return app;
}
