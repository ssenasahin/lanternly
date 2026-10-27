import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp, prisma, resetDatabase, schedule, signUp } from "../test/helpers.js";

afterAll(() => prisma.$disconnect());
beforeEach(resetDatabase);

async function signedIn() {
  const app = makeApp();
  const { accessToken } = await signUp(app);
  const as = (req: request.Test) => req.set("Authorization", `Bearer ${accessToken}`);
  return { app, as };
}

async function create(body: object) {
  const { app, as } = await signedIn();
  const res = await as(request(app).post("/api/monitors")).send({ name: "Mail", ...body });
  return { app, as, res };
}

describe("TCP monitors", () => {
  it("stores host:port, lowercased", async () => {
    const { res } = await create({ type: "TCP", target: "Example.com:587" });
    expect(res.status).toBe(201);
    expect(res.body.monitor).toMatchObject({ type: "TCP", target: "example.com:587", dns: null });
    expect(schedule.get(res.body.monitor.id)).toBe(60);
  });

  it("brackets an IPv6 address", async () => {
    const { res } = await create({ type: "TCP", target: "[2606:4700:4700::1111]:53" });
    expect(res.body.monitor.target).toBe("[2606:4700:4700::1111]:53");
  });

  it.each([
    ["example.com", /host and a port/],
    ["example.com:99999", /1 to 65535/],
    ["intranet.example.com:22", /private or reserved/],
    ["127.0.0.1:6379", /private or reserved/],
    ["exa_mple.com:80", /host name/],
  ])("refuses %s", async (target, problem) => {
    const { res } = await create({ type: "TCP", target });
    expect(res.status).toBe(400);
    expect(res.body.details.target[0]).toMatch(problem);
  });
});

describe("DNS monitors", () => {
  it("stores the name and what to ask", async () => {
    const { res } = await create({
      type: "DNS",
      target: "Example.com.",
      dns: { recordType: "MX", expected: " mx1.example.com ", resolver: "1.1.1.1" },
    });
    expect(res.status).toBe(201);
    expect(res.body.monitor).toMatchObject({
      target: "example.com",
      api: null,
      dns: { recordType: "MX", expected: "mx1.example.com", resolver: "1.1.1.1" },
    });
  });

  it("asks for A records, with any answer, by default", async () => {
    const { res } = await create({ type: "DNS", target: "example.com" });
    expect(res.body.monitor.dns).toEqual({ recordType: "A", expected: null, resolver: null });
  });

  it("looks up names that don't resolve to anything themselves", async () => {
    // Nothing connects to a DNS monitor's target, so the SSRF guard has no say.
    const { res } = await create({
      type: "DNS",
      target: "_dmarc.example.net",
      dns: { recordType: "TXT" },
    });
    expect(res.status).toBe(201);
  });

  it("refuses an IP address as the name", async () => {
    const { res } = await create({ type: "DNS", target: "1.1.1.1" });
    expect(res.status).toBe(400);
    expect(res.body.details.target[0]).toMatch(/domain name/);
  });

  it.each(["10.0.0.53", "127.0.0.1", "dns.example.com"])(
    "refuses %s as the DNS server",
    async (resolver) => {
      const { res } = await create({ type: "DNS", target: "example.com", dns: { resolver } });
      expect(res.status).toBe(400);
      expect(res.body.details["dns.resolver"][0]).toMatch(/public DNS server/);
    },
  );

  it("keeps its settings through an edit, and drops them when the type changes", async () => {
    const { app, as, res } = await create({
      type: "DNS",
      target: "example.com",
      dns: { recordType: "AAAA" },
    });
    const id = res.body.monitor.id as string;

    const renamed = await as(request(app).patch(`/api/monitors/${id}`)).send({ name: "Records" });
    expect(renamed.body.monitor.dns.recordType).toBe("AAAA");

    const changed = await as(request(app).patch(`/api/monitors/${id}`)).send({
      dns: { recordType: "CNAME", expected: "example.net" },
    });
    expect(changed.body.monitor.dns).toEqual({
      recordType: "CNAME",
      expected: "example.net",
      resolver: null,
    });

    const tcp = await as(request(app).patch(`/api/monitors/${id}`)).send({
      type: "TCP",
      target: "example.com:443",
    });
    expect(tcp.status).toBe(200);
    expect(tcp.body.monitor).toMatchObject({ type: "TCP", status: "PENDING", dns: null });
    expect(await prisma.dnsQuery.count()).toBe(0);
  });

  it("gets default settings when another monitor becomes a DNS monitor", async () => {
    const { app, as, res } = await create({ type: "PING", target: "example.com" });
    const dns = await as(request(app).patch(`/api/monitors/${res.body.monitor.id}`)).send({
      type: "DNS",
    });
    expect(dns.status).toBe(200);
    expect(dns.body.monitor.dns).toEqual({ recordType: "A", expected: null, resolver: null });
  });
});
