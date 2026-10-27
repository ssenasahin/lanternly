import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { MonitorType } from "./monitors";

// Where alerts go, who they reach and in what order: channels, the team, escalation
// policies, and an incident's own story.

export type ChannelType = "SLACK" | "TELEGRAM" | "WEBHOOK";

// Secret settings come back as null: sending null again keeps the stored value.
export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  settings: Record<string, string | null>;
  lastSentAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  email: string;
  role: "OWNER" | "MEMBER";
  joinedAt: string;
}

export interface Team {
  team: { id: string; name: string };
  members: TeamMember[];
  invites: { id: string; email: string; expiresAt: string; createdAt: string }[];
  memberOf: { id: string; name: string; ownerEmail: string }[];
}

export type EscalationTarget =
  { kind: "member"; userId: string } | { kind: "channel"; channelId: string };

export interface EscalationStep {
  waitMinutes: number;
  targets: EscalationTarget[];
}

export interface EscalationPolicy {
  id: string;
  name: string;
  steps: EscalationStep[];
  monitors: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

export type IncidentEventType =
  "OPENED" | "NOTIFIED" | "NOT_DELIVERED" | "ESCALATED" | "ACKNOWLEDGED" | "RESOLVED";

export interface IncidentDetail {
  id: string;
  startedAt: string;
  resolvedAt: string | null;
  cause: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  monitor: {
    id: string;
    name: string;
    type: MonitorType;
    target: string;
    escalationPolicy: { id: string; name: string } | null;
  };
}

export interface IncidentEvent {
  id: string;
  type: IncidentEventType;
  at: string;
  detail: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const alertKeys = {
  channels: ["channels"] as const,
  team: ["team"] as const,
  policies: ["escalation-policies"] as const,
  incident: (id: string) => ["incident", id] as const,
  apiKeys: ["api-keys"] as const,
};

export function useChannels() {
  return useQuery({
    queryKey: alertKeys.channels,
    queryFn: () => api<{ channels: Channel[] }>("/channels").then((r) => r.channels),
  });
}

export function useTeam() {
  return useQuery({ queryKey: alertKeys.team, queryFn: () => api<Team>("/team") });
}

export function usePolicies() {
  return useQuery({
    queryKey: alertKeys.policies,
    queryFn: () =>
      api<{ policies: EscalationPolicy[] }>("/escalation-policies").then((r) => r.policies),
  });
}

// Refreshed while it's ongoing: escalation and acknowledgements add to the timeline.
export function useIncident(id: string) {
  return useQuery({
    queryKey: alertKeys.incident(id),
    queryFn: () => api<{ incident: IncidentDetail; events: IncidentEvent[] }>(`/incidents/${id}`),
    refetchInterval: (query) => (query.state.data?.incident.resolvedAt ? false : 15_000),
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: alertKeys.apiKeys,
    queryFn: () => api<{ keys: ApiKey[] }>("/api-keys").then((r) => r.keys),
  });
}
