import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { agentJobs, makeApp, prisma, resetDatabase, schedule, signUp } from "../test/helpers.js";

afterAll(() => prisma.$disconnect());
beforeEach(resetDatabase);

async function withAgent(email = "ada@example.com") {
  const app = makeApp();
  const { accessToken } = await signUp(app, email);
  const as = (req: request.Test) => req.set("Authorization", `Bearer ${accessToken}`);
  const res = await as(request(app).post("/api/agents")).send({ name: "db-1" });
  expect(res.status).toBe(201);
  return { app, as, id: res.body.id as string, key: res.body.key as string, body: res.body };
}

const report = (at = new Date(), disk = 40) => ({
  host: { hostname: "db-1.internal", platform: "linux" },
  samples: [{ at: at.toISOString(), cpu: 12.5, memory: 61, disk }],
});

describe("server agents", () => {
  it("are monitors, created with a key shown once", async () => {
    const { as, app, id, key, body } = await withAgent();
    expect(key).toMatch(/^lnly_ag_[\w-]{32}$/);
    expect(body.install.shell).toContain(`LANTERNLY_AGENT_KEY=${key}`);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { monitorId: id } });
    expect(stored.keyHash).not.toContain(key);
    // Agents call in; nothing is scheduled for them.
    expect(schedule.get(id)).toBeNull();

    const monitor = await as(request(app).get(`/api/monitors/${id}`));
    expect(monitor.body.monitor).toMatchObject({
      type: "AGENT",
      status: "PENDING",
      agent: { keyPrefix: key.slice(0, 12), lastSeenAt: null },
    });
    expect(JSON.stringify(monitor.body)).not.toContain(key);
  });

  it("accept reports with their key and hand them to the worker", async () => {
    const { app, as, id, key } = await withAgent();
    const res = await request(app)
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${key}`)
      .send(report());
    expect(res.status).toBe(202);
    expect(agentJobs).toEqual([id]);

    const agent = await as(request(app).get(`/api/agents/${id}`));
    expect(agent.body.agent).toMatchObject({
      hostname: "db-1.internal",
      platform: "linux",
      latest: { cpu: 12.5, memory: 61, disk: 40 },
    });
    const metrics = await as(request(app).get(`/api/agents/${id}/metrics?range=1h`));
    expect(metrics.body.points).toHaveLength(1);
    expect(metrics.body.points[0]).toMatchObject({ cpu: 12.5, memory: 61, disk: 40 });
  });

  it("refuse an unknown key, or a user's token", async () => {
    const { app } = await withAgent();
    const wrong = await request(app)
      .post("/api/agent/metrics")
      .set("Authorization", "Bearer lnly_ag_nope")
      .send(report());
    expect(wrong.status).toBe(401);
    expect(await prisma.agentMetric.count()).toBe(0);
  });

  it("drop samples from a clock that's far off", async () => {
    const { app, key } = await withAgent();
    const old = new Date(Date.now() - 5 * 60 * 60_000);
    const res = await request(app)
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${key}`)
      .send(report(old));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/clock/);
  });

  it("refuse percentages that aren't percentages", async () => {
    const { app, key } = await withAgent();
    const res = await request(app)
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${key}`)
      .send(report(new Date(), 140));
    expect(res.status).toBe(400);
  });

  it("get a new key that replaces the old one at once", async () => {
    const { app, as, id, key } = await withAgent();
    const rotated = await as(request(app).post(`/api/agents/${id}/key`));
    expect(rotated.body.key).not.toBe(key);
    const old = await request(app)
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${key}`)
      .send(report());
    expect(old.status).toBe(401);
    const fresh = await request(app)
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${rotated.body.key}`)
      .send(report());
    expect(fresh.status).toBe(202);
  });

  it("can be renamed, but have nothing else to edit", async () => {
    const { app, as, id } = await withAgent();
    const renamed = await as(request(app).patch(`/api/monitors/${id}`)).send({
      name: "db-primary",
    });
    expect(renamed.body.monitor.name).toBe("db-primary");
    const retarget = await as(request(app).patch(`/api/monitors/${id}`)).send({
      target: "https://example.com",
    });
    expect(retarget.status).toBe(400);
  });

  it("are their owner's alone", async () => {
    const { id } = await withAgent();
    const other = makeApp();
    const { accessToken } = await signUp(other, "other@example.com");
    for (const path of [`/api/agents/${id}`, `/api/agents/${id}/metrics`]) {
      const res = await request(other).get(path).set("Authorization", `Bearer ${accessToken}`);
      expect(res.status).toBe(404);
    }
    const rotate = await request(other)
      .post(`/api/agents/${id}/key`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(rotate.status).toBe(404);
  });
});
