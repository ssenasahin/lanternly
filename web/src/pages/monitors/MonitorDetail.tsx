import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ExternalLink, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, api } from "../../api/client";
import { badgeStatus, monitorKeys, useChecks, useMonitor, type Monitor } from "../../api/monitors";
import { Alert, EmptyState, SkeletonRows, StatusBadge } from "../../components";
import { formatSeconds, formatTime, timeAgo } from "../../lib/format";
import { NotFoundPage } from "../NotFound";
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
          <Alert tone="info">Paused. No checks run and no alerts go out until you resume it.</Alert>
        )}

        <dl className="card card-body facts">
          <Fact label="Check every">{formatSeconds(monitor.intervalSec)}</Fact>
          <Fact label="Timeout">{formatSeconds(monitor.timeoutMs / 1000)}</Fact>
          <Fact label="Retries">{monitor.retries === 0 ? "None" : monitor.retries}</Fact>
          <Fact label="Last checked">
            {monitor.lastCheckedAt ? timeAgo(monitor.lastCheckedAt) : "Not yet"}
          </Fact>
        </dl>

        <RecentChecks id={monitor.id} />
      </div>
    </>
  );
}

function Target({ monitor }: { monitor: Monitor }) {
  if (monitor.type !== "HTTP") return <p className="detail-target mono">ping {monitor.target}</p>;
  return (
    <a className="detail-target mono" href={monitor.target} target="_blank" rel="noreferrer">
      {monitor.target} <ExternalLink size={12} aria-hidden />
    </a>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Actions({ monitor }: { monitor: Monitor }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: monitorKeys.all });

  const toggle = useMutation({
    mutationFn: () =>
      api(`/monitors/${monitor.id}/${monitor.isActive ? "pause" : "resume"}`, { method: "POST" }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: () => api(`/monitors/${monitor.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: monitorKeys.detail(monitor.id) });
      await refresh();
      navigate("/", { replace: true });
    },
  });

  // Deleting throws away the monitor's whole history, so it takes a second click.
  if (confirming) {
    return (
      <div className="row confirm-delete" role="group" aria-label="Confirm delete">
        <span>Delete it and all its history?</span>
        <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
          Keep it
        </button>
        <button
          className="btn btn-danger"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          autoFocus
        >
          <Trash2 size={15} aria-hidden /> {remove.isPending ? "Deleting…" : "Delete"}
        </button>
      </div>
    );
  }

  return (
    <div className="row">
      {(toggle.error || remove.error) && (
        <span className="field-error">{(toggle.error ?? remove.error)?.message}</span>
      )}
      <button className="btn" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
        {monitor.isActive ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}
        {monitor.isActive ? "Pause" : "Resume"}
      </button>
      <Link to={`/monitors/${monitor.id}/edit`} className="btn">
        <Pencil size={15} aria-hidden /> Edit
      </Link>
      <button
        className="btn btn-ghost btn-icon"
        onClick={() => setConfirming(true)}
        aria-label="Delete monitor"
        title="Delete monitor"
      >
        <Trash2 size={15} />
      </button>
    </div>
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
