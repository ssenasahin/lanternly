import { sealHeaders, type NotificationJob } from "@lanternly/db";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processCheck } from "./process-check.js";
import { recordCheck } from "./record.js";
import { makeMonitor, prisma, resetDatabase } from "./test/database.js";

// A server we can switch off and on, standing in for a customer's site.
let server: Server;
let healthy = true;
// While above zero, the next requests fail regardless of `healthy`.
let failNext = 0;
let requests = 0;
// How long the site takes to answer, and the last Authorization header it saw.
let delayMs = 0;
let authorization: string | undefined;
beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    authorization = req.headers.authorization;
    const ok = healthy && failNext-- <= 0;
    const body = JSON.stringify({ status: ok ? "ok" : "degraded" });
    setTimeout(() => res.writeHead(ok ? 200 : 503).end(body), delayMs);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  await prisma.$disconnect();
});

const sent: NotificationJob[] = [];
beforeEach(async () => {
  healthy = true;
  failNext = 0;
  requests = 0;
  delayMs = 0;
  sent.length = 0;
  await resetDatabase();
});

const incidentOf = (job?: NotificationJob) => (job && "incidentId" in job ? job.incidentId : null);

const encryptionKey = Buffer.alloc(32, 7);
const deps = {
  prisma,
  notify: async (job: NotificationJob) => sent.push(job),
  encryptionKey,
  resolve: async () => ["127.0.0.1"],
};

const siteUrl = () => `http://site.test:${(server.address() as AddressInfo).port}/`;

const up = { status: "UP", responseMs: 40, statusCode: 200, error: null } as const;
const down = { status: "DOWN", responseMs: null, statusCode: 503, error: "HTTP 503" } as const;

describe("processCheck", () => {
  it("opens one incident for an outage and closes it on recovery", async () => {
    const site = `http://site.test:${(server.address() as AddressInfo).port}/`;
    const monitor = await makeMonitor({ target: site });

    await processCheck(monitor.id, deps);
    healthy = false;
    await processCheck(monitor.id, deps);
    await processCheck(monitor.id, deps);
    await processCheck(monitor.id, deps);
    healthy = true;
    await processCheck(monitor.id, deps);

    // Five checks stored, one alert each way, and one closed incident in between.
    expect(await prisma.checkResult.count()).toBe(5);
    expect(sent.map((j) => j.kind)).toEqual(["down", "up"]);
    const incidents = await prisma.incident.findMany();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ cause: "HTTP 503", id: incidentOf(sent[0]) });
    expect(incidents[0]!.resolvedAt).not.toBeNull();
    expect(await prisma.monitor.findUniqueOrThrow({ where: { id: monitor.id } })).toMatchObject({
      status: "UP",
    });
  });

  it("retries before calling a monitor down", async () => {
    const site = `http://site.test:${(server.address() as AddressInfo).port}/`;
    const monitor = await makeMonitor({ target: site });
    await prisma.monitor.update({ where: { id: monitor.id }, data: { retries: 2 } });

    // Fails the first two attempts, then answers: a blip, not an outage.
    failNext = 2;
    await processCheck(monitor.id, deps);

    expect(requests).toBe(3);
    expect(sent).toEqual([]);
    expect(await prisma.checkResult.findFirstOrThrow()).toMatchObject({ status: "UP" });
  });

  it("calls an API with its stored headers and checks the answer against its rules", async () => {
    const monitor = await makeMonitor({ type: "API", target: siteUrl() });
    await prisma.apiRequest.create({
      data: {
        monitorId: monitor.id,
        headers: sealHeaders(
          [{ name: "Authorization", value: "Bearer s3cret", secret: true }],
          encryptionKey,
        ),
        // A 503 still counts, so the rule decides.
        expectedStatus: "2xx, 503",
      },
    });
    await prisma.assertion.create({
      data: {
        monitorId: monitor.id,
        position: 0,
        path: "status",
        operator: "EQUALS",
        expected: "ok",
      },
    });

    await processCheck(monitor.id, deps);
    expect(authorization).toBe("Bearer s3cret");
    // A passing check keeps no verdicts.
    expect(await prisma.checkResult.findFirstOrThrow()).toMatchObject({
      status: "UP",
      rules: null,
    });

    healthy = false;
    await processCheck(monitor.id, deps);
    const failed = await prisma.checkResult.findFirstOrThrow({ where: { status: "DOWN" } });
    expect(failed.error).toBe('status should equal ok, got "degraded"');
    expect(failed.rules).toEqual([
      { path: "status", operator: "EQUALS", expected: "ok", passed: false, received: '"degraded"' },
    ]);
    expect(await prisma.incident.findFirstOrThrow()).toMatchObject({ cause: failed.error });
    expect(sent.map((j) => j.kind)).toEqual(["down"]);
  });

  it("warns once when answers get slower than the limit, without an incident", async () => {
    const monitor = await makeMonitor({ target: siteUrl() });
    await prisma.monitor.update({ where: { id: monitor.id }, data: { slowAfterMs: 100 } });

    await processCheck(monitor.id, deps);
    delayMs = 150;
    await processCheck(monitor.id, deps);
    await processCheck(monitor.id, deps);
    delayMs = 0;
    await processCheck(monitor.id, deps);

    const statuses = await prisma.checkResult.findMany({ orderBy: { checkedAt: "asc" } });
    expect(statuses.map((c) => c.status)).toEqual(["UP", "DEGRADED", "DEGRADED", "UP"]);
    expect(statuses[1]!.error).toMatch(/^Took \d+ ms, over the 100 ms limit$/);
    expect(sent.map((j) => j.kind)).toEqual(["degraded"]);
    expect(await prisma.incident.count()).toBe(0);
  });

  it("skips a paused monitor", async () => {
    const monitor = await makeMonitor({ target: "http://site.test/" });
    await prisma.monitor.update({ where: { id: monitor.id }, data: { isActive: false } });

    await processCheck(monitor.id, deps);

    expect(await prisma.checkResult.count()).toBe(0);
  });
});

