import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp, prisma, resetDatabase, schedule, signUp } from "../test/helpers.js";
import { limitsOf } from "../plans.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const site = { name: "Marketing site", type: "HTTP", target: "https://example.com" };

async function signedIn(email?: string) {
  const app = makeApp();
  const { accessToken } = await signUp(app, email);
  const as = (req: request.Test) => req.set("Authorization", `Bearer ${accessToken}`);
  return { app, as };
}

describe("creating monitors", () => {
  it("creates a monitor with sensible defaults", async () => {
    const { app, as } = await signedIn();

    const res = await as(request(app).post("/api/monitors")).send(site);

    expect(res.status).toBe(201);
    expect(res.body.monitor).toMatchObject({
      name: "Marketing site",
      target: "https://example.com/",
      intervalSec: 60,
      timeoutMs: 10_000,
      retries: 1,
      isActive: true,
      status: "PENDING",
    });
    expect(res.body.monitor).not.toHaveProperty("ownerId");
  });

  it("requires a signed-in user", async () => {
    const res = await request(makeApp()).post("/api/monitors").send(site);
    expect(res.status).toBe(401);
  });

  it.each([
    [{ intervalSec: 10 }, "intervalSec"],
    [{ intervalSec: 600 }, "intervalSec"],
    [{ timeoutMs: 100 }, "timeoutMs"],
    [{ retries: 9 }, "retries"],
    [{ name: "  " }, "name"],
    [{ type: "SMTP" }, "type"],
    // Three 15-second attempts can't fit in a 30-second interval.
    [{ intervalSec: 30, timeoutMs: 15_000, retries: 2 }, "timeoutMs"],
  ])("rejects %o", async (change, field) => {
    const { app, as } = await signedIn();
    const res = await as(request(app).post("/api/monitors")).send({ ...site, ...change });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty(field);
  });

  it.each([
    "http://localhost:6379",
    "http://intranet.example.com/",
    "http://sneaky.example.com/",
    "http://10.0.0.5/",
    "http://[fd00::1]/",
  ])("refuses %s, which points inside a private network", async (target) => {
    const { app, as } = await signedIn();

    const res = await as(request(app).post("/api/monitors")).send({ ...site, target });

    expect(res.status).toBe(400);
    expect(res.body.details.target[0]).toMatch(/private or reserved network/);
    expect(await prisma.monitor.count()).toBe(0);
  });

  it("stops at the plan's monitor limit", async () => {
    const { app, as } = await signedIn();
    const owner = await prisma.user.findFirstOrThrow();
    const { maxMonitors } = await limitsOf(prisma, owner.id);
    await prisma.monitor.createMany({
      data: Array.from({ length: maxMonitors }, (_, i) => ({
        ownerId: owner.id,
        name: `Monitor ${i}`,
        type: "HTTP" as const,
        target: "https://example.com/",
      })),
    });

    const res = await as(request(app).post("/api/monitors")).send(site);
    expect(res.status).toBe(403);
  });
});

