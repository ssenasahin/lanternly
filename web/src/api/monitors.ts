import { useQuery } from "@tanstack/react-query";
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
};

export function useMonitors() {
  return useQuery({
    queryKey: monitorKeys.all,
    queryFn: () => api<{ monitors: Monitor[] }>("/monitors").then((r) => r.monitors),
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
    queryFn: () => api<{ checks: Check[] }>(`/monitors/${id}/checks`).then((r) => r.checks),
    refetchInterval: REFRESH_MS,
  });
}

// The API's states in the words the status badge uses.
export function badgeStatus(status: MonitorStatus): Status {
  return status.toLowerCase() as Status;
}
