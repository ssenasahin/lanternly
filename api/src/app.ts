import express from "express";
import helmet from "helmet";
import { healthRouter, type HealthDeps } from "./health.js";

export type AppDeps = HealthDeps;

// Building the app is separate from listening on a port, so tests can send
// requests to it directly and swap real dependencies for fakes.
export function createApp(deps: AppDeps) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));

  app.use("/api/health", healthRouter(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
