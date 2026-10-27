import {
  normaliseStatusCodes,
  openHeaders,
  PRESENCE,
  ruleProblem,
  sealHeaders,
  statusCodesProblem,
  type ApiRequestSpec,
  type Prisma,
  type StoredHeader,
} from "@lanternly/db";
import { z } from "zod";
import { HttpError } from "../http.js";

// How an API monitor calls its endpoint and judges the answer, as the API accepts it.
// Header values may be null: for a secret header, that keeps the value already
// stored, which the browser was never sent.

// RFC 9110's token characters: what a header name may be made of.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Set by the HTTP client itself; letting users set them would break the request.
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);

const header = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name the header")
    .max(100)
    .regex(HEADER_NAME, "Use letters, digits and dashes, like X-Api-Key")
    .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), "Lanternly sets this one itself"),
  value: z
    .string()
    .max(4000, "Keep it under 4,000 characters")
    .regex(/^[^\r\n\0]*$/, "Keep it on one line")
    .nullable(),
  secret: z.boolean().default(false),
});

const rule = z.object({
  path: z.string().trim().min(1, "Enter a path, like data.status").max(200),
  operator: z.enum([
    "EQUALS",
    "NOT_EQUALS",
    "CONTAINS",
    "GREATER_THAN",
    "LESS_THAN",
    "EXISTS",
    "NOT_EXISTS",
  ]),
  expected: z.string().max(500, "Keep it under 500 characters").nullable().default(null),
});

export const MAX_RULES = 20;

export const apiSettings = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    headers: z.array(header).max(20, "20 headers at most").default([]),
    bodyType: z.enum(["NONE", "JSON", "FORM"]).default("NONE"),
    body: z.string().max(10_000, "Keep the body under 10,000 characters").nullable().default(null),
    expectedStatus: z.string().trim().max(100).default("200-299"),
    rules: z.array(rule).max(MAX_RULES, `${MAX_RULES} rules at most`).default([]),
  })
  .superRefine((api, ctx) => {
    const problem = statusCodesProblem(api.expectedStatus);
    if (problem) ctx.addIssue({ code: "custom", path: ["expectedStatus"], message: problem });

    if (api.bodyType === "JSON" && api.body?.trim()) {
      try {
        JSON.parse(api.body);
      } catch {
        ctx.addIssue({ code: "custom", path: ["body"], message: "This isn't valid JSON" });
      }
    }

    const seen = new Set<string>();
    api.headers.forEach((h, i) => {
      const name = h.name.toLowerCase();
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["headers", i, "name"],
          message: "Already set above",
        });
      }
      seen.add(name);
      if (h.value === null && !h.secret) {
        ctx.addIssue({ code: "custom", path: ["headers", i, "value"], message: "Enter a value" });
      }
    });

    api.rules.forEach((r, i) => {
      const message = ruleProblem(r);
      if (!message) return;
      // Path problems belong under the path; the rest are about the value.
      const field = /path|key|dot/i.test(message) ? "path" : "expected";
      ctx.addIssue({ code: "custom", path: ["rules", i, field], message });
    });
  });

export type ApiSettings = z.infer<typeof apiSettings>;

// Fills in the secret values the browser left out from what's stored, matching by
// name. The error is keyed by the field's full path, as validate() keys nested ones.
export function withStoredSecrets(
  headers: ApiSettings["headers"],
  stored: StoredHeader[],
): StoredHeader[] {
  return headers.map((h, i) => {
    if (h.value !== null) return { name: h.name, value: h.value, secret: h.secret };
    const kept = stored.find((s) => s.secret && s.name.toLowerCase() === h.name.toLowerCase());
    if (!kept) {
      throw new HttpError(400, "Invalid request", {
        [`api.headers.${i}.value`]: ["Enter a value"],
      });
    }
    return { name: h.name, value: kept.value, secret: true };
  });
}

// The settings with the leftovers dropped: a body without a body type, an expected
// value on a presence check.
function tidy(api: ApiSettings) {
  return {
    method: api.method,
    bodyType: api.bodyType,
    body: api.bodyType === "NONE" ? null : api.body,
    expectedStatus: normaliseStatusCodes(api.expectedStatus),
    rules: api.rules.map((r) => ({
      path: r.path,
      operator: r.operator,
      expected: PRESENCE.has(r.operator) ? null : r.expected,
    })),
  };
}

// What's stored for an API monitor's request and its rules.
export function apiRows(api: ApiSettings, headers: StoredHeader[], key: Buffer) {
  const { rules, ...request } = tidy(api);
  return {
    request: { ...request, headers: sealHeaders(headers, key) },
    assertions: rules.map((r, position) => ({ position, ...r })),
  };
}

// The same settings, ready to send without saving them first.
export function toSpec(url: string, api: ApiSettings, headers: StoredHeader[]): ApiRequestSpec {
  return { url, ...tidy(api), headers: headers.map(({ name, value }) => ({ name, value })) };
}

// What a monitor query selects of its API settings.
export const apiFields = {
  apiRequest: {
    select: { method: true, headers: true, bodyType: true, body: true, expectedStatus: true },
  },
  assertions: {
    select: { path: true, operator: true, expected: true },
    orderBy: { position: "asc" },
  },
} satisfies Prisma.MonitorSelect;

type WithApi = Prisma.MonitorGetPayload<{ select: typeof apiFields }>;

// The settings as the browser sees them: secret header values left out.
export function presentApi({ apiRequest, assertions }: WithApi, key: Buffer) {
  if (!apiRequest) return null;
  return {
    ...apiRequest,
    headers: openHeaders(apiRequest.headers, key).map(({ name, value, secret }) => ({
      name,
      value: secret ? null : value,
      secret,
    })),
    rules: assertions,
  };
}
