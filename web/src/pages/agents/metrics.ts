import type { AgentRange } from "../../api/agents";

export type Metric = "cpu" | "memory" | "disk";

// What an agent reports, each as percent used, with the level that raises an alert.
export const METRICS: { key: Metric; label: string; noun: string; limit: number | null }[] = [
  { key: "cpu", label: "CPU", noun: "CPU", limit: 90 },
  { key: "memory", label: "Memory", noun: "memory", limit: null },
  { key: "disk", label: "Disk", noun: "disk", limit: 90 },
];

// The width of each averaged point the API returns for a range.
export const BUCKET_SEC: Record<AgentRange, number> = {
  "1h": 60,
  "24h": 600,
  "7d": 3600,
  "30d": 21600,
};
