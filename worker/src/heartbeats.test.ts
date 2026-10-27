import type { NotificationJob } from "@lanternly/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { markLateHeartbeats, processPing } from "./heartbeats.js";
import { recordCheck } from "./record.js";
import { makeHeartbeat, prisma, resetDatabase } from "./test/database.js";

afterAll(() => prisma.$disconnect());

const sent: NotificationJob[] = [];
beforeEach(async () => {
  sent.length = 0;
  await resetDatabase();
});

const deps = { prisma, notify: async (job: NotificationJob) => sent.push(job) };

async function ping(
  monitorId: string,
  kind: "SUCCESS" | "START" | "FAIL",
  data: { durationMs?: number; body?: string; receivedAt?: Date } = {},
) {
  const row = await prisma.heartbeatPing.create({ data: { monitorId, kind, ...data } });
  await processPing(row.id.toString(), deps);
  return row;
}

const statusOf = async (id: string) =>
  (await prisma.monitor.findUniqueOrThrow({ where: { id } })).status;

describe("processPing", () => {
  it("records a success as an up check, timed when it was", async () => {
    const monitor = await makeHeartbeat({ status: "PENDING" });
    await ping(monitor.id, "SUCCESS", { durationMs: 4200 });

    expect(await statusOf(monitor.id)).toBe("UP");
    expect(await prisma.checkResult.findFirst()).toMatchObject({ status: "UP", responseMs: 4200 });
    expect(sent).toEqual([]);
  });

  it("opens an incident for a failure, with the first line of the job's output", async () => {
    const monitor = await makeHeartbeat();
    await ping(monitor.id, "FAIL", { body: "pg_dump: connection refused\nexit status 1\n" });

    expect(await statusOf(monitor.id)).toBe("DOWN");
    expect(await prisma.incident.findFirst()).toMatchObject({
      cause: "The job reported a failure: pg_dump: connection refused",
    });
    expect(sent.map((j) => j.kind)).toEqual(["down"]);
  });

  it("only starts the clock on a start ping", async () => {
    const monitor = await makeHeartbeat({ status: "PENDING" });
    await ping(monitor.id, "START");

    expect(await prisma.checkResult.count()).toBe(0);
    expect(await statusOf(monitor.id)).toBe("PENDING");
  });

  it("warns once when a run takes more than twice as long as usual", async () => {
    const monitor = await makeHeartbeat();
    for (let i = 0; i < 5; i++) await ping(monitor.id, "SUCCESS", { durationMs: 60_000 });
    // Exactly twice the usual is still fine.
    await ping(monitor.id, "SUCCESS", { durationMs: 120_000 });
    expect(await statusOf(monitor.id)).toBe("UP");

    await ping(monitor.id, "SUCCESS", { durationMs: 300_000 });
    expect(await statusOf(monitor.id)).toBe("DEGRADED");
    const slow = await prisma.checkResult.findFirst({ where: { status: "DEGRADED" } });
    expect(slow?.error).toBe("Ran for 5 min, more than twice the usual 1 min");
    expect(sent).toEqual([{ kind: "degraded", checkId: slow!.id.toString() }]);

    // Still slow: no second warning. Back to normal: quietly up again.
    await ping(monitor.id, "SUCCESS", { durationMs: 400_000 });
    await ping(monitor.id, "SUCCESS", { durationMs: 70_000 });
    expect(sent).toHaveLength(1);
    expect(await statusOf(monitor.id)).toBe("UP");
    // Slow runs are no incident.
    expect(await prisma.incident.count()).toBe(0);
  });

  it("doesn't call a run slow before there are enough runs to compare with", async () => {
    const monitor = await makeHeartbeat();
    for (let i = 0; i < 4; i++) await ping(monitor.id, "SUCCESS", { durationMs: 1000 });
    await ping(monitor.id, "SUCCESS", { durationMs: 60_000 });

    expect(await statusOf(monitor.id)).toBe("UP");
  });

  it("logs pings to a paused heartbeat without changing it", async () => {
    const monitor = await makeHeartbeat({ status: "PENDING", isActive: false });
    await prisma.monitor.update({ where: { id: monitor.id }, data: { status: "PAUSED" } });
    await ping(monitor.id, "FAIL");

    expect(await statusOf(monitor.id)).toBe("PAUSED");
    expect(await prisma.checkResult.count()).toBe(0);
  });
});

describe("markLateHeartbeats", () => {
  const lastPingAt = new Date("2026-10-27T10:00:00Z");
  // Hourly with five minutes' grace: late after 11:05.
  const before = new Date("2026-10-27T11:04:59Z");
  const after = new Date("2026-10-27T11:05:01Z");

  it("takes a heartbeat down once its ping is overdue by more than the grace", async () => {
    const monitor = await makeHeartbeat({ lastPingAt });

    expect(await markLateHeartbeats(deps, before)).toBe(0);
    expect(await statusOf(monitor.id)).toBe("UP");

    expect(await markLateHeartbeats(deps, after)).toBe(1);
    expect(await statusOf(monitor.id)).toBe("DOWN");
    expect(await prisma.incident.findFirst()).toMatchObject({
      cause: "No ping since 2026-10-27 10:00 UTC; one was due by 2026-10-27 11:00 UTC",
    });
    expect(sent.map((j) => j.kind)).toEqual(["down"]);

    // A minute later it's still late, but the owner already knows.
    expect(await markLateHeartbeats(deps, new Date("2026-10-27T11:06:01Z"))).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("closes the incident when the job pings again", async () => {
    const monitor = await makeHeartbeat({ lastPingAt });
    await markLateHeartbeats(deps, after);
    await ping(monitor.id, "SUCCESS");

    expect(await statusOf(monitor.id)).toBe("UP");
    expect(sent.map((j) => j.kind)).toEqual(["down", "up"]);
  });

  it("waits for the first ping of a new or resumed heartbeat", async () => {
    await makeHeartbeat({ status: "PENDING" });
    await prisma.user.deleteMany();
    await makeHeartbeat({ status: "PENDING", lastPingAt });

    expect(await markLateHeartbeats(deps, after)).toBe(0);
    expect(await prisma.checkResult.count()).toBe(0);
  });

  it("drops the result if a ping arrives while it's being decided", async () => {
    const monitor = await makeHeartbeat({ lastPingAt });
    const missed = { status: "DOWN", responseMs: null, statusCode: null, error: "late" } as const;
    const alert = await recordCheck(prisma, monitor.id, "UP", missed, {
      stillValid: async () => false,
    });

    expect(alert).toBeNull();
    expect(await prisma.checkResult.count()).toBe(0);
    expect(await statusOf(monitor.id)).toBe("UP");
  });
});
