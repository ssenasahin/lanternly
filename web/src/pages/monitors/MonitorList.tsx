import {
  Braces,
  ChevronRight,
  Globe,
  HeartPulse,
  Network,
  Plug,
  Plus,
  Radar,
  Radio,
  Search,
  SearchX,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import {
  badgeStatus,
  useMonitors,
  type HourSlot,
  type ListedMonitor,
  type MonitorStatus,
} from "../../api/monitors";
import {
  Alert,
  EmptyState,
  Segmented,
  SelectField,
  SkeletonRows,
  StatusBadge,
  UptimeStrip,
  type StripSlot,
} from "../../components";
import { describeSchedule, formatPercent, formatSeconds, timeAgo } from "../../lib/format";
import "../pages.css";
import "./monitors.css";

const addButtons = (
  <div className="row">
    <Link to="/heartbeats/new" className="btn">
      <HeartPulse size={16} aria-hidden /> Add heartbeat
    </Link>
    <Link to="/monitors/new" className="btn btn-primary">
      <Plus size={16} aria-hidden /> Add monitor
    </Link>
  </div>
);

type Filter = "all" | "down" | "up" | "paused";
const FILTERS = [
  { value: "all", label: "All" },
  { value: "down", label: "Down" },
  { value: "up", label: "Up" },
  { value: "paused", label: "Paused" },
] as const;

const MATCHES: Record<Filter, (s: MonitorStatus) => boolean> = {
  all: () => true,
  down: (s) => s === "DOWN" || s === "DEGRADED",
  up: (s) => s === "UP",
  paused: (s) => s === "PAUSED",
};

type Sort = "status" | "name" | "uptime";
// Down first: the list is read top to bottom, and that's what needs attention.
const STATUS_ORDER: Record<MonitorStatus, number> = {
  DOWN: 0,
  DEGRADED: 1,
  PENDING: 2,
  UP: 3,
  PAUSED: 4,
};

function dayUptime(slots: HourSlot[]): number | null {
  const checks = slots.reduce((n, s) => n + s.checks, 0);
  const failures = slots.reduce((n, s) => n + s.failures, 0);
  return checks === 0 ? null : (checks - failures) / checks;
}

const SORTS: Record<Sort, (a: ListedMonitor, b: ListedMonitor) => number> = {
  status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  // Lowest first; monitors with no checks yet go last.
  uptime: (a, b) => (dayUptime(a.lastDay) ?? 2) - (dayUptime(b.lastDay) ?? 2),
};

export function MonitorListPage() {
  const monitors = useMonitors();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("status");

  const all = monitors.data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = all
    .filter((m) => MATCHES[filter](m.status))
    .filter((m) => !needle || `${m.name} ${subtitle(m)}`.toLowerCase().includes(needle))
    .sort(SORTS[sort]);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Monitors</h1>
          <p>Websites, APIs and servers Lanternly checks on a schedule.</p>
        </div>
        {all.length > 0 && addButtons}
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
          <EmptyState icon={Radar} title="No monitors yet" action={addButtons}>
            Add a website, API or server and Lanternly will check it straight away, then every
            minute or so. Or add a heartbeat, and your cron job tells Lanternly each time it runs.
          </EmptyState>
        </section>
      )}

      {all.length > 0 && (
        <>
          <Summary monitors={all} />
          <div className="list-controls">
            <label className="search">
              <Search size={15} aria-hidden />
              <input
                type="search"
                className="input"
                placeholder="Search by name or address"
                aria-label="Search monitors"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <Segmented label="Show" options={FILTERS} value={filter} onChange={setFilter} />
            <SelectField
              label="Sort by"
              className="sort-select"
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
            >
              <option value="status">Status</option>
              <option value="name">Name</option>
              <option value="uptime">Uptime, lowest first</option>
            </SelectField>
          </div>

          <section className="card">
            {shown.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="Nothing matches"
                action={
                  <button
                    className="btn"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Clear filters
                  </button>
                }
              >
                No monitor fits both the search and the filter.
              </EmptyState>
            ) : (
              <ul className="monitor-list">
                {shown.map((m) => (
                  <MonitorRow key={m.id} monitor={m} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Summary({ monitors }: { monitors: ListedMonitor[] }) {
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

// Labels each hour of the strip with its clock time, for the tooltips.
function hourSlots(slots: HourSlot[]): StripSlot[] {
  const hour = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const end = Date.now();
  return slots.map((s, i) => {
    const to = new Date(end - (slots.length - 1 - i) * 3_600_000);
    const from = new Date(to.getTime() - 3_600_000);
    return { ...s, label: `${hour(from)}–${hour(to)}` };
  });
}

// The second line of a row: what is checked, or what a heartbeat expects.
function subtitle(m: ListedMonitor): string {
  if (m.heartbeat) return `heartbeat, ${describeSchedule(m.heartbeat)}`;
  if (m.dns) return `${m.dns.recordType} ${m.target}`;
  return m.api ? `${m.api.method} ${m.target}` : m.target;
}

const TYPE_ICONS = {
  HTTP: Globe,
  API: Braces,
  PING: Radio,
  TCP: Plug,
  DNS: Network,
  HEARTBEAT: HeartPulse,
};

function MonitorRow({ monitor: m }: { monitor: ListedMonitor }) {
  const TypeIcon = TYPE_ICONS[m.type];
  const lastPing = m.heartbeat?.lastPingAt;
  const uptime = dayUptime(m.lastDay);
  return (
    <li>
      <Link to={`/monitors/${m.id}`} className="monitor-row">
        <StatusBadge status={badgeStatus(m.status)} />
        <span className="monitor-main">
          <span className="monitor-name">{m.name}</span>
          <span className="monitor-target">
            <TypeIcon size={12} aria-hidden />
            {subtitle(m)}
          </span>
        </span>
        <span className="monitor-day">
          <UptimeStrip
            slots={hourSlots(m.lastDay)}
            label={`Last 24 hours: ${formatPercent(uptime)} uptime`}
          />
          <span className="monitor-uptime">{formatPercent(uptime)}</span>
        </span>
        <span className="monitor-meta">
          {m.heartbeat ? (
            <>
              <span>grace {formatSeconds(m.heartbeat.graceSec)}</span>
              <span>{lastPing ? `pinged ${timeAgo(lastPing)}` : "no ping yet"}</span>
            </>
          ) : (
            <>
              <span>every {formatSeconds(m.intervalSec)}</span>
              <span>
                {m.lastCheckedAt ? `checked ${timeAgo(m.lastCheckedAt)}` : "not checked yet"}
              </span>
            </>
          )}
        </span>
        <ChevronRight size={16} className="monitor-chevron" aria-hidden />
      </Link>
    </li>
  );
}
