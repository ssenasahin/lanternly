import { resolvePublicHost } from "../network.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkHttp } from "./http.js";
import type { Resolve } from "./types.js";

let server: Server;
let base: string;

// A tiny site with a page for every situation a check can run into.
beforeAll(async () => {
  server = createServer((req, res) => {
    const go = (location: string) => res.writeHead(302, { location }).end();
    switch (req.url) {
      case "/ok":
        return res.end("fine");
      case "/no-content":
        return res.writeHead(204).end();
      case "/broken":
        return res.writeHead(500).end("oops");
      case "/missing":
        return res.writeHead(404).end();
      case "/slow":
        return void setTimeout(() => res.end("late"), 2000);
      case "/hop":
        return go("/ok");
      case "/loop":
        return go("/loop");
      case "/to-metadata":
        return go("http://169.254.169.254/latest/meta-data/");
      case "/to-intranet":
        return go(`http://intranet.test:${port()}/ok`);
      case "/to-ftp":
        return go("ftp://app.test/");
      default:
        return res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://app.test:${port()}`;
});
afterAll(() => new Promise((done) => server.close(done)));

const port = () => (server.address() as AddressInfo).port;

// The real guard, with one exception: app.test is the local test server. Everything
// else, including IP literals and intranet.test, goes through the production rules.
const resolve: Resolve = (host) =>
  host === "app.test"
    ? Promise.resolve(["127.0.0.1"])
    : resolvePublicHost(host, async (name) => {
        if (name === "intranet.test") return ["10.0.0.7"];
        throw new Error("ENOTFOUND");
      });

describe("checkHttp", () => {
  it("is up on a 200 and reports the timing", async () => {
    const result = await checkHttp(`${base}/ok`, 2000, resolve);
    expect(result).toMatchObject({ status: "UP", statusCode: 200, error: null });
    expect(result.responseMs).toBeGreaterThanOrEqual(0);
  });

  it("counts any 2xx as up", async () => {
    expect(await checkHttp(`${base}/no-content`, 2000, resolve)).toMatchObject({
      status: "UP",
      statusCode: 204,
    });
  });

  it.each([
    ["/broken", 500],
    ["/missing", 404],
  ])("is down on %s", async (path, statusCode) => {
    expect(await checkHttp(`${base}${path}`, 2000, resolve)).toMatchObject({
      status: "DOWN",
      statusCode,
      error: `HTTP ${statusCode}`,
    });
  });

  it("follows redirects to the final answer", async () => {
    expect(await checkHttp(`${base}/hop`, 2000, resolve)).toMatchObject({
      status: "UP",
      statusCode: 200,
    });
  });

  it("gives up on a redirect loop", async () => {
    expect(await checkHttp(`${base}/loop`, 2000, resolve)).toMatchObject({
      status: "DOWN",
      error: "Too many redirects",
    });
  });

  it("times out", async () => {
    expect(await checkHttp(`${base}/slow`, 300, resolve)).toMatchObject({
      status: "DOWN",
      error: "Timed out after 0.3 s",
    });
  });

  it("reports a refused connection in words", async () => {
    // Borrow a free port and let it go, so nothing is listening on it.
    const spare = createServer();
    await new Promise<void>((done) => spare.listen(0, "127.0.0.1", done));
    const closed = (spare.address() as AddressInfo).port;
    await new Promise((done) => spare.close(done));

    expect(await checkHttp(`http://app.test:${closed}/`, 2000, resolve)).toMatchObject({
      status: "DOWN",
      error: "Connection refused",
    });
  });

  it("explains a port that fetch refuses to use", async () => {
    expect(await checkHttp("http://app.test:25/", 2000, resolve)).toMatchObject({
      status: "DOWN",
      error: "That port is blocked for web requests",
    });
  });

  describe("SSRF", () => {
    it("won't follow a redirect to the cloud metadata address", async () => {
      const result = await checkHttp(`${base}/to-metadata`, 2000, resolve);
      expect(result.status).toBe("DOWN");
      expect(result.error).toMatch(/private or reserved network/);
    });

    it("won't follow a redirect to a name that resolves inside the network", async () => {
      const result = await checkHttp(`${base}/to-intranet`, 2000, resolve);
      expect(result.status).toBe("DOWN");
      expect(result.error).toMatch(/private or reserved network/);
    });

    it("won't follow a redirect away from http", async () => {
      const result = await checkHttp(`${base}/to-ftp`, 2000, resolve);
      expect(result.error).toMatch(/isn't http or https/);
    });

    it("refuses a target whose DNS changed to a private address after it was saved", async () => {
      // Saved while intranet.test was public; by the time it's checked, it isn't.
      const result = await checkHttp(`http://intranet.test:${port()}/ok`, 2000, resolve);
      expect(result.status).toBe("DOWN");
      expect(result.error).toMatch(/private or reserved network/);
    });
  });
});
