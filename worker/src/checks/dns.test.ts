import { describe, expect, it } from "vitest";
import { checkDns, matches, type DnsSettings, type QueryDns } from "./dns.js";

const A: DnsSettings = { recordType: "A", expected: null, resolver: null };

const answering =
  (answers: string[]): QueryDns =>
  async () =>
    answers;

const failing =
  (code: string): QueryDns =>
  async () => {
    throw Object.assign(new Error(code), { code });
  };

describe("matches", () => {
  it("ignores case and the trailing dot in names", () => {
    expect(matches("Example.COM.", "example.com", "CNAME")).toBe(true);
  });

  it("takes an MX server's name without its priority", () => {
    expect(matches("10 mx1.example.com", "mx1.example.com", "MX")).toBe(true);
    expect(matches("10 mx1.example.com", "10 MX1.example.com.", "MX")).toBe(true);
    expect(matches("10 mx1.example.com", "mx2.example.com", "MX")).toBe(false);
  });

  it("keeps the case of TXT values", () => {
    expect(matches("token=AbC", "token=AbC", "TXT")).toBe(true);
    expect(matches("token=AbC", "token=abc", "TXT")).toBe(false);
  });
});

describe("checkDns", () => {
  it("is up when the lookup answers", async () => {
    const result = await checkDns("example.com", A, 2000, answering(["93.184.215.14"]));
    expect(result).toMatchObject({ status: "UP", statusCode: null, error: null });
  });

  it("is up when the expected value is among the answers", async () => {
    const settings = { ...A, expected: "1.1.1.1" };
    const result = await checkDns(
      "one.one.one.one",
      settings,
      2000,
      answering(["1.0.0.1", "1.1.1.1"]),
    );
    expect(result.status).toBe("UP");
  });

  it("says what came back instead of the expected value", async () => {
    const settings = { ...A, expected: "1.1.1.1" };
    const result = await checkDns("example.com", settings, 2000, answering(["1.0.0.1", "1.0.0.2"]));
    expect(result).toMatchObject({
      status: "DOWN",
      error: "Expected 1.1.1.1, got 1.0.0.1, 1.0.0.2",
    });
    expect(result.responseMs).not.toBeNull();
  });

  it.each([
    ["ENOTFOUND", "nope.example.com doesn't exist"],
    ["ENODATA", "No A records for nope.example.com"],
    ["ETIMEOUT", "No answer within 2 s"],
    ["ESERVFAIL", "The DNS server failed to answer"],
    ["EREFUSED", "The DNS server refused the query"],
  ])("explains %s", async (code, error) => {
    const result = await checkDns("nope.example.com", A, 2000, failing(code));
    expect(result).toMatchObject({ status: "DOWN", error });
  });

  it("asks the chosen server", async () => {
    const asked: (string | null)[] = [];
    await checkDns("example.com", { ...A, resolver: "1.1.1.1" }, 2000, async (_n, _t, server) => {
      asked.push(server);
      return ["93.184.215.14"];
    });
    expect(asked).toEqual(["1.1.1.1"]);
  });

  it("never asks a server on a private network", async () => {
    let asked = false;
    const result = await checkDns(
      "example.com",
      { ...A, resolver: "10.0.0.53" },
      2000,
      async () => {
        asked = true;
        return [];
      },
    );
    expect(asked).toBe(false);
    expect(result).toMatchObject({ status: "DOWN", error: expect.stringMatching(/private/) });
  });
});
