import {
  sealConfig,
  verifyAck,
  type EscalationJob,
  type Mail,
  type Transport,
} from "@lanternly/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { escalate, sendNotification, type AlertDeps } from "./alerts.js";
import { prisma, resetDatabase } from "./test/database.js";

afterAll(() => prisma.$disconnect());

const encryptionKey = Buffer.alloc(32, 7);
const mails: Mail[] = [];
const posts: { url: string; body: string }[] = [];
const scheduled: { job: EscalationJob; delayMs: number }[] = [];
let slackStatus = 200;

const transport: Transport = async (url, body) => {
  posts.push({ url, body });
  return { status: url.includes("slack") ? slackStatus : 200, text: "ok" };
};

const deps: AlertDeps = {
  prisma,
  mailer: { send: async (mail) => void mails.push(mail) },
  webOrigin: "https://app.test",
  encryptionKey,
  scheduleEscalation: async (job, delayMs) => scheduled.push({ job, delayMs }),
  transport,
  wait: async () => {},
};

beforeEach(async () => {
  mails.length = 0;
  posts.length = 0;
  scheduled.length = 0;
  slackStatus = 200;
  await resetDatabase();
});

async function setup() {
  const owner = await prisma.user.create({ data: { email: "ada@example.com", passwordHash: "x" } });
  const grace = await prisma.user.create({
    data: { email: "grace@example.com", passwordHash: "x" },
  });
  const team = await prisma.team.create({
    data: {
      ownerId: owner.id,
      name: "Ada's team",
      members: {
        create: [
          { userId: owner.id, role: "OWNER" },
          { userId: grace.id, role: "MEMBER" },
        ],
      },
    },
  });
  const slack = await prisma.notificationChannel.create({
    data: {
      ownerId: owner.id,
      type: "SLACK",
      name: "#ops",
      config: sealConfig({ webhookUrl: "https://hooks.slack.com/services/x" }, encryptionKey),
    },
  });
  const monitor = await prisma.monitor.create({
    data: { ownerId: owner.id, name: "Shop", type: "HTTP", target: "https://shop.example.com" },
  });
  const incident = await prisma.incident.create({
    data: { monitorId: monitor.id, cause: "HTTP 503", events: { create: { type: "OPENED" } } },
  });
  return { owner, grace, team, slack, monitor, incident };
}

const timeline = (incidentId: string) =>
  prisma.incidentEvent
    .findMany({ where: { incidentId }, orderBy: { id: "asc" } })
    .then((events) => events.map((e) => `${e.type} ${e.detail ?? ""}`.trim()));

describe("without an escalation policy", () => {
  it("alerts the owner and every enabled channel, and logs each", async () => {
    const { incident, owner } = await setup();
    await prisma.notificationChannel.create({
      data: {
        ownerId: owner.id,
        type: "WEBHOOK",
        name: "Off",
        enabled: false,
        config: sealConfig({ url: "https://example.com/h", secret: "s" }, encryptionKey),
      },
    });
    await sendNotification({ kind: "down", incidentId: incident.id }, deps);

    expect(mails.map((m) => [m.to, m.subject])).toEqual([["ada@example.com", "Down: Shop"]]);
    expect(posts.map((p) => p.url)).toEqual(["https://hooks.slack.com/services/x"]);
    expect(await timeline(incident.id)).toEqual([
      "OPENED",
      "NOTIFIED Emailed ada@example.com",
      'NOTIFIED Sent to Slack "#ops"',
    ]);
    expect(scheduled).toEqual([]);
  });

  it("logs a channel that failed, keeps going, and remembers the error", async () => {
    const { incident, slack } = await setup();
    slackStatus = 500;
    await sendNotification({ kind: "down", incidentId: incident.id }, deps);
    expect(mails).toHaveLength(1);
    expect((await timeline(incident.id)).at(-1)).toBe(
      `NOT_DELIVERED Couldn't reach Slack "#ops": Slack answered HTTP 500: ok`,
    );
    const stored = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: slack.id } });
    expect(stored.lastError).toBe("Slack answered HTTP 500: ok");
  });

  it("puts a signed acknowledge link in the alert", async () => {
    const { incident, owner } = await setup();
    await sendNotification({ kind: "down", incidentId: incident.id }, deps);
    const link = /Acknowledge it: (\S+)/.exec(mails[0]!.text)![1]!;
    const url = new URL(link);
    expect(url.pathname).toBe(`/ack/${incident.id}`);
    expect(url.searchParams.get("by")).toBe(`u:${owner.id}`);
    expect(
      verifyAck(encryptionKey, incident.id, `u:${owner.id}`, url.searchParams.get("sig")!),
    ).toBe(true);
  });

  it("sends nothing for a suspended account", async () => {
    const { incident, owner } = await setup();
    await prisma.user.update({ where: { id: owner.id }, data: { suspendedAt: new Date() } });
    await sendNotification({ kind: "down", incidentId: incident.id }, deps);
    expect(mails).toEqual([]);
    expect(posts).toEqual([]);
    expect(await timeline(incident.id)).toEqual(["OPENED"]);
  });
});

