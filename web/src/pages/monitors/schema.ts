import type { FieldPath } from "react-hook-form";
import { z } from "zod";
import type {
  ApiSettings,
  BodyType,
  HttpMethod,
  Monitor,
  MonitorInput,
  Operator,
  RecordType,
} from "../../api/monitors";
import { METHODS, OPERATORS, PRESENCE } from "./operators";

// The same rules the API enforces, checked as the user types so most mistakes never
// make a round trip. The API stays the authority: only it can resolve the host and
// refuse a private address, and its errors land on the same fields.

const NUMERIC = new Set<Operator>(["GREATER_THAN", "LESS_THAN"]);

export const RECORD_TYPES: RecordType[] = ["A", "AAAA", "CNAME", "MX", "TXT"];

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const STATUS_ITEM = String.raw`(?:\d{3}(?:\s*-\s*\d{3})?|[1-5]xx)`;
const STATUS_LIST = new RegExp(String.raw`^\s*${STATUS_ITEM}(?:\s*,\s*${STATUS_ITEM})*\s*$`, "i");

const header = z.object({
  name: z.string().trim(),
  value: z.string(),
  secret: z.boolean(),
  // A secret header saved earlier, whose value the browser was never sent. Left
  // blank, it keeps that value.
  stored: z.boolean(),
});

const rule = z.object({
  path: z.string().trim(),
  operator: z.enum(OPERATORS.map((o) => o.value) as [Operator, ...Operator[]]),
  expected: z.string(),
});

export const monitorSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Give the monitor a name")
      .max(100, "Keep it under 100 characters"),
    type: z.enum(["HTTP", "API", "PING", "TCP", "DNS"]),
    target: z.string().trim().min(1, "Enter what to monitor").max(2048),
    intervalSec: z.number().int().min(30).max(300),
    // Seconds in the form; the API stores milliseconds.
    timeoutSec: z
      .number({ error: "Enter a number of seconds" })
      .min(1, "Allow at least 1 second")
      .max(30, "30 seconds at most"),
    retries: z.number().int().min(0).max(5),
    slowAfterMs: z
      .number({ error: "Enter a number of milliseconds" })
      .int("Use whole milliseconds")
      .min(10, "Allow at least 10 ms")
      .nullable(),
    // An API monitor's request and rules, flat in the form, gathered into `api` for
    // the API. Ignored for the other types.
    method: z.enum(METHODS as [HttpMethod, ...HttpMethod[]]),
    headers: z.array(header).max(20, "20 headers at most"),
    bodyType: z.enum(["NONE", "JSON", "FORM"]),
    body: z.string().max(10_000, "Keep the body under 10,000 characters"),
    expectedStatus: z.string(),
    rules: z.array(rule).max(20, "20 rules at most"),
    // A DNS monitor's question, gathered into `dns` for the API.
    recordType: z.enum(RECORD_TYPES as [RecordType, ...RecordType[]]),
    dnsExpected: z.string().trim().max(500, "Keep it under 500 characters"),
    dnsResolver: z.string().trim(),
    // An escalation policy's id, or "" to alert the owner and every channel at once.
    escalationPolicyId: z.string(),
  })
  .superRefine((form, ctx) => {
    const problem = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    const target = TARGET_PROBLEMS[form.type];
    if (!target.valid(form.target)) problem(["target"], target.message);
    if (form.type === "DNS" && form.dnsResolver && !IP.test(form.dnsResolver)) {
      problem(["dnsResolver"], "Use a DNS server's IP address, like 1.1.1.1");
    }
    const attempts = form.retries + 1;
    if (form.timeoutSec * attempts > form.intervalSec) {
      problem(
        ["timeoutSec"],
        `${attempts} attempts of ${form.timeoutSec} s don't fit in a ${form.intervalSec} s interval`,
      );
    }
    if (form.slowAfterMs !== null && form.slowAfterMs >= form.timeoutSec * 1000) {
      problem(["slowAfterMs"], "Set it below the timeout, or it can never be reached");
    }
    if (form.type !== "API") return;

    if (!STATUS_LIST.test(form.expectedStatus)) {
      problem(["expectedStatus"], "Like 200, 200-299, 2xx, or a list: 200, 304");
    }
    if (sendsBody(form) && form.bodyType === "JSON" && form.body.trim()) {
      try {
        JSON.parse(form.body);
      } catch {
        problem(["body"], "This isn't valid JSON");
      }
    }
    const names = new Set<string>();
    form.headers.forEach((h, i) => {
      if (!h.name) problem(["headers", i, "name"], "Name the header");
      else if (!HEADER_NAME.test(h.name)) {
        problem(["headers", i, "name"], "Letters, digits and dashes, like X-Api-Key");
      } else if (names.has(h.name.toLowerCase())) {
        problem(["headers", i, "name"], "Already set above");
      }
      names.add(h.name.toLowerCase());
      if (!h.value && !(h.secret && h.stored)) problem(["headers", i, "value"], "Enter a value");
      if (/[\r\n]/.test(h.value)) problem(["headers", i, "value"], "Keep it on one line");
    });
    form.rules.forEach((r, i) => {
      if (!r.path) problem(["rules", i, "path"], "Enter a path, like data.status");
      if (PRESENCE.has(r.operator)) return;
      if (!r.expected) problem(["rules", i, "expected"], "Enter a value");
      else if (NUMERIC.has(r.operator) && !Number.isFinite(Number(r.expected))) {
        problem(["rules", i, "expected"], "Compare with a number");
      }
    });
  });

