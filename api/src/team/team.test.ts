import { signAck } from "@lanternly/db";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  cancelledEscalations,
  makeApp,
  outbox,
  prisma,
  resetDatabase,
  signUp,
  testEnv,
} from "../test/helpers.js";

afterAll(() => prisma.$disconnect());
beforeEach(resetDatabase);

const key = Buffer.from(testEnv.ENCRYPTION_KEY, "base64");

async function signedIn(email: string) {
  const app = makeApp();
  const { accessToken } = await signUp(app, email);
  const as = (req: request.Test) => req.set("Authorization", `Bearer ${accessToken}`);
  const { id: userId } = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { app, as, userId };
}

// Ada invites Grace, and Grace accepts.
async function twoPersonTeam() {
  const ada = await signedIn("ada@example.com");
  const grace = await signedIn("grace@example.com");
  await ada.as(request(ada.app).post("/api/team/invites")).send({ email: "Grace@Example.com" });
  const token = /\/invites\/([\w-]+)/.exec(outbox.at(-1)!.text)![1]!;
  const accepted = await grace.as(request(grace.app).post(`/api/team/invites/${token}/accept`));
  expect(accepted.status).toBe(200);
  return { ada, grace };
}

describe("team", () => {
  it("is made on first visit, with its owner in it", async () => {
    const ada = await signedIn("ada@example.com");
    const res = await ada.as(request(ada.app).get("/api/team"));
    expect(res.body.team.name).toBe("ada's team");
    expect(res.body.members).toEqual([
      expect.objectContaining({ email: "ada@example.com", role: "OWNER" }),
    ]);
  });

  it("invites by email and stores only the token's hash", async () => {
    const ada = await signedIn("ada@example.com");
    const res = await ada
      .as(request(ada.app).post("/api/team/invites"))
      .send({ email: "grace@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.invites).toEqual([expect.objectContaining({ email: "grace@example.com" })]);
    const mail = outbox.at(-1)!;
    expect(mail).toMatchObject({
      to: "grace@example.com",
      subject: "ada@example.com invited you to their Lanternly team",
    });
    const token = /\/invites\/([\w-]+)/.exec(mail.text)![1]!;
    const stored = await prisma.teamInvite.findFirstOrThrow();
    expect(stored.tokenHash).not.toContain(token);
  });

  it("lets only the invited address accept", async () => {
    const ada = await signedIn("ada@example.com");
    await ada.as(request(ada.app).post("/api/team/invites")).send({ email: "grace@example.com" });
    const token = /\/invites\/([\w-]+)/.exec(outbox.at(-1)!.text)![1]!;

    const mallory = await signedIn("mallory@example.com");
    const preview = await mallory.as(request(mallory.app).get(`/api/team/invites/${token}`));
    expect(preview.body).toEqual({
      email: "grace@example.com",
      team: "ada's team",
      invitedBy: "ada@example.com",
    });
    const stolen = await mallory.as(request(mallory.app).post(`/api/team/invites/${token}/accept`));
    expect(stolen.status).toBe(403);
    expect(stolen.body.error).toMatch(/for grace@example.com/);
  });

  it("adds the member, and the link works only once", async () => {
    const { ada, grace } = await twoPersonTeam();
    const team = await ada.as(request(ada.app).get("/api/team"));
    expect(team.body.members.map((m: { email: string }) => m.email)).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
    expect(team.body.invites).toEqual([]);
    const mine = await grace.as(request(grace.app).get("/api/team"));
    expect(mine.body.memberOf).toEqual([
      expect.objectContaining({ name: "ada's team", ownerEmail: "ada@example.com" }),
    ]);

    const token = /\/invites\/([\w-]+)/.exec(outbox.at(-1)!.text)![1]!;
    const again = await grace.as(request(grace.app).post(`/api/team/invites/${token}/accept`));
    expect(again.status).toBe(404);
  });

  it("removes a member from the team and from its policies", async () => {
    const { ada, grace } = await twoPersonTeam();
    const policy = await ada.as(request(ada.app).post("/api/escalation-policies")).send({
      name: "On call",
      steps: [
        { waitMinutes: 0, targets: [{ kind: "member", userId: ada.userId }] },
        {
          waitMinutes: 15,
          targets: [
            { kind: "member", userId: grace.userId },
            { kind: "member", userId: ada.userId },
          ],
        },
      ],
    });
    expect(policy.status).toBe(201);

    const removed = await ada.as(request(ada.app).delete(`/api/team/members/${grace.userId}`));
    expect(removed.status).toBe(204);
    const policies = await ada.as(request(ada.app).get("/api/escalation-policies"));
    expect(policies.body.policies[0].steps[1].targets).toEqual([
      { kind: "member", userId: ada.userId },
    ]);
  });
});

describe("escalation policies", () => {
  it("accepts only people on the team and the owner's channels", async () => {
    const ada = await signedIn("ada@example.com");
    const stranger = await signedIn("stranger@example.com");
    const res = await ada.as(request(ada.app).post("/api/escalation-policies")).send({
      name: "On call",
      steps: [{ waitMinutes: 0, targets: [{ kind: "member", userId: stranger.userId }] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.details["steps.0.targets.0"]).toEqual([
      "Not on your team or among your channels",
    ]);
  });

  it("makes later steps wait at least a minute", async () => {
    const ada = await signedIn("ada@example.com");
    const target = [{ kind: "member", userId: ada.userId }];
    const res = await ada.as(request(ada.app).post("/api/escalation-policies")).send({
      name: "On call",
      steps: [
        { waitMinutes: 5, targets: target },
        { waitMinutes: 0, targets: target },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.details["steps.1.waitMinutes"]).toBeDefined();
  });

  it("is assigned to monitors of its own team only", async () => {
    const ada = await signedIn("ada@example.com");
    const policy = await ada.as(request(ada.app).post("/api/escalation-policies")).send({
      name: "On call",
      steps: [{ waitMinutes: 3, targets: [{ kind: "member", userId: ada.userId }] }],
    });
    // The first step always fires at once.
    expect(policy.body.policy.steps[0].waitMinutes).toBe(0);
    const policyId = policy.body.policy.id as string;

    const created = await ada.as(request(ada.app).post("/api/monitors")).send({
      name: "Shop",
      type: "HTTP",
      target: "https://example.com",
      escalationPolicyId: policyId,
    });
    expect(created.body.monitor.escalationPolicy).toEqual({ id: policyId, name: "On call" });

    const other = await signedIn("other@example.com");
    const sneaky = await other.as(request(other.app).post("/api/monitors")).send({
      name: "Mine",
      type: "HTTP",
      target: "https://example.com",
      escalationPolicyId: policyId,
    });
    expect(sneaky.status).toBe(400);

    const cleared = await ada
      .as(request(ada.app).patch(`/api/monitors/${created.body.monitor.id}`))
      .send({
        escalationPolicyId: null,
      });
    expect(cleared.body.monitor.escalationPolicy).toBeNull();
  });
});

describe("acknowledging incidents", () => {
  async function openIncident() {
    const ada = await signedIn("ada@example.com");
    const monitor = await prisma.monitor.create({
      data: { ownerId: ada.userId, name: "Shop", type: "HTTP", target: "https://example.com" },
    });
    const incident = await prisma.incident.create({
      data: { monitorId: monitor.id, cause: "HTTP 503", events: { create: { type: "OPENED" } } },
    });
    return { ...ada, incident };
  }

  it("from the dashboard, once, calling off escalation", async () => {
    const { app, as, incident } = await openIncident();
    const res = await as(request(app).post(`/api/incidents/${incident.id}/ack`));
    expect(res.body.incident).toMatchObject({ acknowledgedBy: "ada@example.com" });
    expect(cancelledEscalations).toEqual([incident.id]);
    await as(request(app).post(`/api/incidents/${incident.id}/ack`));

    const detail = await as(request(app).get(`/api/incidents/${incident.id}`));
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual([
      "OPENED",
      "ACKNOWLEDGED",
    ]);
  });

  it("from a signed link, without signing in", async () => {
    const { userId, incident } = await openIncident();
    const by = `u:${userId}`;
    const sig = signAck(key, incident.id, by);
    const app = makeApp();

    const preview = await request(app).get(`/api/ack/${incident.id}`).query({ by, sig });
    expect(preview.body).toMatchObject({
      as: "ada@example.com",
      incident: { monitor: { name: "Shop" }, acknowledgedAt: null },
    });

    const res = await request(app).post(`/api/ack/${incident.id}`).send({ by, sig });
    expect(res.body).toMatchObject({
      acknowledged: true,
      incident: { acknowledgedBy: "ada@example.com" },
    });
    const again = await request(app).post(`/api/ack/${incident.id}`).send({ by, sig });
    expect(again.body.acknowledged).toBe(false);
  });

  it("refuses a link whose signature doesn't match", async () => {
    const { userId, incident } = await openIncident();
    const app = makeApp();
    // Signed for someone else: the link can't be re-pointed.
    const sig = signAck(key, incident.id, `u:${userId}`);
    const res = await request(app)
      .post(`/api/ack/${incident.id}`)
      .send({ by: "u:00000000-0000-4000-8000-000000000000", sig });
    expect(res.status).toBe(404);
    expect(await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).toMatchObject({
      acknowledgedAt: null,
    });
  });

  it("keeps incidents to their owner", async () => {
    const { incident } = await openIncident();
    const other = await signedIn("other@example.com");
    expect((await other.as(request(other.app).get(`/api/incidents/${incident.id}`))).status).toBe(
      404,
    );
    expect(
      (await other.as(request(other.app).post(`/api/incidents/${incident.id}/ack`))).status,
    ).toBe(404);
  });
});
