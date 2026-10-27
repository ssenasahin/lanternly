import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp, pingJobs, prisma, resetDatabase, schedule, signUp } from "../test/helpers.js";
import { PING_BODY_LIMIT } from "./ping.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const backup = { name: "Nightly backup", cron: "0 3 * * *", timezone: "Europe/Istanbul" };

async function signedIn(email?: string) {
  const app = makeApp();
  const { accessToken } = await signUp(app, email);
  const as = (req: request.Test) => req.set("Authorization", `Bearer ${accessToken}`);
  return { app, as };
}

async function created(input: object = backup) {
  const session = await signedIn();
  const res = await session.as(request(session.app).post("/api/heartbeats")).send(input);
  expect(res.status).toBe(201);
  const pingUrl: string = res.body.heartbeat.pingUrl;
  return { ...session, id: res.body.monitor.id as string, path: new URL(pingUrl).pathname };
}

describe("creating heartbeats", () => {
  it("creates a pending heartbeat with an unguessable ping URL", async () => {
    const { app, as } = await signedIn();
    const res = await as(request(app).post("/api/heartbeats")).send(backup);

    expect(res.status).toBe(201);
    expect(res.body.monitor).toMatchObject({
      name: "Nightly backup",
      type: "HEARTBEAT",
      status: "PENDING",
    });
    expect(res.body.heartbeat).toMatchObject({
      periodSec: null,
      cron: "0 3 * * *",
      timezone: "Europe/Istanbul",
      graceSec: 300,
      lastPingAt: null,
      // Nothing is due before the first ping.
      expectedAt: null,
    });
    expect(res.body.heartbeat.pingUrl).toMatch(/^http:\/\/localhost:0\/ping\/[\w-]{22}$/);
    expect(res.body.heartbeat).not.toHaveProperty("token");
    // Heartbeats are never put on the check schedule.
    expect(schedule.size).toBe(0);
  });

  it("gives every heartbeat its own token", async () => {
    const { app, as } = await signedIn();
    const urls = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await as(request(app).post("/api/heartbeats")).send({
        name: "Job",
        periodSec: 3600,
      });
      urls.add(res.body.heartbeat.pingUrl);
    }
    expect(urls.size).toBe(5);
  });

  it("stores a cron expression with single spaces", async () => {
    const { app, as } = await signedIn();
    const res = await as(request(app).post("/api/heartbeats")).send({
      ...backup,
      cron: " 0   3 * * * ",
    });
    expect(res.body.heartbeat.cron).toBe("0 3 * * *");
  });

  it.each([
    [{ periodSec: 3600 }, "periodSec"],
    [{ cron: null }, "periodSec"],
    [{ cron: "0 3 * *" }, "cron"],
    [{ cron: "99 3 * * *" }, "cron"],
    [{ timezone: "Mars/Olympus" }, "timezone"],
    [{ graceSec: 10 }, "graceSec"],
    [{ name: "" }, "name"],
  ])("rejects %o", async (change, field) => {
    const { app, as } = await signedIn();
    const res = await as(request(app).post("/api/heartbeats")).send({ ...backup, ...change });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty(field);
  });

  it("previews a cron expression's next runs", async () => {
    const { app, as } = await signedIn();
    const res = await as(request(app).post("/api/heartbeats/schedule-preview")).send(backup);
    expect(res.status).toBe(200);
    expect(res.body.next).toHaveLength(3);
    // 03:00 in Istanbul is midnight UTC.
    expect(res.body.next[0]).toMatch(/T00:00:00\.000Z$/);

    const bad = await as(request(app).post("/api/heartbeats/schedule-preview")).send({
      ...backup,
      cron: "every night",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.details).toHaveProperty("cron");
  });
});

