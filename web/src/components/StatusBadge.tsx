import { Check, Clock, Pause, TriangleAlert, Wrench, X, type LucideIcon } from "lucide-react";

export type Status = "up" | "down" | "degraded" | "maintenance" | "paused" | "pending";

const META: Record<Status, { label: string; Icon: LucideIcon }> = {
  up: { label: "Operational", Icon: Check },
  down: { label: "Down", Icon: X },
  degraded: { label: "Degraded", Icon: TriangleAlert },
  maintenance: { label: "Maintenance", Icon: Wrench },
  paused: { label: "Paused", Icon: Pause },
  pending: { label: "Pending", Icon: Clock },
};

export function StatusBadge({ status }: { status: Status }) {
  const { label, Icon } = META[status];
  return (
    <span className={`badge badge-${status}`}>
      <Icon size={13} strokeWidth={2.5} aria-hidden />
      {label}
    </span>
  );
}