export type MonitorForm = z.infer<typeof monitorSchema>;

// Loose on purpose: the API knows IPv6 and says exactly what's wrong.
const IP = /^(\d{1,3}(\.\d{1,3}){3}|[\da-f:]*:[\da-f:.]*)$/i;

const TARGET_PROBLEMS: Record<
  MonitorForm["type"],
  { valid: (t: string) => boolean; message: string }
> = {
  HTTP: { valid: isWebUrl, message: "Enter a full URL, starting with https://" },
  API: { valid: isWebUrl, message: "Enter a full URL, starting with https://" },
  PING: {
    valid: (t) => !/[\s/]/.test(t),
    message: "Enter a host name like example.com, or an IP address",
  },
  TCP: {
    valid: (t) => /^(\[[^\]]+\]|[^\s:/[\]]+):\d{1,5}$/.test(t),
    message: "Enter a host and a port, like db.example.com:5432",
  },
  DNS: {
    valid: (t) => !/[\s/:]/.test(t) && !/^[\d.]+$/.test(t),
    message: "Enter a domain name like example.com",
  },
};

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// GET and HEAD requests carry no body, whatever the form says.
export function sendsBody(form: { method: HttpMethod; bodyType: BodyType }) {
  return form.bodyType !== "NONE" && form.method !== "GET" && form.method !== "HEAD";
}

const NO_API = {
  method: "GET",
  headers: [],
  bodyType: "NONE",
  body: "",
  expectedStatus: "200-299",
  rules: [],
} satisfies Partial<MonitorForm>;

const NO_DNS = {
  recordType: "A",
  dnsExpected: "",
  dnsResolver: "",
} satisfies Partial<MonitorForm>;

export const NEW_MONITOR: MonitorForm = {
  name: "",
  type: "HTTP",
  target: "",
  intervalSec: 60,
  timeoutSec: 10,
  retries: 1,
  slowAfterMs: null,
  escalationPolicyId: "",
  ...NO_API,
  ...NO_DNS,
};

export const NEW_RULE = { path: "", operator: "EQUALS", expected: "" } as const;
export const NEW_HEADER = { name: "", value: "", secret: false, stored: false } as const;

export function toForm(monitor: Monitor): MonitorForm {
  const { api, dns } = monitor;
  return {
    name: monitor.name,
    // Heartbeats and agents have pages of their own and never get here.
    type: monitor.type === "HEARTBEAT" || monitor.type === "AGENT" ? "HTTP" : monitor.type,
    target: monitor.target,
    intervalSec: monitor.intervalSec,
    timeoutSec: monitor.timeoutMs / 1000,
    retries: monitor.retries,
    slowAfterMs: monitor.slowAfterMs,
    escalationPolicyId: monitor.escalationPolicy?.id ?? "",
    ...(api
      ? {
          method: api.method,
          headers: api.headers.map((h) => ({
            name: h.name,
            value: h.value ?? "",
            secret: h.secret,
            stored: h.secret,
          })),
          bodyType: api.bodyType,
          body: api.body ?? "",
          expectedStatus: api.expectedStatus,
          rules: api.rules.map((r) => ({ ...r, expected: r.expected ?? "" })),
        }
      : NO_API),
    ...(dns
      ? {
          recordType: dns.recordType,
          dnsExpected: dns.expected ?? "",
          dnsResolver: dns.resolver ?? "",
        }
      : NO_DNS),
  };
}

export function toApiSettings(form: MonitorForm): ApiSettings {
  return {
    method: form.method,
    // A stored secret left blank goes back as null: "keep what you have".
    headers: form.headers.map((h) => ({
      name: h.name,
      value: h.secret && h.stored && !h.value ? null : h.value,
      secret: h.secret,
    })),
    bodyType: form.bodyType,
    body: form.bodyType === "NONE" ? null : form.body,
    expectedStatus: form.expectedStatus,
    rules: form.rules.map((r) => ({
      path: r.path,
      operator: r.operator,
      expected: PRESENCE.has(r.operator) ? null : r.expected,
    })),
  };
}

export function toInput(form: MonitorForm): MonitorInput {
  return {
    name: form.name,
    type: form.type,
    target: form.target,
    intervalSec: form.intervalSec,
    timeoutMs: Math.round(form.timeoutSec * 1000),
    retries: form.retries,
    slowAfterMs: form.slowAfterMs,
    escalationPolicyId: form.escalationPolicyId || null,
    ...(form.type === "API" && { api: toApiSettings(form) }),
    ...(form.type === "DNS" && {
      dns: {
        recordType: form.recordType,
        expected: form.dnsExpected || null,
        resolver: form.dnsResolver || null,
      },
    }),
  };
}

// The DNS settings' names in the form, where the API's would be too vague.
const DNS_FIELDS: Record<string, FieldPath<MonitorForm>> = {
  "dns.recordType": "recordType",
  "dns.expected": "dnsExpected",
  "dns.resolver": "dnsResolver",
};

// API field names ("timeoutMs", "api.rules.0.path"), mapped to where the error should
// show in the form.
export function formField(apiField: string): FieldPath<MonitorForm> | null {
  if (apiField === "timeoutMs") return "timeoutSec";
  if (apiField in DNS_FIELDS) return DNS_FIELDS[apiField]!;
  const field = apiField.replace(/^api\./, "");
  return field.split(".")[0]! in NEW_MONITOR ? (field as FieldPath<MonitorForm>) : null;
}
