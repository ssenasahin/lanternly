import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pruneOldPings, rollUpOldChecks, rollupCutoff } from "./rollup.js";
import { makeHeartbeat, makeMonitor, prisma, resetDatabase } from "./test/database.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const NOW = new Date("2026-10-27T03:00:00Z");
const daysAgo = (days: number, minutes = 0) =>
  new Date(NOW.getTime() - days * 86_400_000 + minutes * 60_000);

describe("rollupCutoff", () => {
  it("is the start of the hour seven days back", () => {
    expect(rollupCutoff(new Date("2026-10-27T03:42:10Z"))).toEqual(
      new Date("2026-10-20T03:00:00Z"),
    );
  });
});

describe("rollUpOldChecks", () => {
  it("summarises old results by hour and deletes them, keeping recent ones", async () => {
    const { id: monitorId } = await makeMonitor({ target: "https://example.com/" });
    await prisma.checkResult.createMany({
      data: [
        // One hour, ten days ago: three checks, one of them down.
        { monitorId, status: "UP", responseMs: 100, checkedAt: daysAgo(10, 1) },
        { monitorId, status: "UP", responseMs: 300, checkedAt: daysAgo(10, 2) },
        { monitorId, status: "DOWN", responseMs: null, checkedAt: daysAgo(10, 3) },
        // A different hour, nine days ago; degraded still counts as up.
        { monitorId, status: "DEGRADED", responseMs: 2000, checkedAt: daysAgo(9, 5) },
        // Yesterday: stays raw.
        { monitorId, status: "UP", responseMs: 120, checkedAt: daysAgo(1) },
      ],
    });

    await rollUpOldChecks(prisma, NOW);

    const rollups = await prisma.checkRollup.findMany({ orderBy: { hour: "asc" } });
    expect(rollups).toHaveLength(2);
    expect(rollups[0]).toMatchObject({
      hour: new Date("2026-10-17T03:00:00Z"),
      checks: 3,
      failures: 1,
      responseCount: 2,
      responseAvgMs: 200,
    });
    expect(rollups[1]).toMatchObject({ checks: 1, failures: 0, responseAvgMs: 2000 });
    expect(await prisma.checkResult.count()).toBe(1);
  });

  it("does nothing the second time", async () => {
    const { id: monitorId } = await makeMonitor({ target: "https://example.com/" });
    await prisma.checkResult.create({
      data: { monitorId, status: "UP", responseMs: 50, checkedAt: daysAgo(8) },
    });

    await rollUpOldChecks(prisma, NOW);
    await rollUpOldChecks(prisma, NOW);

    expect(await prisma.checkRollup.findFirstOrThrow()).toMatchObject({ checks: 1 });
  });

  it("merges late results into an hour that was already rolled up", async () => {
    const { id: monitorId } = await makeMonitor({ target: "https://example.com/" });
    await prisma.checkResult.create({
      data: { monitorId, status: "UP", responseMs: 100, checkedAt: daysAgo(8) },
    });
    await rollUpOldChecks(prisma, NOW);
    await prisma.checkResult.create({
      data: { monitorId, status: "DOWN", responseMs: 300, checkedAt: daysAgo(8, 10) },
    });

    await rollUpOldChecks(prisma, NOW);

    expect(await prisma.checkRollup.findFirstOrThrow()).toMatchObject({
      checks: 2,
      failures: 1,
      responseCount: 2,
      responseAvgMs: 200,
    });
  });
});

describe("pruneOldPings", () => {
  it("deletes pings older than a month and keeps the rest", async () => {
    const { id: monitorId } = await makeHeartbeat();
    await prisma.heartbeatPing.createMany({
      data: [
        { monitorId, kind: "SUCCESS", receivedAt: daysAgo(31) },
        { monitorId, kind: "START", receivedAt: daysAgo(30, 1) },
      ],
    });

    expect(await pruneOldPings(prisma, NOW)).toBe(1);
    expect(await prisma.heartbeatPing.count()).toBe(1);
  });
});
