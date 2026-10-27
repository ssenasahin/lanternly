import { failed, isPublicAddress, type Attempt } from "@lanternly/db";
import { Resolver } from "node:dns/promises";

export type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT";

export interface DnsSettings {
  recordType: RecordType;
  // A value that must be among the answers; null accepts any answer.
  expected: string | null;
  // A public DNS server to ask instead of the default ones.
  resolver: string | null;
}

// Asked when a monitor names no server. Not the system's resolver: that one knows
// the worker's private network, and its answers would end up on someone's dashboard.
export const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

// Asks for one record type and returns the answers as text. Swappable so tests
// don't depend on real DNS.
export type QueryDns = (
  name: string,
  recordType: RecordType,
  server: string | null,
  timeoutMs: number,
) => Promise<string[]>;

export const queryDns: QueryDns = async (name, recordType, server, timeoutMs) => {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers(server ? [server] : PUBLIC_RESOLVERS);
  switch (recordType) {
    case "A":
      return resolver.resolve4(name);
    case "AAAA":
      return resolver.resolve6(name);
    case "CNAME":
      return resolver.resolveCname(name);
    case "MX":
      return (await resolver.resolveMx(name))
        .sort((a, b) => a.priority - b.priority)
        .map((mx) => `${mx.priority} ${mx.exchange}`);
    case "TXT":
      // A long TXT record arrives in 255-byte chunks; they make one value.
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
  }
};

// Names compare without case or the root's trailing dot. TXT values keep their
// case: verification tokens are case-sensitive.
function normalise(value: string, recordType: RecordType): string {
  const trimmed = value.trim();
  return recordType === "TXT" ? trimmed : trimmed.toLowerCase().replace(/\.$/, "");
}

// An MX answer is "10 mail.example.com"; expecting just the server's name is enough.
export function matches(answer: string, expected: string, recordType: RecordType): boolean {
  const want = normalise(expected, recordType);
  const got = normalise(answer, recordType);
  if (got === want) return true;
  return recordType === "MX" && got.split(" ")[1] === want;
}

function reason(
  err: NodeJS.ErrnoException,
  name: string,
  settings: DnsSettings,
  timeoutMs: number,
) {
  switch (err.code) {
    case "ENOTFOUND":
      return `${name} doesn't exist`;
    case "ENODATA":
      return `No ${settings.recordType} records for ${name}`;
    case "ETIMEOUT":
      return `No answer within ${timeoutMs / 1000} s`;
    case "ECONNREFUSED":
    case "ESERVFAIL":
      return "The DNS server failed to answer";
    case "EREFUSED":
      return "The DNS server refused the query";
    default:
      return `DNS lookup failed: ${err.code ?? err.message}`;
  }
}

// Up when the lookup answers, and, if a value is expected, when it's among the answers.
export async function checkDns(
  name: string,
  settings: DnsSettings,
  timeoutMs: number,
  query: QueryDns = queryDns,
): Promise<Attempt> {
  // The API refuses private servers too; this keeps an old row from reaching one.
  if (settings.resolver && !isPublicAddress(settings.resolver)) {
    return failed("That DNS server is on a private or reserved network");
  }

  const started = performance.now();
  let answers: string[];
  try {
    answers = await query(name, settings.recordType, settings.resolver, timeoutMs);
  } catch (err) {
    return failed(reason(err as NodeJS.ErrnoException, name, settings, timeoutMs));
  }
  const responseMs = Math.max(1, Math.round(performance.now() - started));

  if (answers.length === 0) return failed(`No ${settings.recordType} records for ${name}`);
  const { expected } = settings;
  if (expected && !answers.some((a) => matches(a, expected, settings.recordType))) {
    const got = answers.join(", ");
    return {
      ...failed(`Expected ${expected}, got ${got.length > 200 ? `${got.slice(0, 200)}…` : got}`),
      responseMs,
    };
  }
  return { status: "UP", responseMs, statusCode: null, error: null };
}
