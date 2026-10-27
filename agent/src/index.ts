// A small process installed on a server that reports CPU, memory and disk to
// Lanternly once a minute. It only ever sends; Lanternly never connects to it.
import { hostname, platform } from "node:os";
import si from "systeminformation";
import { Outbox, type Sample } from "./outbox.js";

const EVERY_MS = 60_000;
const TIMEOUT_MS = 15_000;

const url = process.env.LANTERNLY_URL?.replace(/\/$/, "");
const key = process.env.LANTERNLY_AGENT_KEY;
if (!url || !key) {
  console.error(
    "Set LANTERNLY_URL and LANTERNLY_AGENT_KEY. The dashboard shows both when you add a server.",
  );
  process.exit(1);
}
// The key travels in a header; over plain HTTP anyone on the way could read it.
if (url.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(url)) {
  console.warn("Warning: LANTERNLY_URL isn't https, so the agent key is sent unencrypted.");
}

const round = (n: number) => Math.round(n * 10) / 10;

// The fullest disk counts: one full volume is enough to break a server.
async function measure(): Promise<Sample> {
  const [load, memory, disks] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()]);
  const real = disks.filter((d) => d.size > 0 && Number.isFinite(d.use));
  return {
    at: new Date().toISOString(),
    cpu: round(load.currentLoad),
    // "active" leaves out the cache the kernel gives back on demand.
    memory: round((memory.active / memory.total) * 100),
    disk: round(Math.max(0, ...real.map((d) => d.use))),
  };
}

async function send(samples: Sample[]) {
  const res = await fetch(`${url}/api/agent/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ host: { hostname: hostname(), platform: platform() }, samples }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) {
    // A deleted agent or a replaced key: retrying won't help.
    console.error(
      "Lanternly doesn't recognise this agent's key. Copy a new one from the dashboard.",
    );
    process.exit(1);
  }
  if (!res.ok) throw new Error(`Lanternly answered HTTP ${res.status}`);
}

const outbox = new Outbox();

async function tick() {
  try {
    outbox.add(await measure());
    await outbox.flush(send);
  } catch (err) {
    console.error(
      `Couldn't report (${outbox.size} samples waiting):`,
      err instanceof Error ? err.message : err,
    );
  }
}

console.log(`lanternly agent reporting to ${url} every ${EVERY_MS / 1000} s`);
// systeminformation measures CPU load since its previous call, so the first reading
// is taken a moment after a priming one.
await si.currentLoad();
setTimeout(() => void tick(), 1000);
const timer = setInterval(() => void tick(), EVERY_MS);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
}
