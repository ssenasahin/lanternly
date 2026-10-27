import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp, prisma, resetDatabase, signUp } from "../test/helpers.js";
import { lastDayStrips, rangeStats, uptimeWindows } from "./stats.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const NOW = new Date("2026-10-27T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

async function monitor() {
  const owner = await prisma.user.create({ data: { email: "ada@example.com", passwordHash: "x" } });
  return prisma.monitor.create({
    data: { ownerId: owner.id, name: "Site", type: "HTTP", target: "https://example.com/" },
  });
}

describe("uptimeWindows", () => {
  it("counts raw checks and rollups in the windows they fall in", async () => {
    const { id: monitorId } = await monitor();
    await prisma.checkResult.createMany({
      data: [
        // Last 24 hours: 3 of 4 up.
        { monitorId, status: "UP", checkedAt: ago(1) },
        { monitorId, status: "UP", checkedAt: ago(2) },
        { monitorId, status: "DEGRADED", checkedAt: ago(3) },
        { monitorId, status: "DOWN", checkedAt: ago(4) },
        // Three days ago: 0 of 1.
        { monitorId, status: "DOWN", checkedAt: ago(72) },
      ],
    });
    // Twenty days ago, already rolled up: 95 of 100 up.
    await prisma.checkRollup.create({
      data: { monitorId, hour: ago(480), checks: 100, failures: 5, responseCount: 100 },
    });

    expect(await uptimeWindows(prisma, monitorId, NOW)).toEqual({
      "24h": 3 / 4,
      "7d": 3 / 5,
      "30d": 98 / 105,
    });
  });

  it("reports no uptime, rather than 0% or 100%, for a monitor never checked", async () => {
    const { id } = await monitor();
    expect(await uptimeWindows(prisma, id, NOW)).toEqual({ "24h": null, "7d": null, "30d": null });
  });
});

describe("rangeStats", () => {
  it("computes average and p95 response time over the range", async () => {
    const { id: monitorId } = await monitor();
    // Response times 10, 20, ... 200 ms: 20 checks in the last hour.
    await prisma.checkResult.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        monitorId,
        status: "UP" as const,
        responseMs: (i + 1) * 10,
        checkedAt: new Date(NOW.getTime() - (i + 1) * 60_000),
      })),
    });

    const stats = await rangeStats(prisma, monitorId, "1h", NOW);

    expect(stats).toMatchObject({ checks: 20, failures: 0, uptime: 1, avgMs: 105 });
    // Nearest rank: the 19th of 20 values.
    expect(stats.p95Ms).toBe(190);
  });

  it("weights rollup hours by how many checks they hold", async () => {
    const { id: monitorId } = await monitor();
    await prisma.checkRollup.createMany({
      data: [
        {
          monitorId,
          hour: ago(200),
          checks: 90,
          failures: 0,
          responseCount: 90,
          responseAvgMs: 100,
          responseP95Ms: 150,
        },
        {
          monitorId,
          hour: ago(300),
          checks: 10,
          failures: 10,
          responseCount: 10,
          responseAvgMs: 1000,
          responseP95Ms: 2000,
        },
      ],
    });

    const stats = await rangeStats(prisma, monitorId, "30d", NOW);

    expect(stats).toMatchObject({ checks: 100, failures: 10, uptime: 0.9, avgMs: 190 });
    // 90% of the weight sits at 150 ms, so the 95th percentile is the slow hour.
    expect(stats.p95Ms).toBe(2000);
  });

  it("returns a bucket for every slot, leaving gaps where nothing was checked", async () => {
    const { id: monitorId } = await monitor();
    await prisma.checkResult.createMany({
      data: [
        { monitorId, status: "UP", responseMs: 100, checkedAt: new Date("2026-10-27T11:30:10Z") },
        { monitorId, status: "UP", responseMs: 300, checkedAt: new Date("2026-10-27T11:30:40Z") },
        { monitorId, status: "DOWN", checkedAt: new Date("2026-10-27T11:45:00Z") },
      ],
    });

    const { series, bucketSec } = await rangeStats(prisma, monitorId, "1h", NOW);

    expect(bucketSec).toBe(60);
    expect(series).toHaveLength(61);
    const at = (iso: string) => series.find((b) => b.at === iso);
    expect(at("2026-10-27T11:30:00.000Z")).toEqual({
      at: "2026-10-27T11:30:00.000Z",
      checks: 2,
      failures: 0,
      avgMs: 200,
    });
    expect(at("2026-10-27T11:45:00.000Z")).toMatchObject({ checks: 1, failures: 1, avgMs: null });
    expect(at("2026-10-27T11:31:00.000Z")).toMatchObject({ checks: 0, avgMs: null });
  });
});

describe("lastDayStrips", () => {
  it("puts each check in its hour, oldest first", async () => {
    const { id: monitorId } = await monitor();
    await prisma.checkResult.createMany({
      data: [
        { monitorId, status: "UP", checkedAt: ago(0.5) },
        { monitorId, status: "DOWN", checkedAt: ago(0.7) },
        { monitorId, status: "DOWN", checkedAt: ago(23.5) },
        // Older than a day: not in the strip.
        { monitorId, status: "DOWN", checkedAt: ago(25) },
      ],
    });

    const strip = (await lastDayStrips(prisma, [monitorId], NOW)).get(monitorId)!;

    expect(strip).toHaveLength(24);
    expect(strip[23]).toEqual({ checks: 2, failures: 1 });
    expect(strip[0]).toEqual({ checks: 1, failures: 1 });
    expect(strip.slice(1, 23).every((h) => h.checks === 0)).toBe(true);
  });
});

describe("the stats and incidents endpoints", () => {
  it("serve only the owner", async () => {
    const app = makeApp();
    const ada = await signUp(app, "ada@example.com");
    const grace = await signUp(app, "grace@example.com");
    const created = await request(app)
      .post("/api/monitors")
      .set("Authorization", `Bearer ${grace.accessToken}`)
      .send({ name: "Grace's", type: "HTTP", target: "https://example.com" });
    const monitorId = created.body.monitor.id as string;
    await prisma.incident.create({ data: { monitorId, cause: "HTTP 500" } });

    const asAda = (path: string) =>
      request(app).get(path).set("Authorization", `Bearer ${ada.accessToken}`);
    const asGrace = (path: string) =>
      request(app).get(path).set("Authorization", `Bearer ${grace.accessToken}`);

    expect((await asAda(`/api/monitors/${monitorId}/stats`)).status).toBe(404);
    expect((await asAda("/api/incidents")).body.incidents).toEqual([]);
    expect((await asAda(`/api/incidents?monitorId=${monitorId}`)).body.incidents).toEqual([]);

    const stats = await asGrace(`/api/monitors/${monitorId}/stats?range=7d`);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ range: "7d", windows: { "24h": null }, checks: 0 });
    const incidents = await asGrace("/api/incidents?status=open");
    expect(incidents.body.incidents).toHaveLength(1);
    expect(incidents.body.incidents[0].monitor.name).toBe("Grace's");
  });

  it("rejects a range it doesn't know", async () => {
    const app = makeApp();
    const { accessToken } = await signUp(app);
    const created = await request(app)
      .post("/api/monitors")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "Site", type: "HTTP", target: "https://example.com" });

    const res = await request(app)
      .get(`/api/monitors/${created.body.monitor.id}/stats?range=1y`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });
});
