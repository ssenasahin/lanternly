import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp, prisma, resetDatabase, schedule, signUp } from "../test/helpers.js";

// The API a monitor watches. In tests every host leads here (see helpers.ts).
let server: Server;
let port: number;
let seen: IncomingHttpHeaders = {};
beforeAll(async () => {
  server = createServer((req, res) => {
    seen = req.headers;
    const body = req.url === "/down" ? { status: "degraded" } : { status: "ok", items: [1, 2] };
    res.writeHead(req.url === "/down" ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  await prisma.$disconnect();
});
beforeEach(resetDatabase);

async function signedIn(email?: string) {
  const app = makeApp();
  const { accessToken } = await signUp(app, email);
  const as = (req: request.Test) => req.set("Authorization", `Bearer ${accessToken}`);
  return { app, as };
}

const orders = {
  name: "Orders API",
  type: "API",
  target: "https://api.example.com/v1/health",
  api: {
    method: "POST",
    headers: [
      { name: "Accept-Language", value: "en", secret: false },
      { name: "Authorization", value: "Bearer s3cret", secret: true },
    ],
    bodyType: "JSON",
    body: '{"probe":true}',
    expectedStatus: "200 - 299 , 304",
    rules: [
      { path: "status", operator: "EQUALS", expected: "ok" },
      { path: "items", operator: "EXISTS", expected: "ignored" },
    ],
  },
};

async function created() {
  const session = await signedIn();
  const res = await session.as(request(session.app).post("/api/monitors")).send(orders);
  expect(res.status).toBe(201);
  return { ...session, id: res.body.monitor.id as string, monitor: res.body.monitor };
}

describe("API monitors", () => {
  it("stores the request and rules, and never sends a secret back", async () => {
    const { monitor } = await created();

    expect(monitor).toMatchObject({ type: "API", slowAfterMs: null, status: "PENDING" });
    expect(monitor.api).toEqual({
      method: "POST",
      headers: [
        { name: "Accept-Language", value: "en", secret: false },
        { name: "Authorization", value: null, secret: true },
      ],
      bodyType: "JSON",
      body: '{"probe":true}',
      expectedStatus: "200-299, 304",
      rules: [
        { path: "status", operator: "EQUALS", expected: "ok" },
        // A presence check compares with nothing.
        { path: "items", operator: "EXISTS", expected: null },
      ],
    });
    expect(schedule.get(monitor.id)).toBe(60);
  });

  it("keeps headers encrypted at rest", async () => {
    await created();
    const stored = await prisma.apiRequest.findFirstOrThrow();
    expect(stored.headers).toMatch(/^v1:/);
    expect(stored.headers).not.toContain("s3cret");
  });

  it("starts a monitor switched to API from the defaults", async () => {
    const { app, as } = await signedIn();
    const site = await as(request(app).post("/api/monitors")).send({
      name: "Site",
      type: "HTTP",
      target: "https://example.com",
    });
    expect(site.body.monitor.api).toBeNull();

    const res = await as(request(app).patch(`/api/monitors/${site.body.monitor.id}`)).send({
      type: "API",
    });
    expect(res.body.monitor.api).toMatchObject({
      method: "GET",
      headers: [],
      expectedStatus: "200-299",
      rules: [],
    });
  });

  it("keeps a secret header the edit left blank, and replaces the rules", async () => {
    const { app, as, id, monitor } = await created();

    const res = await as(request(app).patch(`/api/monitors/${id}`)).send({
      api: {
        ...monitor.api,
        rules: [{ path: "items[0]", operator: "GREATER_THAN", expected: "0" }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.monitor.api.rules).toEqual([
      { path: "items[0]", operator: "GREATER_THAN", expected: "0" },
    ]);
    expect(await prisma.assertion.count()).toBe(1);

    // The worker still gets the real value.
    const test = await as(request(app).post("/api/monitors/test")).send({
      target: `http://api.example.com:${port}/`,
      api: res.body.monitor.api,
      monitorId: id,
    });
    expect(test.status).toBe(200);
    expect(seen.authorization).toBe("Bearer s3cret");
  });

  it("asks for the value of a new secret header", async () => {
    const { app, as, id, monitor } = await created();
    const res = await as(request(app).patch(`/api/monitors/${id}`)).send({
      api: {
        ...monitor.api,
        headers: [...monitor.api.headers, { name: "X-Api-Key", value: null, secret: true }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({ "api.headers.2.value": ["Enter a value"] });
  });

  it("drops the request and rules when it stops being an API monitor", async () => {
    const { app, as, id } = await created();
    const res = await as(request(app).patch(`/api/monitors/${id}`)).send({
      type: "HTTP",
    });
    expect(res.body.monitor.api).toBeNull();
    expect(await prisma.apiRequest.count()).toBe(0);
    expect(await prisma.assertion.count()).toBe(0);
  });

  it.each([
    [{ expectedStatus: "ok" }, "api.expectedStatus"],
    [{ bodyType: "JSON", body: "{oops" }, "api.body"],
    [{ method: "TRACE" }, "api.method"],
    [{ headers: [{ name: "Bad Name", value: "x" }] }, "api.headers.0.name"],
    [{ headers: [{ name: "Host", value: "x" }] }, "api.headers.0.name"],
    [{ headers: [{ name: "X-A", value: "line\nbreak" }] }, "api.headers.0.value"],
    [{ headers: [{ name: "X-A", value: null }] }, "api.headers.0.value"],
    [
      {
        headers: [
          { name: "X-A", value: "1" },
          { name: "x-a", value: "2" },
        ],
      },
      "api.headers.1.name",
    ],
    [{ rules: [{ path: "a..b", operator: "EXISTS" }] }, "api.rules.0.path"],
    [
      { rules: [{ path: "price", operator: "GREATER_THAN", expected: "lots" }] },
      "api.rules.0.expected",
    ],
    [{ rules: [{ path: "status", operator: "EQUALS" }] }, "api.rules.0.expected"],
    [{ rules: [{ path: "status", operator: "MATCHES", expected: "x" }] }, "api.rules.0.operator"],
  ])("rejects %j, under the field it's about", async (change, field) => {
    const { app, as } = await signedIn();
    const res = await as(request(app).post("/api/monitors")).send({
      ...orders,
      api: { ...orders.api, ...change },
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty([field]);
  });

  it("wants the slowness limit below the timeout", async () => {
    const { app, as } = await signedIn();
    const res = await as(request(app).post("/api/monitors")).send({
      ...orders,
      timeoutMs: 5000,
      slowAfterMs: 5000,
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty("slowAfterMs");

    const ok = await as(request(app).post("/api/monitors")).send({ ...orders, slowAfterMs: 800 });
    expect(ok.body.monitor.slowAfterMs).toBe(800);
  });
});

describe("Test now", () => {
  const test = (as: (req: request.Test) => request.Test, app: object, body: object) =>
    as(request(app as never).post("/api/monitors/test")).send(body);

  it("sends the request as the form stands and reports every rule", async () => {
    const { app, as } = await signedIn();
    const res = await test(as, app, {
      target: `http://api.example.com:${port}/`,
      api: {
        ...orders.api,
        rules: [
          { path: "status", operator: "EQUALS", expected: "ok" },
          { path: "items", operator: "CONTAINS", expected: "3" },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      status: "DOWN",
      statusCode: 200,
      error: "items should contain 3, got [1,2]",
      rules: [
        { path: "status", passed: true, received: '"ok"' },
        { path: "items", passed: false, received: "[1,2]" },
      ],
      response: { contentType: "application/json", body: '{"status":"ok","items":[1,2]}' },
    });
    expect(seen).toMatchObject({ authorization: "Bearer s3cret", "accept-language": "en" });
    // Nothing is saved.
    expect(await prisma.monitor.count()).toBe(0);
  });

  it("reports a failing status code with the body that came with it", async () => {
    const { app, as } = await signedIn();
    const res = await test(as, app, { target: `http://api.example.com:${port}/down`, api: {} });
    expect(res.body.result).toMatchObject({
      status: "DOWN",
      statusCode: 503,
      error: "HTTP 503, expected 200-299",
    });
    expect(res.body.result.response.body).toContain("degraded");
  });

  it("refuses a private address before sending anything", async () => {
    const { app, as } = await signedIn();
    const res = await test(as, app, { target: "http://intranet.example.com/", api: {} });
    expect(res.status).toBe(400);
    expect(res.body.details.target[0]).toMatch(/private or reserved/);
  });

  it("only fills in secrets from the caller's own monitors", async () => {
    const { id } = await created();
    const { app, as } = await signedIn("grace@example.com");
    const res = await test(as, app, {
      target: `http://api.example.com:${port}/`,
      api: { headers: [{ name: "Authorization", value: null, secret: true }] },
      monitorId: id,
    });
    expect(res.status).toBe(404);
  });

  it("limits how often one user can test", async () => {
    const { app, as } = await signedIn();
    const body = { target: `http://api.example.com:${port}/`, api: {} };
    for (let i = 0; i < 20; i++) expect((await test(as, app, body)).status).toBe(200);
    expect((await test(as, app, body)).status).toBe(429);
  });
});
