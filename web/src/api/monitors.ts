import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Status } from "../components";
import { api } from "./client";

export type MonitorType = "HTTP" | "PING";
export type MonitorStatus = "PENDING" | "UP" | "DOWN" | "DEGRADED" | "PAUSED";

export interface Monitor {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  intervalSec: number;
  timeoutMs: number;
  retries: number;
  isActive: boolean;
  status: MonitorStatus;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  "name" | "type" | "target" | "intervalSec" | "timeoutMs" | "retries"
>;

export interface Check {
  id: string;
  status: "UP" | "DOWN" | "DEGRADED";
  responseMs: number | null;
  statusCode: number | null;
  error: string | null;
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
