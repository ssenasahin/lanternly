import { ChevronRight, Globe, Plus, Radar, Radio } from "lucide-react";
import { Link } from "react-router";
import { badgeStatus, useMonitors, type Monitor, type MonitorStatus } from "../../api/monitors";
import { Alert, EmptyState, SkeletonRows, StatusBadge } from "../../components";
import { formatSeconds, timeAgo } from "../../lib/format";
import "../pages.css";
import "./monitors.css";

const addButton = (
  <Link to="/monitors/new" className="btn btn-primary">
    <Plus size={16} aria-hidden /> Add monitor
  </Link>
);

// Down monitors first: the list is read top to bottom, and that's what needs attention.
const ORDER: Record<MonitorStatus, number> = { DOWN: 0, DEGRADED: 1, PENDING: 2, UP: 3, PAUSED: 4 };

export function MonitorListPage() {
  const monitors = useMonitors();

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Monitors</h1>
          <p>Websites, APIs and servers Lanternly checks on a schedule.</p>
        </div>
        {monitors.data && monitors.data.length > 0 && addButton}
      </header>

      {monitors.isPending && (
        <section className="card card-body">
          <SkeletonRows rows={4} height={44} />
        </section>
      )}

      {monitors.isError && (
        <Alert tone="error">
          Couldn't load your monitors.{" "}
          <button className="link-button" onClick={() => void monitors.refetch()}>
            Try again
          </button>
        </Alert>
      )}

      {monitors.data?.length === 0 && (
        <section className="card">
          <EmptyState icon={Radar} title="No monitors yet" action={addButton}>
            Add a website, API or server and Lanternly will check it straight away, then every
            minute or so.
          </EmptyState>
        </section>
      )}

      {monitors.data && monitors.data.length > 0 && (
        <>
          <Summary monitors={monitors.data} />
          <section className="card">
            <ul className="monitor-list">
              {[...monitors.data]
                .sort((a, b) => ORDER[a.status] - ORDER[b.status])
                .map((m) => (
                  <MonitorRow key={m.id} monitor={m} />
                ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

function Summary({ monitors }: { monitors: Monitor[] }) {
  const count = (status: MonitorStatus) => monitors.filter((m) => m.status === status).length;
  const down = count("DOWN");
  return (
    <p className="monitor-summary" aria-live="polite">
      {down > 0 ? (
        <strong className="summary-bad">
          {down} {down === 1 ? "monitor is" : "monitors are"} down
        </strong>
      ) : (
        <strong className="summary-good">Everything is up</strong>
      )}
      <span>
        {count("UP")} up · {count("PAUSED")} paused · {monitors.length} total
      </span>
    </p>
  );
}

function MonitorRow({ monitor: m }: { monitor: Monitor }) {
  const TypeIcon = m.type === "HTTP" ? Globe : Radio;
  return (
    <li>
      <Link to={`/monitors/${m.id}`} className="monitor-row">
        <StatusBadge status={badgeStatus(m.status)} />
        <span className="monitor-main">
          <span className="monitor-name">{m.name}</span>
          <span className="monitor-target">
            <TypeIcon size={12} aria-hidden />
            {m.target}
          </span>
        </span>
        <span className="monitor-meta">
          <span>every {formatSeconds(m.intervalSec)}</span>
          <span>{m.lastCheckedAt ? `checked ${timeAgo(m.lastCheckedAt)}` : "not checked yet"}</span>
        </span>
        <ChevronRight size={16} className="monitor-chevron" aria-hidden />
      </Link>
    </li>
  );
}
