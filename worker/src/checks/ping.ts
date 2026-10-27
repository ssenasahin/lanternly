import { UnsafeTargetError } from "@lanternly/db";
import { execFile } from "node:child_process";
import { failed, type Attempt, type Resolve } from "./types.js";

// Sends one ICMP echo with the system's ping command, since raw ICMP sockets need
// root. The command differs per platform: count and timeout flags, and the units.
export function pingArgs(address: string, timeoutMs: number, platform = process.platform) {
  if (platform === "win32") return ["-n", "1", "-w", String(timeoutMs), address];
  if (platform === "darwin") return ["-c", "1", "-W", String(timeoutMs), address];
  return ["-c", "1", "-W", String(Math.max(1, Math.ceil(timeoutMs / 1000))), address];
}

// Reads the round-trip time out of ping's output, or null if there was no reply.
// Every implementation prints the reply's TTL, and the time as "=12.3 ms" or "<1ms",
// whatever language the word for "time" is in.
export function parsePingOutput(output: string): number | null {
  if (!/ttl=/i.test(output)) return null;
  const time = /[=<]\s*([\d.]+)\s*ms/i.exec(output);
  return time ? Math.max(1, Math.round(Number(time[1]))) : null;
}

export async function checkPing(
  host: string,
  timeoutMs: number,
  resolve: Resolve,
): Promise<Attempt> {
  let address: string;
  try {
    [address] = (await resolve(host)) as [string];
  } catch (err) {
    return failed(err instanceof UnsafeTargetError ? err.message : "Host not found");
  }

  // Ping the address the guard approved, never the name: DNS can't change in between,
  // and arguments are passed as a list with no shell, so nothing in them is executed.
  return new Promise((done) => {
    execFile(
      "ping",
      pingArgs(address, timeoutMs),
      { timeout: timeoutMs + 2000, windowsHide: true },
      (_error, stdout) => {
        const ms = parsePingOutput(stdout);
        done(
          ms === null
            ? failed(`No reply within ${timeoutMs / 1000} s`)
            : { status: "UP", responseMs: ms, statusCode: null, error: null },
        );
      },
    );
  });
}