describe("managing heartbeats", () => {
  it("switches between a period and a cron expression", async () => {
    const { app, as, id } = await created();

    const hourly = await as(request(app).patch(`/api/heartbeats/${id}`)).send({ periodSec: 3600 });
    expect(hourly.body.heartbeat).toMatchObject({ periodSec: 3600, cron: null });
    expect(hourly.body.monitor.name).toBe("Nightly backup");

    const nightly = await as(request(app).patch(`/api/heartbeats/${id}`)).send({
      cron: "30 2 * * *",
      name: "Backup",
    });
    expect(nightly.body.heartbeat).toMatchObject({ periodSec: null, cron: "30 2 * * *" });
    expect(nightly.body.monitor.name).toBe("Backup");
  });

  it("hides other people's heartbeats", async () => {
    const { id } = await created();
    const { app, as } = await signedIn("grace@example.com");

    expect((await as(request(app).get(`/api/heartbeats/${id}`))).status).toBe(404);
    expect((await as(request(app).patch(`/api/heartbeats/${id}`)).send({ name: "x" })).status).toBe(
      404,
    );
    expect((await as(request(app).get(`/api/heartbeats/${id}/pings`))).status).toBe(404);
    expect((await as(request(app).delete(`/api/heartbeats/${id}`))).status).toBe(404);
  });

  it("lists heartbeats among monitors with their schedule, but never the token", async () => {
    const { app, as, path } = await created();
    const res = await as(request(app).get("/api/monitors"));

    expect(res.body.monitors[0]).toMatchObject({
      type: "HEARTBEAT",
      heartbeat: { cron: "0 3 * * *", graceSec: 300, lastPingAt: null },
    });
    expect(JSON.stringify(res.body)).not.toContain(path.split("/").pop());
  });

  it("is edited through /api/heartbeats, not /api/monitors", async () => {
    const { app, as, id } = await created();
    const res = await as(request(app).patch(`/api/monitors/${id}`)).send({ name: "Renamed" });
    expect(res.status).toBe(400);
  });

  it("pauses and resumes without ever being scheduled for checks", async () => {
    const { app, as, id } = await created();
    await as(request(app).post(`/api/monitors/${id}/pause`));
    const resumed = await as(request(app).post(`/api/monitors/${id}/resume`));

    expect(resumed.body.monitor.status).toBe("PENDING");
    expect(schedule.get(id)).toBeNull();
  });
});

describe("pings", () => {
  it("counts a GET as a success and hands it to the worker", async () => {
    const { app, as, id, path } = await created();

    const res = await request(app).get(path).set("User-Agent", "curl/8.9");
    expect(res.status).toBe(200);
    expect(res.text).toBe("OK\n");

    const ping = await prisma.heartbeatPing.findFirstOrThrow();
    expect(ping).toMatchObject({
      kind: "SUCCESS",
      userAgent: "curl/8.9",
      body: null,
      durationMs: null,
    });
    expect(ping.ip).toBeTruthy();
    expect(pingJobs).toEqual([{ pingId: ping.id.toString() }]);

    const { body } = await as(request(app).get(`/api/heartbeats/${id}`));
    expect(body.heartbeat.lastPingAt).not.toBeNull();
    // Nightly at 03:00 Istanbul, so the next one is due at midnight UTC, with grace after.
    expect(body.heartbeat.expectedAt).toMatch(/T00:00:00\.000Z$/);
    expect(body.heartbeat.lateAt).toMatch(/T00:05:00\.000Z$/);
  });

  it("times a run from its start ping", async () => {
    const { app, path } = await created();

    await request(app).post(`${path}/start`).expect(200);
    // Only the finish goes to the worker; a start changes no state.
    expect(pingJobs).toHaveLength(0);
    const started = await prisma.heartbeat.findFirstOrThrow();
    expect(started.lastStartAt).not.toBeNull();
    expect(started.lastPingAt).toBeNull();

    await new Promise((done) => setTimeout(done, 20));
    await request(app).post(path).expect(200);
    const finish = await prisma.heartbeatPing.findFirstOrThrow({ where: { kind: "SUCCESS" } });
    expect(finish.durationMs).toBeGreaterThanOrEqual(20);
    expect((await prisma.heartbeat.findFirstOrThrow()).lastStartAt).toBeNull();
  });

  it("keeps the first 10 KB of a failure's output, however much is sent", async () => {
    const { app, path } = await created();
    const log = "x".repeat(50_000);

    const res = await request(app).post(`${path}/fail`).set("Content-Type", "text/plain").send(log);
    expect(res.status).toBe(200);
    const ping = await prisma.heartbeatPing.findFirstOrThrow();
    expect(ping.kind).toBe("FAIL");
    expect(ping.body).toHaveLength(PING_BODY_LIMIT);
  });

  it("stores a JSON body as the text it was", async () => {
    const { app, path } = await created();
    await request(app).post(path).send({ rows: 1200 }).expect(200);
    expect((await prisma.heartbeatPing.findFirstOrThrow()).body).toBe('{"rows":1200}');
  });

  it("accepts pings from anywhere, without signing in", async () => {
    const { app, path } = await created();
    await request(app).post(path).set("Origin", "https://elsewhere.example").expect(200);
  });

  it("answers 404 for a URL that belongs to no heartbeat", async () => {
    const res = await request(makeApp()).get("/ping/not-a-real-token");
    expect(res.status).toBe(404);
    expect(await prisma.heartbeatPing.count()).toBe(0);
  });

  it("limits how often one heartbeat can be pinged", async () => {
    const { app, path } = await created();
    for (let i = 0; i < 30; i++) await request(app).get(path).expect(200);
    const res = await request(app).get(path);
    expect(res.status).toBe(429);
    expect(await prisma.heartbeatPing.count()).toBe(30);
  });
});
