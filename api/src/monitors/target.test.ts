import { isPublicAddress } from "@lanternly/db";
import { describe, expect, it } from "vitest";
import { HttpError } from "../http.js";
import { checkTarget } from "./target.js";

const dns: Record<string, string[]> = {
  "example.com": ["93.184.215.14"],
  "rebind.example.com": ["10.1.2.3"],
};
const resolve = async (host: string) => {
  const found = dns[host];
  if (!found) throw new Error("ENOTFOUND");
  return found;
};

// The message the API would show under the target field.
async function refusal(type: "HTTP" | "PING", target: string) {
  try {
    await checkTarget(type, target, resolve);
  } catch (err) {
    if (err instanceof HttpError) return (err.details as { target: string[] }).target[0];
    throw err;
  }
  return null;
}

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "127.8.9.10",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.215.14", "172.32.0.1", "2606:4700:4700::1111"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe("checkTarget for HTTP", () => {
  it("accepts and normalises a public URL", async () => {
    await expect(checkTarget("HTTP", "https://EXAMPLE.com", resolve)).resolves.toBe(
      "https://example.com/",
    );
  });

  it.each([
    ["http://127.0.0.1:5432", "private"],
    ["http://[::1]/", "private"],
    ["http://169.254.169.254/latest/meta-data/", "private"],
    // Other spellings of 127.0.0.1 that the URL parser normalises.
    ["http://2130706433/", "private"],
    ["http://0x7f.1/", "private"],
    ["http://127.1/", "private"],
    ["http://rebind.example.com/", "private"],
    ["http://nowhere.example.com/", "couldn't find"],
    ["ftp://example.com/", "Only http"],
    ["file:///etc/passwd", "Only http"],
    ["example.com", "full URL"],
    ["https://admin:hunter2@example.com/", "user name"],
  ])("refuses %s", async (target, reason) => {
    expect(await refusal("HTTP", target)).toContain(reason);
  });
});

describe("checkTarget for ping", () => {
  it("accepts a host name or a public IP", async () => {
    await expect(checkTarget("PING", "Example.com", resolve)).resolves.toBe("example.com");
    await expect(checkTarget("PING", "1.1.1.1", resolve)).resolves.toBe("1.1.1.1");
  });

  it.each([
    ["10.0.0.1", "private"],
    ["::1", "private"],
    ["rebind.example.com", "private"],
    ["127.1", "host name"],
    ["https://example.com", "host name"],
    ["example.com:22", "host name"],
    ["-bad-.example.com", "host name"],
  ])("refuses %s", async (target, reason) => {
    expect(await refusal("PING", target)).toContain(reason);
  });
});
