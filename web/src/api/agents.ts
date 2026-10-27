import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./client";

export interface AgentSample {
  at: string;
  cpu: number;
  memory: number;
  disk: number;
}

export interface Agent {
  monitorId: string;
  keyPrefix: string;
  hostname: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  latest: AgentSample | null;
}

// How to start the agent on a server, with its key filled in.
export interface InstallCommands {
  shell: string;
  powershell: string;
}

export type AgentRange = "1h" | "24h" | "7d" | "30d";

// Agents report once a minute; refreshing as often keeps the gauges current.
export function useAgent(id: string) {
  return useQuery({
    queryKey: ["agent", id],
    queryFn: () => api<{ agent: Agent }>(`/agents/${id}`).then((r) => r.agent),
    refetchInterval: 60_000,
  });
}

export function useAgentMetrics(id: string, range: AgentRange) {
  return useQuery({
    queryKey: ["agent", id, "metrics", range],
    queryFn: () =>
      api<{ points: AgentSample[] }>(`/agents/${id}/metrics?range=${range}`).then((r) => r.points),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

// A new key is shown once, when an agent is added or its key replaced.
export interface IssuedKey {
  key: string;
  install: InstallCommands;
}
