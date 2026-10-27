import { z } from "zod";
import type { Monitor, MonitorInput } from "../../api/monitors";

// The same rules the API enforces, checked as the user types so most mistakes never
// make a round trip. The API stays the authority: only it can resolve the host and
// refuse a private address, and its errors land on the same fields.
export const monitorSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Give the monitor a name")
      .max(100, "Keep it under 100 characters"),
    type: z.enum(["HTTP", "PING"]),
    target: z.string().trim().min(1, "Enter what to monitor").max(2048),
    intervalSec: z.number().int().min(30).max(300),
    // Seconds in the form; the API stores milliseconds.
    timeoutSec: z
      .number({ error: "Enter a number of seconds" })
      .min(1, "Allow at least 1 second")
      .max(30, "30 seconds at most"),
    retries: z.number().int().min(0).max(5),
  })
  .superRefine((form, ctx) => {
    if (form.type === "HTTP" && !isWebUrl(form.target)) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "Enter a full URL, starting with https://",
      });
    }
    if (form.type === "PING" && /[\s/]/.test(form.target)) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "Enter a host name like example.com, or an IP address",
      });
    }
    const attempts = form.retries + 1;
    if (form.timeoutSec * attempts > form.intervalSec) {
      ctx.addIssue({
        code: "custom",
        path: ["timeoutSec"],
        message: `${attempts} attempts of ${form.timeoutSec} s don't fit in a ${form.intervalSec} s interval`,
      });
    }
  });

export type MonitorForm = z.infer<typeof monitorSchema>;

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const NEW_MONITOR: MonitorForm = {
  name: "",
  type: "HTTP",
  target: "",
  intervalSec: 60,
  timeoutSec: 10,
  retries: 1,
};

export function toForm(monitor: Monitor): MonitorForm {
  return {
    name: monitor.name,
    type: monitor.type,
    target: monitor.target,
    intervalSec: monitor.intervalSec,
    timeoutSec: monitor.timeoutMs / 1000,
    retries: monitor.retries,
  };
}

export function toInput({ timeoutSec, ...form }: MonitorForm): MonitorInput {
  return { ...form, timeoutMs: Math.round(timeoutSec * 1000) };
}

// API field names, mapped to where the error should show in the form.
export function formField(apiField: string): keyof MonitorForm | null {
  if (apiField === "timeoutMs") return "timeoutSec";
  return apiField in NEW_MONITOR ? (apiField as keyof MonitorForm) : null;
}
