import {
  failed,
  parseHostPort,
  UnsafeTargetError,
  type Attempt,
  type Resolve,
} from "@lanternly/db";
import { connect } from "node:net";

// What a failed connection's error code means to someone reading the dashboard.
const REASONS: Record<string, string> = {
  ECONNREFUSED: "Connection refused: nothing is listening on that port",
  ECONNRESET: "The connection was reset",
  EHOSTUNREACH: "The host can't be reached",
  ENETUNREACH: "The network can't be reached",
};

// Up when a TCP connection to host:port opens. Nothing is sent: an open connection
// is the whole test, and it's closed again at once.
export async function checkTcp(
  target: string,
  timeoutMs: number,
  resolve: Resolve,
): Promise<Attempt> {
  let host: string;
  let port: number;
  try {
    ({ host, port } = parseHostPort(target));
  } catch (err) {
    return failed((err as Error).message);
  }

  let address: string;
  try {
    [address] = (await resolve(host)) as [string];
  } catch (err) {
    return failed(err instanceof UnsafeTargetError ? err.message : "Host not found");
  }

  // Connect to the address the guard approved, never the name, so DNS can't point
  // somewhere else in between.
  return new Promise((done) => {
    const started = performance.now();
    const socket = connect({ host: address, port });
    const finish = (result: Attempt) => {
      clearTimeout(timer);
      socket.destroy();
      done(result);
    };
    const timer = setTimeout(
      () => finish(failed(`No connection within ${timeoutMs / 1000} s`)),
      timeoutMs,
    );
    socket.once("connect", () => {
      const responseMs = Math.max(1, Math.round(performance.now() - started));
      finish({ status: "UP", responseMs, statusCode: null, error: null });
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(failed(REASONS[err.code ?? ""] ?? `Connection failed: ${err.message}`));
    });
  });
}