describe("with an escalation policy", () => {
  async function withPolicy() {
    const s = await setup();
    const policy = await prisma.escalationPolicy.create({
      data: {
        teamId: s.team.id,
        name: "Shop on-call",
        steps: [
          { waitMinutes: 0, targets: [{ kind: "member", userId: s.owner.id }] },
          {
            waitMinutes: 10,
            targets: [
              { kind: "member", userId: s.grace.id },
              { kind: "channel", channelId: s.slack.id },
            ],
          },
        ],
      },
    });
    await prisma.monitor.update({
      where: { id: s.monitor.id },
      data: { escalationPolicyId: policy.id },
    });
    return s;
  }

  it("alerts the first step only, and schedules the next", async () => {
    const { incident } = await withPolicy();
    await sendNotification({ kind: "down", incidentId: incident.id }, deps);
    expect(mails.map((m) => m.to)).toEqual(["ada@example.com"]);
    expect(mails[0]!.text).toContain("within 10 min");
    expect(posts).toEqual([]);
    expect(scheduled).toEqual([{ job: { incidentId: incident.id, step: 1 }, delayMs: 600_000 }]);
  });

  it("escalates when nobody acknowledged", async () => {
    const { incident } = await withPolicy();
    await escalate({ incidentId: incident.id, step: 1 }, deps);
    expect(mails.map((m) => [m.to, m.subject])).toEqual([
      ["grace@example.com", "Still down: Shop"],
    ]);
    expect(posts).toHaveLength(1);
    expect(await timeline(incident.id)).toEqual([
      "OPENED",
      'ESCALATED Nobody acknowledged it within 10 min; alerting step 2 of "Shop on-call"',
      "NOTIFIED Emailed grace@example.com",
      'NOTIFIED Sent to Slack "#ops"',
    ]);
    // Run twice (a retried job), it doesn't alert twice.
    await escalate({ incidentId: incident.id, step: 1 }, deps);
    expect(mails).toHaveLength(1);
  });

  it("doesn't escalate an acknowledged or resolved incident", async () => {
    const { incident } = await withPolicy();
    await prisma.incident.update({
      where: { id: incident.id },
      data: { acknowledgedAt: new Date() },
    });
    await escalate({ incidentId: incident.id, step: 1 }, deps);
    expect(mails).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("skips a member who left the team", async () => {
    const { incident, team, grace } = await withPolicy();
    await prisma.teamMember.delete({
      where: { teamId_userId: { teamId: team.id, userId: grace.id } },
    });
    await escalate({ incidentId: incident.id, step: 1 }, deps);
    expect(mails).toEqual([]);
    expect(posts).toHaveLength(1);
  });

  it("tells everyone who was alerted that it's back up", async () => {
    const { incident } = await withPolicy();
    await escalate({ incidentId: incident.id, step: 1 }, deps);
    mails.length = 0;
    posts.length = 0;
    await prisma.incident.update({ where: { id: incident.id }, data: { resolvedAt: new Date() } });
    await sendNotification({ kind: "up", incidentId: incident.id }, deps);
    expect(mails.map((m) => m.to).sort()).toEqual(["ada@example.com", "grace@example.com"]);
    expect(mails[0]!.subject).toMatch(/^Back up: Shop/);
    expect(posts).toHaveLength(1);
  });
});
