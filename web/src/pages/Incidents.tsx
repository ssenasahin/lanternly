import { Siren } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useIncidents, type Incident, type IncidentFilter } from "../api/monitors";
import { Alert, EmptyState, Segmented, SkeletonRows, StatusBadge } from "../components";
import { formatDuration, formatTime, timeAgo } from "../lib/format";
import "./pages.css";
import "./monitors/monitors.css";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "open", label: "Ongoing" },
  { value: "resolved", label: "Resolved" },
] as const;

const EMPTY: Record<IncidentFilter, string> = {
  all: "When a monitor goes down, Lanternly opens an incident here and closes it when the monitor recovers.",
  open: "Nothing is down right now.",
  resolved: "No outage has ended yet.",
};

// Every outage across all monitors, newest first, refreshed every 30 seconds.
export function IncidentsPage() {
  const [filter, setFilter] = useState<IncidentFilter>("all");
  const incidents = useIncidents(filter);
  // "Now" for ongoing durations: when the data was fetched, so render stays pure.
  const now = incidents.dataUpdatedAt;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Incidents</h1>
          <p>Every outage, when it started, how long it lasted and why.</p>
        </div>
      </header>

      <div className="list-controls">
        <Segmented label="Show" options={FILTERS} value={filter} onChange={setFilter} />
      </div>

      {incidents.isPending && (
        <section className="card card-body">
          <SkeletonRows rows={5} height={36} />
        </section>
      )}

      {incidents.isError && (
        <Alert tone="error">
          Couldn't load incidents.{" "}
          <button className="link-button" onClick={() => void incidents.refetch()}>
            Try again
          </button>
        </Alert>
      )}

      {incidents.data && (
        <section className={`card${incidents.isPlaceholderData ? " is-refreshing" : ""}`}>
          {incidents.data.length === 0 ? (
            <EmptyState icon={Siren} title="No incidents">
              {EMPTY[filter]}
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="checks incidents">
                <thead>
                  <tr>
                    <th>State</th>
                    <th>Monitor</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Cause</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.data.map((i) => (
                    <IncidentRow key={i.id} incident={i} now={now} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function IncidentRow({ incident: i, now }: { incident: Incident; now: number }) {
  const started = Date.parse(i.startedAt);
  return (
    <tr>
      <td>
        <StatusBadge
          status={i.resolvedAt ? "up" : "down"}
          label={i.resolvedAt ? "Resolved" : "Ongoing"}
        />
      </td>
      <td>
        <Link to={`/monitors/${i.monitor.id}`} className="incident-monitor">
          {i.monitor.name}
        </Link>
        <div className="incident-target mono">
          {i.monitor.type === "HEARTBEAT" ? "heartbeat" : i.monitor.target}
        </div>
      </td>
      <td>
        <span className="mono">{formatTime(i.startedAt)}</span>
        <div className="incident-ago">{timeAgo(i.startedAt, now)}</div>
      </td>
      <td>
        {i.resolvedAt
          ? formatDuration(Date.parse(i.resolvedAt) - started)
          : `${formatDuration(now - started)} so far`}
      </td>
      <td className="check-error">{i.cause ?? "No response"}</td>
    </tr>
  );
}
