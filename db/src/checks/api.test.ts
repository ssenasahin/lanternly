import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkApi, MAX_RESPONSE_BYTES, type ApiRequestSpec } from "./api.js";
import { markSlow, type Attempt } from "./types.js";

let server: Server;
let base: string;
// What the last request looked like, so tests can see what was sent.
let last: { method?: string; headers: IncomingMessage["headers"]; body: string };

const json = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });

// A small API with an answer for every case.
const ROUTES: Record<string, () => { status: number; body: string; type?: string }> = {
  "/health": () => json({ status: "ok", data: { items: [{ price: 19.9 }] } }),
  "/degraded": () => json({ status: "degraded", data: { items: [] } }),
  "/broken": () => json({ error: "database unavailable" }, 503),
  "/created": () => json({ id: 1 }, 201),
  "/moved": () => ({ status: 301, body: "" }),
  "/html": () => ({ status: 200, body: "<h1>Hello</h1>", type: "text/html" }),
  "/empty": () => ({ status: 200, body: "" }),
  "/huge": () => ({ status: 200, body: `"${"x".repeat(MAX_RESPONSE_BYTES)}"` }),
  "/echo": () => json({ method: last.method, body: last.body }),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      last = { method: req.method, headers: req.headers, body };
      const route = ROUTES[req.url ?? ""];
      if (!route) return res.writeHead(404).end();
      const answer = route();
      res
        .writeHead(answer.status, { "content-type": answer.type ?? "application/json" })
        .end(answer.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://api.test:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((done) => server.close(done)));

const resolve = async () => ["127.0.0.1"];

const spec = (change: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  url: `${base}/health`,
  method: "GET",
  headers: [],
  bodyType: "NONE",
  body: null,
  expectedStatus: "200-299",
  rules: [],
  ...change,
});

describe("checkApi", () => {
  it("is up when the status and every rule pass", async () => {
    const result = await checkApi(
      spec({
        rules: [
          { path: "status", operator: "EQUALS", expected: "ok" },
          { path: "data.items[0].price", operator: "GREATER_THAN", expected: "0" },
        ],
      }),
      2000,
      resolve,
    );
    expect(result).toMatchObject({ status: "UP", statusCode: 200, error: null });
    expect(result.rules.map((r) => r.passed)).toEqual([true, true]);
    expect(result.response?.body).toContain('"status":"ok"');
    expect(result.responseMs).toBeGreaterThanOrEqual(0);
  });

  it("is down when a rule fails, and says which one", async () => {
    const result = await checkApi(
      spec({
        url: `${base}/degraded`,
        rules: [
          { path: "status", operator: "EQUALS", expected: "ok" },
          { path: "data.items[0].price", operator: "EXISTS", expected: null },
          { path: "data.items", operator: "EXISTS", expected: null },
        ],
      }),
      2000,
      resolve,
    );
    expect(result.status).toBe("DOWN");
    expect(result.error).toBe('status should equal ok, got "degraded" (and 1 more)');
    expect(result.rules.map((r) => [r.passed, r.received])).toEqual([
      [false, '"degraded"'],
      [false, null],
      [true, "[]"],
    ]);
  });

  it("checks the status code against the expected list", async () => {
    const broken = await checkApi(spec({ url: `${base}/broken` }), 2000, resolve);
    expect(broken).toMatchObject({ status: "DOWN", statusCode: 503 });
    expect(broken.error).toBe("HTTP 503, expected 200-299");
    // The body still comes back, so the user can see what the API said.
    expect(broken.response?.body).toContain("database unavailable");

    const created = await checkApi(
      spec({ url: `${base}/created`, expectedStatus: "201" }),
      2000,
      resolve,
    );
    expect(created.status).toBe("UP");
  });

  it("names the status code before a failing rule", async () => {
    const result = await checkApi(
      spec({
        url: `${base}/broken`,
        rules: [{ path: "status", operator: "EXISTS", expected: null }],
      }),
      2000,
      resolve,
    );
    expect(result.error).toBe("HTTP 503, expected 200-299");
    expect(result.rules[0]?.passed).toBe(false);
  });

  it("doesn't follow redirects: the 301 is the answer", async () => {
    const moved = await checkApi(spec({ url: `${base}/moved` }), 2000, resolve);
    expect(moved).toMatchObject({ status: "DOWN", statusCode: 301 });
    const expected = await checkApi(
      spec({ url: `${base}/moved`, expectedStatus: "301" }),
      2000,
      resolve,
    );
    expect(expected.status).toBe("UP");
  });

  it("sends the method, headers and body it was given", async () => {
    const result = await checkApi(
      spec({
        url: `${base}/echo`,
        method: "POST",
        headers: [{ name: "Authorization", value: "Bearer s3cret" }],
        bodyType: "JSON",
        body: '{"ping":true}',
      }),
      2000,
      resolve,
    );
    expect(result.status).toBe("UP");
    expect(last.method).toBe("POST");
    expect(last.body).toBe('{"ping":true}');
    expect(last.headers).toMatchObject({
      authorization: "Bearer s3cret",
      "content-type": "application/json",
    });
  });

  it("sends a form body, and lets a header override its content type", async () => {
    await checkApi(
      spec({ url: `${base}/echo`, method: "PUT", bodyType: "FORM", body: "a=1&b=2" }),
      2000,
      resolve,
    );
    expect(last.headers["content-type"]).toBe("application/x-www-form-urlencoded");

    await checkApi(
      spec({
        url: `${base}/echo`,
        method: "POST",
        bodyType: "JSON",
        body: "{}",
        headers: [{ name: "content-type", value: "application/vnd.api+json" }],
      }),
      2000,
      resolve,
    );
    expect(last.headers["content-type"]).toBe("application/vnd.api+json");
  });

  it("never sends a body with GET", async () => {
    await checkApi(spec({ url: `${base}/echo`, bodyType: "JSON", body: "{}" }), 2000, resolve);
    expect(last).toMatchObject({ method: "GET", body: "" });
  });

  it.each([
    ["/html", "The response isn't JSON"],
    ["/empty", "The response was empty"],
    ["/huge", "The response is over 1 MB, too large to check rules against"],
  ])("explains why rules couldn't run on %s", async (path, error) => {
    const result = await checkApi(
      spec({ url: `${base}${path}`, rules: [{ path: "$", operator: "EXISTS", expected: null }] }),
      2000,
      resolve,
    );
    expect(result).toMatchObject({ status: "DOWN", statusCode: 200, error });
  });

  it("doesn't need JSON when there are no rules", async () => {
    const result = await checkApi(spec({ url: `${base}/html` }), 2000, resolve);
    expect(result).toMatchObject({ status: "UP", rules: [] });
    expect(result.response).toMatchObject({ contentType: "text/html", truncated: false });
  });

  it("refuses a host the guard refuses, without sending anything", async () => {
    const result = await checkApi(spec(), 2000, async () => {
      const { UnsafeTargetError } = await import("../network.js");
      throw new UnsafeTargetError("That host points at a private or reserved network");
    });
    expect(result).toMatchObject({ status: "DOWN", response: null, rules: [] });
    expect(result.error).toMatch(/private or reserved/);
  });
});

describe("markSlow", () => {
  const up: Attempt = { status: "UP", responseMs: 1240, statusCode: 200, error: null };

  it("marks an answer over the limit as degraded", () => {
    expect(markSlow(up, 1000)).toEqual({
      ...up,
      status: "DEGRADED",
      error: "Took 1,240 ms, over the 1,000 ms limit",
    });
  });

  it("leaves fast answers, failures and monitors without a limit alone", () => {
    expect(markSlow(up, 1240)).toBe(up);
    expect(markSlow(up, null)).toBe(up);
    const down: Attempt = { ...up, status: "DOWN", error: "HTTP 500" };
    expect(markSlow(down, 100)).toBe(down);
  });
});
