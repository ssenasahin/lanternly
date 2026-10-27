import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp, prisma, resetDatabase, signUp } from "../test/helpers.js";
import { openApi } from "./openapi.js";

afterAll(() => prisma.$disconnect());
beforeEach(resetDatabase);

async function withKey(email = "ada@example.com") {
  const app = makeApp();
  const { accessToken } = await signUp(app, email);
  const as = (req: request.Test) => req.set("Authorization", `Bearer ${accessToken}`);
  const res = await as(request(app).post("/api/api-keys")).send({ name: "Terraform" });
  expect(res.status).toBe(201);
  const key = res.body.secret as string;
  const withApiKey = (req: request.Test) => req.set("Authorization", `Bearer ${key}`);
  return { app, as, key, withApiKey, id: res.body.key.id as string };
}

describe("API keys", () => {
  it("are shown once and stored as a hash", async () => {
    const { app, as, key } = await withKey();
    expect(key).toMatch(/^lnly_sk_[\w-]{43}$/);
    const stored = await prisma.apiKey.findFirstOrThrow();
    expect(stored.keyHash).not.toContain(key);
    const list = await as(request(app).get("/api/api-keys"));
    expect(list.body.keys).toEqual([
      expect.objectContaining({
        name: "Terraform",
        prefix: key.slice(0, 12),
        lastUsedAt: null,
        revokedAt: null,
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain(key);
  });

  it("stop working the moment they're revoked", async () => {
    const { app, as, withApiKey, id } = await withKey();
    expect((await withApiKey(request(app).get("/api/v1/monitors"))).status).toBe(200);
    expect((await as(request(app).delete(`/api/api-keys/${id}`))).status).toBe(204);
    const after = await withApiKey(request(app).get("/api/v1/monitors"));
    expect(after.status).toBe(401);
    const list = await as(request(app).get("/api/api-keys"));
    expect(list.body.keys[0].revokedAt).not.toBeNull();
  });

  it("remember when they were last used", async () => {
    const { app, withApiKey } = await withKey();
    await withApiKey(request(app).get("/api/v1/monitors"));
    const stored = await prisma.apiKey.findFirstOrThrow();
    expect(stored.lastUsedAt).not.toBeNull();
  });
});

describe("/api/v1/monitors", () => {
  it("manages monitors from code, as the key's owner", async () => {
    const { app, as, withApiKey } = await withKey();
    const created = await withApiKey(request(app).post("/api/v1/monitors")).send({
      name: "Docs",
      type: "HTTP",
      target: "https://example.com/docs",
    });
    expect(created.status).toBe(201);
    const id = created.body.monitor.id as string;

    const edited = await withApiKey(request(app).patch(`/api/v1/monitors/${id}`)).send({
      intervalSec: 120,
    });
    expect(edited.body.monitor.intervalSec).toBe(120);
    const paused = await withApiKey(request(app).post(`/api/v1/monitors/${id}/pause`));
    expect(paused.body.monitor.status).toBe("PAUSED");

    // The dashboard sees the same monitor.
    const seen = await as(request(app).get(`/api/monitors/${id}`));
    expect(seen.body.monitor.name).toBe("Docs");

    expect((await withApiKey(request(app).delete(`/api/v1/monitors/${id}`))).status).toBe(204);
  });

  it("keeps a key to its owner's monitors", async () => {
    const ada = await withKey("ada@example.com");
    const created = await ada.withApiKey(request(ada.app).post("/api/v1/monitors")).send({
      name: "Docs",
      type: "HTTP",
      target: "https://example.com",
    });
    const other = await withKey("other@example.com");
    const res = await other.withApiKey(
      request(other.app).get(`/api/v1/monitors/${created.body.monitor.id}`),
    );
    expect(res.status).toBe(404);
  });

  it("wants a key, not a session token", async () => {
    const { app, as } = await withKey();
    const res = await as(request(app).get("/api/v1/monitors"));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key/);
  });

  it("is documented at /docs", async () => {
    const app = makeApp();
    const spec = await request(app).get("/docs/openapi.json");
    expect(spec.body.info.title).toBe("Lanternly API");
    const page = await request(app).get("/docs/").redirects(1);
    expect(page.status).toBe(200);
    expect(page.text).toContain("swagger-ui");
  });

  it("answers on every documented path", async () => {
    const { app, withApiKey } = await withKey();
    const created = await withApiKey(request(app).post("/api/v1/monitors")).send({
      name: "Docs",
      type: "HTTP",
      target: "https://example.com",
    });
    const id = created.body.monitor.id as string;
    for (const [path, methods] of Object.entries(openApi.paths)) {
      const url = `/api/v1${path.replace("{id}", id)}`;
      for (const method of Object.keys(methods).filter(
        (m) => m !== "parameters" && m !== "delete",
      )) {
        const res = await withApiKey(request(app)[method as "get"](url)).send({});
        expect([200, 201, 400], `${method} ${url}`).toContain(res.status);
      }
    }
  });
});
