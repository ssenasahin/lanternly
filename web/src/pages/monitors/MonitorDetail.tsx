import { Activity, ArrowLeft, ExternalLink } from "lucide-react";
import { Link, useParams } from "react-router";
import { ApiError } from "../../api/client";
import { badgeStatus, useChecks, useMonitor, type Monitor } from "../../api/monitors";
import { Alert, EmptyState, SkeletonRows, StatusBadge } from "../../components";
import { describeSchedule, formatSeconds, formatTime, timeAgo } from "../../lib/format";
import { HeartbeatBody } from "../heartbeats/HeartbeatBody";
import { NotFoundPage } from "../NotFound";
import { MonitorIncidents, MonitorStats } from "./MonitorStats";
import { Actions, Fact } from "./parts";
import "../pages.css";
import "./monitors.css";

export function MonitorDetailPage() {
  const { id = "" } = useParams();
  const detail = useMonitor(id);

  if (detail.isPending) {
    return (
      <div className="stack">
        <SkeletonRows rows={1} height={64} />
        <SkeletonRows rows={6} height={36} />
      </div>
    );
  }
  if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFoundPage />;
  if (detail.isError) {
    return (
      <Alert tone="error">
        Couldn't load this monitor.{" "}
        <button className="link-button" onClick={() => void detail.refetch()}>
          Try again
        </button>
      </Alert>
    );
  }

  const { monitor, openIncident } = detail.data;
  const isHeartbeat = monitor.type === "HEARTBEAT";
  return (
    <>
      <header className="page-header">
        <div className="detail-title">
          <Link to="/" className="back-link">
            <ArrowLeft size={14} aria-hidden /> Monitors
          </Link>
          <div className="row">
            <h1>{monitor.name}</h1>
            <StatusBadge status={badgeStatus(monitor.status)} />
          </div>
          <Target monitor={monitor} />
        </div>
        <Actions monitor={monitor} />
      </header>

      <div className="stack">
        {openIncident && (
          <Alert tone="error">
            <strong>Down since {formatTime(openIncident.startedAt)}</strong> (
            {timeAgo(openIncident.startedAt)}). {openIncident.cause ?? "No response"}. You'll get an
            email when it's back up.
          </Alert>
        )}
        {!monitor.isActive && (
          <Alert tone="info">
            {isHeartbeat
              ? "Paused. Pings are still logged, but a missed or failed run raises no alert until you resume it."
              : "Paused. No checks run and no alerts go out until you resume it."}
          </Alert>
        )}
        {isHeartbeat && monitor.isActive && monitor.status === "PENDING" && (
          <Alert tone="info">
            Waiting for the first ping. Lanternly starts watching the schedule once it arrives.
          </Alert>
        )}

        {isHeartbeat ? <HeartbeatBody id={monitor.id} /> : <CheckedBody monitor={monitor} />}
      </div>
    </>
  );
}

// A monitor Lanternly checks itself: what it measured, and how it's set up.
function CheckedBody({ monitor }: { monitor: Monitor }) {
  return (
    <>
      <MonitorStats monitorId={monitor.id} />
      <MonitorIncidents monitorId={monitor.id} />

      <dl className="card card-body facts">
        <Fact label="Check every">{formatSeconds(monitor.intervalSec)}</Fact>
        <Fact label="Timeout">{formatSeconds(monitor.timeoutMs / 1000)}</Fact>
        <Fact label="Retries">{monitor.retries === 0 ? "None" : monitor.retries}</Fact>
        <Fact label="Last checked">
          {monitor.lastCheckedAt ? timeAgo(monitor.lastCheckedAt) : "Not yet"}
        </Fact>
      </dl>

      <RecentChecks id={monitor.id} />
    </>
  );
}

function Target({ monitor }: { monitor: Monitor }) {
  if (monitor.heartbeat) {
    const { timezone, cron } = monitor.heartbeat;
    return (
      <p className="detail-target mono">
        heartbeat, {describeSchedule(monitor.heartbeat)}
        {cron && timezone !== "UTC" ? ` (${timezone})` : ""}
      </p>
    );
  }
  if (monitor.type !== "HTTP") return <p className="detail-target mono">ping {monitor.target}</p>;
  return (
    <a className="detail-target mono" href={monitor.target} target="_blank" rel="noreferrer">
      {monitor.target} <ExternalLink size={12} aria-hidden />
    </a>
  );
}

function RecentChecks({ id }: { id: string }) {
  const checks = useChecks(id);

  return (
    <section className="card">
      <div className="card-body checks-head">
        <h2 className="section-title">Recent checks</h2>
      </div>
      {checks.isPending && (
        <div className="card-body">
          <SkeletonRows rows={5} height={28} />
        </div>
      )}
      {checks.isError && (
        <div className="card-body">
          <Alert tone="error">Couldn't load the checks.</Alert>
        </div>
      )}
      {checks.data?.length === 0 && (
        <EmptyState icon={Activity} title="No checks yet">
          The first check runs within a few seconds of adding a monitor. This page refreshes on its
          own.
        </EmptyState>
      )}
      {checks.data && checks.data.length > 0 && (
        <div className="table-scroll">
          <table className="checks">
            <thead>
              <tr>
                <th>Time</th>
                <th>Result</th>
                <th className="num">Response</th>
                <th className="num">Code</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {checks.data.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{formatTime(c.checkedAt)}</td>
                  <td>
                    <StatusBadge status={badgeStatus(c.status)} />
                  </td>
                  <td className="num mono">{c.responseMs === null ? "–" : `${c.responseMs} ms`}</td>
                  <td className="num mono">{c.statusCode ?? "–"}</td>
                  <td className="check-error">{c.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
