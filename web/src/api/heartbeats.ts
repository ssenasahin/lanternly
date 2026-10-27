import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import { monitorKeys, REFRESH_MS, type HeartbeatSchedule, type Monitor } from "./monitors";

export interface Heartbeat extends HeartbeatSchedule {
  lastStartAt: string | null;
  // The URL the job calls. Its last part is the secret: treat it like a password.
  pingUrl: string;
  // When the next ping is due, and when it counts as late; null before the first ping.
  expectedAt: string | null;
  lateAt: string | null;
}

export interface HeartbeatDetail {
  monitor: Pick<
    Monitor,
    "id" | "name" | "type" | "isActive" | "status" | "lastCheckedAt" | "createdAt" | "updatedAt"
  >;
  heartbeat: Heartbeat;
}

export interface HeartbeatInput {
  name: string;
  // Exactly one of the two.
  periodSec: number | null;
  cron: string | null;
  timezone: string;
  graceSec: number;
}

export type PingKind = "SUCCESS" | "START" | "FAIL";

export interface Ping {
  id: string;
  kind: PingKind;
  receivedAt: string;
  durationMs: number | null;
  ip: string | null;
  userAgent: string | null;
  body: string | null;
}

export function useHeartbeat(id: string) {
  return useQuery({
    queryKey: monitorKeys.heartbeat(id),
    queryFn: () => api<HeartbeatDetail>(`/heartbeats/${id}`),
    refetchInterval: REFRESH_MS,
  });
}

export function usePings(id: string) {
  return useQuery({
    queryKey: monitorKeys.pings(id),
    queryFn: () => api<{ pings: Ping[] }>(`/heartbeats/${id}/pings?limit=20`).then((r) => r.pings),
    refetchInterval: REFRESH_MS,
  });
}
