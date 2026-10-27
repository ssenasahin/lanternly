import type { NotificationJob } from "@lanternly/db";
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
beforeAll(async () => {
  server = createServer((_req, res) => {
    requests++;
    const ok = healthy && failNext-- <= 0;
    res.writeHead(ok ? 200 : 503).end();
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
  sent.length = 0;
  await resetDatabase();
});

const deps = {
  prisma,
  notify: async (job: NotificationJob) => sent.push(job),
  resolve: async () => ["127.0.0.1"],
};

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
    expect(incidents[0]).toMatchObject({ cause: "HTTP 503", id: sent[0]!.incidentId });
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
