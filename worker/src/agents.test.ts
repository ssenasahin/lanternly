import type { NotificationJob } from "@lanternly/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateAgent, judge, markSilentAgents, type Sample } from "./agents.js";
import { prisma, resetDatabase } from "./test/database.js";

afterAll(() => prisma.$disconnect());

const now = new Date("2026-10-27T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const sample = (m: number, cpu: number, disk = 50): Sample => ({
  at: minutesAgo(m),
  cpu,
  memory: 40,
  disk,
});

describe("judge", () => {
  it("is up with nothing to complain about", () => {
    expect(judge([sample(1, 30), sample(0, 40)], now).status).toBe("UP");
  });

  it("is down when the disk is over 90% full", () => {
    expect(judge([sample(0, 10, 93.4)], now)).toMatchObject({
      status: "DOWN",
      error: "Disk 93% full, over the 90% limit",
    });
  });

  it("is down after five minutes of CPU over 90%", () => {
    const busy = [4, 3, 2, 1, 0].map((m) => sample(m, 95));
    expect(judge(busy, now)).toMatchObject({
      status: "DOWN",
      error: "CPU over 90% for 5 minutes (95% on average)",
    });
  });

  it("forgives a spike, or a busy stretch shorter than five minutes", () => {
    expect(
      judge(
        [4, 3, 2, 1, 0].map((m) => sample(m, m === 2 ? 50 : 99)),
        now,
      ).status,
    ).toBe("UP");
    expect(
      judge(
        [2, 1, 0].map((m) => sample(m, 99)),
        now,
      ).status,
    ).toBe("UP");
  });
});

describe("agents in the database", () => {
  const sent: NotificationJob[] = [];
  const deps = { prisma, notify: async (job: NotificationJob) => sent.push(job) };

  beforeEach(async () => {
    sent.length = 0;
    await resetDatabase();
  });

  async function makeAgent(status: "PENDING" | "UP" | "DOWN", lastSeenAt: Date | null) {
    const owner = await prisma.user.create({
      data: { email: "ada@example.com", passwordHash: "x" },
    });
    return prisma.monitor.create({
      data: {
        ownerId: owner.id,
        name: "db-1",
        type: "AGENT",
        target: "",
        status,
        agent: {
          create: { keyHash: `hash-${Math.random()}`, keyPrefix: "lnly_ag_abc", lastSeenAt },
        },
      },
    });
  }

  it("opens an incident when a report shows a full disk, and closes it when it clears", async () => {
    const monitor = await makeAgent("UP", now);
    await prisma.agentMetric.create({
      data: { agentId: monitor.id, at: now, cpu: 10, memory: 40, disk: 97 },
    });
    await evaluateAgent(monitor.id, deps, now);
    expect(sent.map((j) => j.kind)).toEqual(["down"]);

    const later = new Date(now.getTime() + 60_000);
    await prisma.agentMetric.create({
      data: { agentId: monitor.id, at: later, cpu: 10, memory: 40, disk: 60 },
    });
    await evaluateAgent(monitor.id, deps, later);
    expect(sent.map((j) => j.kind)).toEqual(["down", "up"]);
    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.cause).toBe("Disk 97% full, over the 90% limit");
  });

  it("calls a quiet agent offline once", async () => {
    const monitor = await makeAgent("UP", minutesAgo(4));
    expect(await markSilentAgents(deps, now)).toBe(1);
    expect(await markSilentAgents(deps, now)).toBe(0);
    const stored = await prisma.monitor.findUniqueOrThrow({ where: { id: monitor.id } });
    expect(stored.status).toBe("DOWN");
    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.cause).toMatch(/^No report since 2026-10-27 11:56 UTC/);
  });

  it("leaves alone an agent that reported lately or never", async () => {
    await makeAgent("UP", minutesAgo(1));
    expect(await markSilentAgents(deps, now)).toBe(0);
    await resetDatabase();
    await makeAgent("PENDING", null);
    expect(await markSilentAgents(deps, now)).toBe(0);
  });
});
