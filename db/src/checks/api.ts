import { Agent, fetch, Headers } from "undici";
import { describeError, guardedLookup, USER_AGENT } from "./http.js";
import { describeFailure, evaluateRules, type Rule, type RuleResult } from "./rules.js";
import { acceptsStatus } from "./status-codes.js";
import { failed, type Attempt, type Resolve } from "./types.js";

// The same values as the database's enums of these names; spelled out here so the
// check doesn't depend on the schema.
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type BodyType = "NONE" | "JSON" | "FORM";

export interface ApiRequestSpec {
  url: string;
  method: HttpMethod;
  // Decrypted: the caller has already unwrapped any secret values.
  headers: { name: string; value: string }[];
  bodyType: BodyType;
  body: string | null;
  // Like "200-299" or "200, 304": see status-codes.ts.
  expectedStatus: string;
  rules: Rule[];
}

export interface ApiAttempt extends Attempt {
  // Every rule's verdict, passed or not, in the order they were written.
  rules: RuleResult[];
  // What came back, for "Test now" to show. Null if nothing did.
  response: { contentType: string | null; body: string; truncated: boolean } | null;
}

// Rules need the whole body to parse it; past this size it's not an API response
// worth checking, and reading on would only tie up the worker.
export const MAX_RESPONSE_BYTES = 1024 * 1024;
// How much of the body "Test now" sends back to the browser.
const PREVIEW_CHARS = 64 * 1024;

const CONTENT_TYPES: Record<Exclude<BodyType, "NONE">, string> = {
  JSON: "application/json",
  FORM: "application/x-www-form-urlencoded",
};

// Sends one request the way the monitor describes it, then checks the status code
// and every rule against the answer. Unlike a website check, redirects aren't
// followed: for an API a 301 is an answer in itself, checked like any other code.
export async function checkApi(
  spec: ApiRequestSpec,
  timeoutMs: number,
  resolve: Resolve,
): Promise<ApiAttempt> {
  const agent = new Agent({ connect: { lookup: guardedLookup(resolve) } });
  const signal = AbortSignal.timeout(timeoutMs);
  const started = performance.now();
  try {
    const url = new URL(spec.url);
    // Connecting to an IP address skips DNS, and with it the lookup's guard.
    await resolve(url.hostname);

    const headers = new Headers({ "user-agent": USER_AGENT, accept: "application/json, */*" });
    const sendsBody = spec.bodyType !== "NONE" && spec.method !== "GET" && spec.method !== "HEAD";
    if (sendsBody) headers.set("content-type", CONTENT_TYPES[spec.bodyType as "JSON" | "FORM"]);
    // The user's own headers win, content type included.
    for (const { name, value } of spec.headers) headers.set(name, value);

    const res = await fetch(url, {
      dispatcher: agent,
      signal,
      method: spec.method,
      redirect: "manual",
      headers,
      body: sendsBody ? (spec.body ?? "") : undefined,
    });
    const { text, truncated } = await readCapped(res.body);
    const responseMs = Math.round(performance.now() - started);

    const { rules, problem } = judgeBody(spec.rules, text, truncated);
    const statusProblem = acceptsStatus(spec.expectedStatus, res.status)
      ? null
      : `HTTP ${res.status}, expected ${spec.expectedStatus}`;
    // The status code is the more basic failure, so it's the one named.
    const error = statusProblem ?? problem;
    return {
      status: error ? "DOWN" : "UP",
      responseMs,
      statusCode: res.status,
      error,
      rules,
      response: {
        contentType: res.headers.get("content-type"),
        body: text.slice(0, PREVIEW_CHARS),
        truncated: truncated || text.length > PREVIEW_CHARS,
      },
    };
  } catch (err) {
    return { ...failed(describeError(err, signal, timeoutMs)), rules: [], response: null };
  } finally {
    void agent.destroy();
  }
}

// Reads up to MAX_RESPONSE_BYTES and drops the rest.
async function readCapped(body: AsyncIterable<Uint8Array> | null) {
  if (!body) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    if (size + chunk.length > MAX_RESPONSE_BYTES) {
      chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size));
      truncated = true;
      break;
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

// Parses the body and runs the rules, or explains why they couldn't run.
function judgeBody(rules: Rule[], text: string, truncated: boolean) {
  if (rules.length === 0) return { rules: [], problem: null };
  const unchecked = (problem: string) => ({
    rules: rules.map((rule) => ({ ...rule, passed: false, received: null })),
    problem,
  });
  if (truncated) return unchecked("The response is over 1 MB, too large to check rules against");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return unchecked(text.trim() ? "The response isn't JSON" : "The response was empty");
  }
  const results = evaluateRules(rules, json);
  const failures = results.filter((r) => !r.passed);
  if (failures.length === 0) return { rules: results, problem: null };
  const more = failures.length > 1 ? ` (and ${failures.length - 1} more)` : "";
  return { rules: results, problem: `${describeFailure(failures[0]!)}${more}` };
}
