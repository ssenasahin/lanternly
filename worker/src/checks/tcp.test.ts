import { UnsafeTargetError } from "@lanternly/db";
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTcp } from "./tcp.js";

// The guard approves loopback here only so the tests need no network access.
const local = async () => ["127.0.0.1"];

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((socket) => socket.end());
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((closed) => server.close(() => closed())));

describe("checkTcp", () => {
  it("is up when the port accepts a connection", async () => {
    const result = await checkTcp(`db.example.com:${port}`, 2000, local);
    expect(result).toMatchObject({ status: "UP", statusCode: null, error: null });
    expect(result.responseMs).toBeGreaterThanOrEqual(1);
  });

  it("connects to the address the guard approved, not the name", async () => {
    const asked: string[] = [];
    await checkTcp(`db.example.com:${port}`, 2000, async (host) => {
      asked.push(host);
      return ["127.0.0.1"];
    });
    expect(asked).toEqual(["db.example.com"]);
  });

  it("says when nothing is listening", async () => {
    // Bind and release a port, so it's known to be closed.
    const spare = createServer();
    await new Promise<void>((ready) => spare.listen(0, "127.0.0.1", ready));
    const closed = (spare.address() as AddressInfo).port;
    await new Promise<void>((done) => spare.close(() => done()));

    const result = await checkTcp(`db.example.com:${closed}`, 2000, local);
    expect(result).toMatchObject({ status: "DOWN", error: expect.stringMatching(/refused/) });
  });

  it("never connects to a host the guard refuses", async () => {
    const result = await checkTcp("intranet.example.com:22", 1000, async () => {
      throw new UnsafeTargetError("That host points at a private or reserved network");
    });
    expect(result).toMatchObject({ status: "DOWN", error: expect.stringMatching(/private/) });
  });

  it("refuses a target without a port", async () => {
    const result = await checkTcp("db.example.com", 1000, local);
    expect(result).toMatchObject({ status: "DOWN", error: expect.stringMatching(/port/) });
  });
});
