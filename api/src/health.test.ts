import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("GET /api/health", () => {
  it("reports ok when the database answers", async () => {
    const app = createApp({ checkDatabase: async () => {} });

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", database: "up" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const app = createApp({
      checkDatabase: async () => {
        throw new Error("connection refused");
      },
    });

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "degraded", database: "down" });
  });

  it("sends security headers", async () => {
    const app = createApp({ checkDatabase: async () => {} });

    const res = await request(app).get("/api/health");

    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
