import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Status } from "../components";
import { api } from "./client";

export type MonitorType = "HTTP" | "API" | "PING" | "HEARTBEAT";
// The types Lanternly checks itself, as opposed to heartbeats that call in.
export type CheckedType = Exclude<MonitorType, "HEARTBEAT">;
export type MonitorStatus = "PENDING" | "UP" | "DOWN" | "DEGRADED" | "PAUSED";

// What a heartbeat expects, as monitor lists carry it. The ping URL is not here: it
// comes only with the heartbeat itself (see api/heartbeats).
export interface HeartbeatSchedule {
  periodSec: number | null;
  cron: string | null;
  timezone: string;
  graceSec: number;
  lastPingAt: string | null;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type BodyType = "NONE" | "JSON" | "FORM";
export type Operator =
  "EQUALS" | "NOT_EQUALS" | "CONTAINS" | "GREATER_THAN" | "LESS_THAN" | "EXISTS" | "NOT_EXISTS";

export interface Rule {
  path: string;
  operator: Operator;
  expected: string | null;
}

// One rule's verdict on a response: received is the value found, as JSON, or null if
// the path led nowhere.
export interface RuleResult extends Rule {
  passed: boolean;
  received: string | null;
}

// How an API monitor calls its endpoint. A secret header's value never comes back
// from the API: it's null, and sending null again keeps the stored one.
export interface ApiSettings {
  method: HttpMethod;
  headers: { name: string; value: string | null; secret: boolean }[];
  bodyType: BodyType;
  body: string | null;
  expectedStatus: string;
  rules: Rule[];
}

export interface Monitor {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  intervalSec: number;
  timeoutMs: number;
  retries: number;
  // Slower answers count as degraded; null when there's no limit.
  slowAfterMs: number | null;
  isActive: boolean;
  status: MonitorStatus;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Set for heartbeats only.
  heartbeat: HeartbeatSchedule | null;
  // Set for API monitors only.
  api: ApiSettings | null;
}

// One hour of the last 24, oldest first, as the list's strip shows it.
export interface HourSlot {
  checks: number;
  failures: number;
}

export interface ListedMonitor extends Monitor {
  lastDay: HourSlot[];
}

export type MonitorInput = Pick<
  Monitor,
  "name" | "target" | "intervalSec" | "timeoutMs" | "retries" | "slowAfterMs"
> & {
  type: CheckedType;
  api?: ApiSettings;
};

// What "Test now" found: the check's verdict plus what the API sent back.
export interface TestResult {
  status: "UP" | "DOWN" | "DEGRADED";
  responseMs: number | null;
  statusCode: number | null;
  error: string | null;
  rules: RuleResult[];
  response: { contentType: string | null; body: string; truncated: boolean } | null;
}

export interface Check {
  id: string;
  status: "UP" | "DOWN" | "DEGRADED";
  responseMs: number | null;
  statusCode: number | null;
  error: string | null;
  // Every rule's verdict, kept when one of them failed.
  rules: RuleResult[] | null;
  checkedAt: string;
}

export type Range = "1h" | "24h" | "7d" | "30d";
export const RANGES: Range[] = ["1h", "24h", "7d", "30d"];

export interface Bucket {
  at: string;
  checks: number;
  failures: number;
  avgMs: number | null;
}

export interface Stats {
  range: Range;
  // Uptime over the three standard windows, whatever range is selected. Null means
  // no checks ran in that window, which is not the same as 0%.
  windows: Record<"24h" | "7d" | "30d", number | null>;
  checks: number;
  failures: number;
  uptime: number | null;
  avgMs: number | null;
  p95Ms: number | null;
  series: Bucket[];
  bucketSec: number;
  from: string;
  to: string;
}

export interface Incident {
  id: string;
  startedAt: string;
  resolvedAt: string | null;
  cause: string | null;
  monitor: Pick<Monitor, "id" | "name" | "type" | "target">;
}

export interface OpenIncident {
  id: string;
  startedAt: string;
  cause: string | null;
}

// The worker changes monitors behind the user's back as checks run, so every view
// of them quietly refetches. 30 seconds matches the shortest check interval.
export const REFRESH_MS = 30_000;

// Invalidating ["monitors"] refreshes the list, every detail and every check list.
export const monitorKeys = {
  all: ["monitors"] as const,
  detail: (id: string) => ["monitors", id] as const,
  checks: (id: string) => ["monitors", id, "checks"] as const,
  stats: (id: string, range: Range) => ["monitors", id, "stats", range] as const,
  heartbeat: (id: string) => ["monitors", id, "heartbeat"] as const,
  pings: (id: string) => ["monitors", id, "pings"] as const,
};

export function useMonitors() {
  return useQuery({
    queryKey: monitorKeys.all,
    queryFn: () => api<{ monitors: ListedMonitor[] }>("/monitors").then((r) => r.monitors),
    refetchInterval: REFRESH_MS,
  });
}

export function useMonitor(id: string) {
  return useQuery({
    queryKey: monitorKeys.detail(id),
    queryFn: () => api<{ monitor: Monitor; openIncident: OpenIncident | null }>(`/monitors/${id}`),
    refetchInterval: REFRESH_MS,
  });
}

export function useChecks(id: string) {
  return useQuery({
    queryKey: monitorKeys.checks(id),
    queryFn: () =>
      api<{ checks: Check[] }>(`/monitors/${id}/checks?limit=20`).then((r) => r.checks),
    refetchInterval: REFRESH_MS,
  });
}

export function useStats(id: string, range: Range) {
  return useQuery({
    queryKey: monitorKeys.stats(id, range),
    queryFn: () => api<Stats>(`/monitors/${id}/stats?range=${range}`),
    refetchInterval: REFRESH_MS,
    // Switching range keeps the old chart on screen (dimmed) until the new one
    // arrives, instead of flashing a skeleton.
    placeholderData: keepPreviousData,
  });
}

export type IncidentFilter = "all" | "open" | "resolved";

export function useIncidents(filter: IncidentFilter, monitorId?: string) {
  const params = new URLSearchParams({ status: filter, limit: monitorId ? "10" : "100" });
  if (monitorId) params.set("monitorId", monitorId);
  return useQuery({
    // Under "monitors" too, so pausing or deleting a monitor refreshes these.
    queryKey: ["monitors", "incidents", filter, monitorId ?? "all"],
    queryFn: () => api<{ incidents: Incident[] }>(`/incidents?${params}`).then((r) => r.incidents),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

// The API's states in the words the status badge uses.
export function badgeStatus(status: MonitorStatus): Status {
  return status.toLowerCase() as Status;
}
