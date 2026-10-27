import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BellRing,
  CheckCircle2,
  CircleAlert,
  Hand,
  Megaphone,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Link, useParams } from "react-router";
import {
  alertKeys,
  useIncident,
  type IncidentDetail,
  type IncidentEvent,
  type IncidentEventType,
} from "../../api/alerts";
import { ApiError, api } from "../../api/client";
import { Alert, SkeletonRows, StatusBadge } from "../../components";
import { formatDuration, formatTime, timeAgo } from "../../lib/format";
import { NotFoundPage } from "../NotFound";
import "../pages.css";
import "../monitors/monitors.css";
import "./incidents.css";

const EVENTS: Record<IncidentEventType, { label: string; icon: LucideIcon; tone: string }> = {
  OPENED: { label: "Went down", icon: CircleAlert, tone: "bad" },
  NOTIFIED: { label: "Alerted", icon: BellRing, tone: "muted" },
  NOT_DELIVERED: { label: "Alert didn't arrive", icon: TriangleAlert, tone: "warn" },
  ESCALATED: { label: "Escalated", icon: Megaphone, tone: "warn" },
  ACKNOWLEDGED: { label: "Acknowledged", icon: Hand, tone: "info" },
  RESOLVED: { label: "Back up", icon: CheckCircle2, tone: "good" },
};

export function IncidentDetailPage() {
  const { id = "" } = useParams();
  const incident = useIncident(id);

  if (incident.error instanceof ApiError && incident.error.status === 404) return <NotFoundPage />;
  return (
    <>
      <Link to="/incidents" className="back-link">
        <ArrowLeft size={14} aria-hidden /> Incidents
      </Link>
      {incident.isPending && (
        <section className="card card-body">
          <SkeletonRows rows={4} height={40} />
        </section>
      )}
      {incident.isError && <Alert tone="error">Couldn't load this incident.</Alert>}
      {incident.data && (
        <IncidentBody
          incident={incident.data.incident}
          events={incident.data.events}
          now={incident.dataUpdatedAt}
        />
      )}
    </>
  );
}

function IncidentBody({
  incident: i,
  events,
  now,
}: {
  incident: IncidentDetail;
  events: IncidentEvent[];
  now: number;
}) {
  const queryClient = useQueryClient();
  const ack = useMutation({
    mutationFn: () => api(`/incidents/${i.id}/ack`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: alertKeys.incident(i.id) }),
  });
  const started = Date.parse(i.startedAt);
  const lasted = (i.resolvedAt ? Date.parse(i.resolvedAt) : now) - started;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>
            <Link to={`/monitors/${i.monitor.id}`} className="incident-title-link">
              {i.monitor.name}
            </Link>{" "}
            {i.resolvedAt ? (
              <StatusBadge status="up" label="Resolved" />
            ) : i.acknowledgedAt ? (
              <StatusBadge status="degraded" label="Acknowledged" />
            ) : (
              <StatusBadge status="down" label="Ongoing" />
            )}
          </h1>
          <p>{i.cause ?? "No response"}</p>
        </div>
        {!i.resolvedAt && !i.acknowledgedAt && (
          <button className="btn btn-primary" onClick={() => ack.mutate()} disabled={ack.isPending}>
            <Hand size={16} aria-hidden /> {ack.isPending ? "Acknowledging…" : "Acknowledge"}
          </button>
        )}
      </header>

      <div className="stack">
        {!i.resolvedAt && !i.acknowledgedAt && i.monitor.escalationPolicy && (
          <Alert tone="info">
            Acknowledging tells Lanternly someone is on it, and stops "
            {i.monitor.escalationPolicy.name}" from alerting the next step.
          </Alert>
        )}

        <dl className="card card-body facts">
          <div>
            <dt>Started</dt>
            <dd className="mono">{formatTime(i.startedAt)}</dd>
          </div>
          <div>
            <dt>{i.resolvedAt ? "Lasted" : "Down for"}</dt>
            <dd>{formatDuration(lasted)}</dd>
          </div>
          <div>
            <dt>Acknowledged</dt>
            <dd>
              {i.acknowledgedAt
                ? `${timeAgo(i.acknowledgedAt, now)} by ${i.acknowledgedBy}`
                : "Not yet"}
            </dd>
          </div>
          <div>
            <dt>Escalation</dt>
            <dd>{i.monitor.escalationPolicy?.name ?? "None: everyone at once"}</dd>
          </div>
        </dl>

        <section className="card card-body">
          <h2 className="section-title">Timeline</h2>
          <ol className="timeline">
            {events.map((e) => {
              const { label, icon: Icon, tone } = EVENTS[e.type];
              return (
                <li key={e.id} className={`timeline-item tone-${tone}`}>
                  <span className="timeline-dot">
                    <Icon size={14} aria-hidden />
                  </span>
                  <div className="timeline-body">
                    <div className="timeline-head">
                      <strong>{label}</strong>
                      <time className="mono" dateTime={e.at}>
                        {formatTime(e.at)}
                      </time>
                    </div>
                    {e.detail && <p className="timeline-detail">{e.detail}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </>
  );
}