describe("changing monitors", () => {
  it("updates settings and keeps the state when the target stays the same", async () => {
    const { app, as } = await signedIn();
    const { body } = await as(request(app).post("/api/monitors")).send(site);
    await prisma.monitor.update({ where: { id: body.monitor.id }, data: { status: "UP" } });

    const res = await as(request(app).patch(`/api/monitors/${body.monitor.id}`)).send({
      name: "Homepage",
      intervalSec: 120,
    });

    expect(res.status).toBe(200);
    expect(res.body.monitor).toMatchObject({ name: "Homepage", intervalSec: 120, status: "UP" });
  });

  it("rechecks a new target and waits for a fresh result", async () => {
    const { app, as } = await signedIn();
    const { body } = await as(request(app).post("/api/monitors")).send(site);
    await prisma.monitor.update({ where: { id: body.monitor.id }, data: { status: "UP" } });

    const refused = await as(request(app).patch(`/api/monitors/${body.monitor.id}`)).send({
      target: "http://169.254.169.254/",
    });
    expect(refused.status).toBe(400);

    const moved = await as(request(app).patch(`/api/monitors/${body.monitor.id}`)).send({
      target: "https://status.example.org/health",
    });
    expect(moved.body.monitor).toMatchObject({
      target: "https://status.example.org/health",
      status: "PENDING",
    });
  });

  it("checks the existing target again when only the type changes", async () => {
    const { app, as } = await signedIn();
    const { body } = await as(request(app).post("/api/monitors")).send(site);

    // https://example.com/ is a URL, not a host name, so it can't be pinged as it is.
    const res = await as(request(app).patch(`/api/monitors/${body.monitor.id}`)).send({
      type: "PING",
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty("target");
  });

  it("pauses and resumes", async () => {
    const { app, as } = await signedIn();
    const { body } = await as(request(app).post("/api/monitors")).send(site);
    const id = body.monitor.id as string;

    const paused = await as(request(app).post(`/api/monitors/${id}/pause`));
    expect(paused.body.monitor).toMatchObject({ isActive: false, status: "PAUSED" });

    const resumed = await as(request(app).post(`/api/monitors/${id}/resume`));
    expect(resumed.body.monitor).toMatchObject({ isActive: true, status: "PENDING" });
  });

  it("deletes a monitor", async () => {
    const { app, as } = await signedIn();
    const { body } = await as(request(app).post("/api/monitors")).send(site);

    const res = await as(request(app).delete(`/api/monitors/${body.monitor.id}`));

    expect(res.status).toBe(204);
    expect(await prisma.monitor.count()).toBe(0);
  });
});

describe("ownership", () => {
  it("lists only your own monitors", async () => {
    const ada = await signedIn("ada@example.com");
    const grace = await signedIn("grace@example.com");
    await ada.as(request(ada.app).post("/api/monitors")).send(site);
    await grace.as(request(grace.app).post("/api/monitors")).send({ ...site, name: "Grace's" });

    const res = await ada.as(request(ada.app).get("/api/monitors"));

    expect(res.body.monitors).toHaveLength(1);
    expect(res.body.monitors[0].name).toBe("Marketing site");
  });

  it("treats someone else's monitor as missing, for every action", async () => {
    const ada = await signedIn("ada@example.com");
    const grace = await signedIn("grace@example.com");
    const { body } = await grace.as(request(grace.app).post("/api/monitors")).send(site);
    const path = `/api/monitors/${body.monitor.id}`;

    const attempts = [
      ada.as(request(ada.app).get(path)),
      ada.as(request(ada.app).patch(path)).send({ name: "Mine now" }),
      ada.as(request(ada.app).post(`${path}/pause`)),
      ada.as(request(ada.app).post(`${path}/resume`)),
      ada.as(request(ada.app).delete(path)),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);

    const untouched = await prisma.monitor.findUniqueOrThrow({ where: { id: body.monitor.id } });
    expect(untouched).toMatchObject({ name: "Marketing site", isActive: true });
  });

  it("rejects an id that isn't a UUID", async () => {
    const { app, as } = await signedIn();
    const res = await as(request(app).get("/api/monitors/not-a-uuid"));
    expect(res.status).toBe(400);
  });
});

describe("the check schedule", () => {
  it("follows every change to a monitor", async () => {
    const { app, as } = await signedIn();
    const { body } = await as(request(app).post("/api/monitors")).send(site);
    const id = body.monitor.id as string;
    expect(schedule.get(id)).toBe(60);

    await as(request(app).patch(`/api/monitors/${id}`)).send({ intervalSec: 300 });
    expect(schedule.get(id)).toBe(300);

    await as(request(app).post(`/api/monitors/${id}/pause`));
    expect(schedule.get(id)).toBeNull();

    await as(request(app).post(`/api/monitors/${id}/resume`));
    expect(schedule.get(id)).toBe(300);

    await as(request(app).delete(`/api/monitors/${id}`));
    expect(schedule.get(id)).toBeNull();
  });

  it("isn't touched by a refused change", async () => {
    const { app, as } = await signedIn();
    const { body } = await as(request(app).post("/api/monitors")).send(site);

    await as(request(app).patch(`/api/monitors/${body.monitor.id}`)).send({ intervalSec: 5 });

    expect(schedule.get(body.monitor.id)).toBe(60);
  });
});

describe("a monitor's details", () => {
  it("shows the open incident and recent checks, newest first", async () => {
    const { app, as } = await signedIn();
    const { body } = await as(request(app).post("/api/monitors")).send(site);
    const monitorId = body.monitor.id as string;
    await prisma.checkResult.createMany({
      data: [
        { monitorId, status: "UP", responseMs: 120, statusCode: 200, checkedAt: new Date(1000) },
        {
          monitorId,
          status: "DOWN",
          statusCode: 503,
          error: "HTTP 503",
          checkedAt: new Date(2000),
        },
      ],
    });
    await prisma.incident.create({ data: { monitorId, cause: "HTTP 503" } });

    const detail = await as(request(app).get(`/api/monitors/${monitorId}`));
    expect(detail.body.openIncident).toMatchObject({ cause: "HTTP 503" });

    const checks = await as(request(app).get(`/api/monitors/${monitorId}/checks?limit=10`));
    expect(checks.status).toBe(200);
    expect(checks.body.checks.map((c: { status: string }) => c.status)).toEqual(["DOWN", "UP"]);
  });

  it("keeps someone else's checks private", async () => {
    const ada = await signedIn("ada@example.com");
    const grace = await signedIn("grace@example.com");
    const { body } = await grace.as(request(grace.app).post("/api/monitors")).send(site);

    const res = await ada.as(request(ada.app).get(`/api/monitors/${body.monitor.id}/checks`));
    expect(res.status).toBe(404);
  });
});
