import { describe, expect, it } from "vitest";
import { checkPing, parsePingOutput, pingArgs } from "./ping.js";

describe("parsePingOutput", () => {
  it.each([
    [
      "Linux",
      "64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=11.6 ms\n\n--- 1.1.1.1 ping statistics ---",
      12,
    ],
    ["BusyBox", "64 bytes from 1.1.1.1: seq=0 ttl=57 time=9.081 ms", 9],
    ["Windows", "Reply from 1.1.1.1: bytes=32 time=66ms TTL=56", 66],
    ["Windows, under a millisecond", "Reply from 1.1.1.1: bytes=32 time<1ms TTL=128", 1],
    ["Windows in Turkish", "1.1.1.1 yanıtı: bayt=32 süre=14ms TTL=56", 14],
  ])("reads the time from %s", (_platform, output, ms) => {
    expect(parsePingOutput(output)).toBe(ms);
  });

  it.each([
    ["a timeout", "Request timed out.\n    Packets: Sent = 1, Received = 0, Lost = 1 (100% loss),"],
    // Windows prints this, with exit code 0, when a router answers instead of the host.
    ["an unreachable host", "Reply from 192.168.1.1: Destination host unreachable."],
    ["Linux with no reply", "1 packets transmitted, 0 received, 100% packet loss, time 0ms"],
  ])("finds no reply in %s", (_case, output) => {
    expect(parsePingOutput(output)).toBeNull();
  });
});

describe("pingArgs", () => {
  it("speaks each platform's dialect", () => {
    expect(pingArgs("1.1.1.1", 5000, "win32")).toEqual(["-n", "1", "-w", "5000", "1.1.1.1"]);
    expect(pingArgs("1.1.1.1", 5000, "linux")).toEqual(["-c", "1", "-W", "5", "1.1.1.1"]);
    expect(pingArgs("1.1.1.1", 500, "linux")).toEqual(["-c", "1", "-W", "1", "1.1.1.1"]);
  });
});

describe("checkPing", () => {
  it("never pings a host the guard refuses", async () => {
    const { UnsafeTargetError } = await import("@lanternly/db");
    const result = await checkPing("intranet.example.com", 1000, async () => {
      throw new UnsafeTargetError("That host points at a private or reserved network");
    });
    expect(result).toMatchObject({ status: "DOWN", error: expect.stringMatching(/private/) });
  });

  it("pings the address the guard approved", async () => {
    // The guard approves loopback here only so the test needs no network access.
    const result = await checkPing("anything.test", 2000, async () => ["127.0.0.1"]);
    expect(result).toMatchObject({ status: "UP", error: null });
  });
});