describe("recordCheck", () => {
  it("keeps the result but not the state change if the monitor was paused mid-check", async () => {
    const monitor = await makeMonitor({ target: "http://site.test/" });
    await prisma.monitor.update({ where: { id: monitor.id }, data: { status: "UP" } });
    // The check started while the monitor was up; then the user paused it.
    await prisma.monitor.update({ where: { id: monitor.id }, data: { status: "PAUSED" } });

    const alert = await recordCheck(prisma, monitor.id, "UP", down);

    expect(alert).toBeNull();
    expect(await prisma.checkResult.count()).toBe(1);
    expect(await prisma.incident.count()).toBe(0);
    expect(await prisma.monitor.findUniqueOrThrow({ where: { id: monitor.id } })).toMatchObject({
      status: "PAUSED",
    });
  });

  it("lets only one of two overlapping checks open the incident", async () => {
    const monitor = await makeMonitor({ target: "http://site.test/" });
    await prisma.monitor.update({ where: { id: monitor.id }, data: { status: "UP" } });

    const alerts = await Promise.all([
      recordCheck(prisma, monitor.id, "UP", down),
      recordCheck(prisma, monitor.id, "UP", down),
    ]);

    expect(alerts.filter(Boolean)).toHaveLength(1);
    expect(await prisma.incident.count()).toBe(1);
    expect(await prisma.checkResult.count()).toBe(2);
  });

  it("does nothing for a monitor deleted mid-check", async () => {
    const monitor = await makeMonitor({ target: "http://site.test/" });
    await prisma.monitor.delete({ where: { id: monitor.id } });

    await expect(recordCheck(prisma, monitor.id, "PENDING", up)).resolves.toBeNull();
  });
});
