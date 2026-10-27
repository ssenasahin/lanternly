import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import { api } from "../../api/client";
import { AuthHeader } from "../../auth/AuthLayout";
import { Alert, SkeletonRows } from "../../components";
import { formatTime, timeAgo } from "../../lib/format";

interface Preview {
  incident: {
    startedAt: string;
    resolvedAt: string | null;
    cause: string | null;
    acknowledgedAt: string | null;
    acknowledgedBy: string | null;
    monitor: { name: string };
  };
  as: string;
}

// Where an alert's Acknowledge link leads. Opening it changes nothing: mail scanners
// open every link. The button does, signed by the link, with no sign-in needed.
export function AcknowledgePage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const by = params.get("by") ?? "";
  const sig = params.get("sig") ?? "";
  const query = `by=${encodeURIComponent(by)}&sig=${encodeURIComponent(sig)}`;

  const preview = useQuery({
    queryKey: ["ack", id, by],
    queryFn: () => api<Preview>(`/ack/${id}?${query}`, { auth: false }),
    retry: false,
  });
  const ack = useMutation({
    mutationFn: () =>
      api<{ acknowledged: boolean; incident: Preview["incident"] }>(`/ack/${id}`, {
        method: "POST",
        body: { by, sig },
        auth: false,
      }),
  });

  if (preview.isPending) return <SkeletonRows rows={3} height={32} />;
  if (preview.isError) {
    return (
      <>
        <AuthHeader title="Can't use this link" />
        <Alert tone="error">{preview.error.message}</Alert>
      </>
    );
  }

  const incident = ack.data?.incident ?? preview.data.incident;
  const { name } = incident.monitor;

  if (incident.resolvedAt) {
    return (
      <>
        <AuthHeader title={`${name} is back up`} />
        <Alert tone="success">
          It recovered {timeAgo(incident.resolvedAt)}. There's nothing left to acknowledge.
        </Alert>
      </>
    );
  }
  if (incident.acknowledgedAt) {
    return (
      <>
        <AuthHeader title="Acknowledged" />
        <Alert tone="success">
          {ack.data?.acknowledged ? "Thanks. " : ""}
          {incident.acknowledgedBy} acknowledged it {timeAgo(incident.acknowledgedAt)}. Lanternly
          won't alert anyone further for this outage, and will say when it's back up.
        </Alert>
      </>
    );
  }

  return (
    <>
      <AuthHeader title={`${name} is down`}>
        Since {formatTime(incident.startedAt)}: {incident.cause ?? "No response"}
      </AuthHeader>
      <p className="muted">
        Acknowledging tells your team you're on it and stops the alert from escalating to the next
        people. It will show as acknowledged by {preview.data.as}.
      </p>
      {ack.error && <Alert tone="error">{ack.error.message}</Alert>}
      <button
        className="btn btn-primary btn-block"
        onClick={() => ack.mutate()}
        disabled={ack.isPending}
      >
        {ack.isPending ? "Acknowledging…" : "Acknowledge"}
      </button>
    </>
  );
}
