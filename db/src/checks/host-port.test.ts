import { describe, expect, it } from "vitest";
import { formatHostPort, parseHostPort } from "./host-port.js";

describe("parseHostPort", () => {
  it.each([
    ["db.example.com:5432", "db.example.com", 5432],
    ["  DB.Example.com:5432 ", "db.example.com", 5432],
    ["203.0.114.10:22", "203.0.114.10", 22],
    ["[2001:db8::1]:443", "2001:db8::1", 443],
    ["mail:25", "mail", 25],
  ])("reads %s", (target, host, port) => {
    expect(parseHostPort(target)).toEqual({ host, port });
  });

  it.each([
    ["db.example.com", /host and a port/],
    ["db.example.com:", /host and a port/],
    ["https://db.example.com:5432", /host and a port/],
    ["db.example.com:0", /1 to 65535/],
    ["db.example.com:70000", /1 to 65535/],
    ["2001:db8::1", /brackets/],
    ["[not-an-ip]:443", /isn't an IPv6/],
  ])("refuses %s", (target, problem) => {
    expect(() => parseHostPort(target)).toThrow(problem);
  });
});

describe("formatHostPort", () => {
  it("brackets IPv6 addresses only", () => {
    expect(formatHostPort("2001:db8::1", 443)).toBe("[2001:db8::1]:443");
    expect(formatHostPort("db.example.com", 5432)).toBe("db.example.com:5432");
  });
});
