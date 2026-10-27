import { CircleCheck } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router";
import { RANGES, useIncidents, useStats, type Range, type Stats } from "../../api/monitors";
import { Alert, EmptyState, Segmented, Skeleton, SkeletonRows } from "../../components";
import {
  formatBucket,
  formatDuration,
  formatMs,
  formatPercent,
  formatTime,
} from "../../lib/format";

// Recharts is most of the app's JavaScript, so it loads only when a chart is shown.
const ResponseChart = lazy(() => import("./ResponseChart"));

const RANGE_OPTIONS = RANGES.map((r) => ({ value: r, label: r }));
const RANGE_WORDS: Record<Range, string> = {
  "1h": "the last hour",
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
};

// Uptime for the standard windows, then everything scoped by the range picker below
// it: the picker sits in one row above what it controls, and nothing above it moves.
export function MonitorStats({ monitorId }: { monitorId: string }) {
  const [range, setRange] = useState<Range>("24h");
  const stats = useStats(monitorId, range);

  if (stats.isPending) return <SkeletonRows rows={3} height={88} />;
  if (stats.isError) {
    return (
      <Alert tone="error">
        Couldn't load the statistics.{" "}
        <button className="link-button" onClick={() => void stats.refetch()}>
          Try again
        </button>
      </Alert>
    );
  }

  const s = stats.data;
  return (
    <>
      <section aria-label="Uptime">
        <div className="tiles">
          <Tile label="Uptime, 24 hours" value={formatPercent(s.windows["24h"])} />
          <Tile label="Uptime, 7 days" value={formatPercent(s.windows["7d"])} />
          <Tile label="Uptime, 30 days" value={formatPercent(s.windows["30d"])} />
        </div>
      </section>

      <div className="filter-row">
        <span className="filter-label">Response times over</span>
        <Segmented
          label="Time range"
          options={RANGE_OPTIONS}
          value={range}
          onChange={setRange}
          small
        />
      </div>

      <div className={`stack${stats.isPlaceholderData ? " is-refreshing" : ""}`}>
        <div className="tiles">
          <Tile label="Average response" value={formatMs(s.avgMs)} />
          <Tile
            label="95th percentile"
            value={formatMs(s.p95Ms)}
            note="95% of checks were at least this fast"
          />
          <Tile
            label="Checks"
            value={s.checks.toLocaleString("en-GB")}
            note={s.failures ? `${s.failures} down` : "none down"}
          />
        </div>
        <ResponseCard stats={s} />
      </div>
    </>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

type View = "chart" | "table";
const VIEWS = [
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
] as const;

// The chart, with the same numbers available as a table for anyone who can't (or
// would rather not) read them off a line.
function ResponseCard({ stats }: { stats: Stats }) {
  const [view, setView] = useState<View>("chart");
  const hasData = stats.series.some((b) => b.checks > 0);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Average response time, {RANGE_WORDS[stats.range]}</h2>
        {hasData && (
          <Segmented label="Show as" options={VIEWS} value={view} onChange={setView} small />
        )}
      </div>
      {!hasData ? (
        <EmptyState icon={CircleCheck} title="No checks in this range">
          Pick a longer range, or wait for the next check. This page refreshes on its own.
        </EmptyState>
      ) : view === "chart" ? (
        <div className="card-body">
          <Suspense fallback={<Skeleton height={240} />}>
            <ResponseChart series={stats.series} range={stats.range} bucketSec={stats.bucketSec} />
          </Suspense>
        </div>
      ) : (
        <div className="table-scroll chart-table">
          <table className="checks">
            <thead>
              <tr>
                <th>Period</th>
                <th className="num">Average</th>
                <th className="num">Checks</th>
                <th className="num">Down</th>
              </tr>
            </thead>
            <tbody>
              {[...stats.series]
                .filter((b) => b.checks > 0)
                .reverse()
                .map((b) => (
                  <tr key={b.at}>
                    <td className="mono">{formatBucket(b.at, stats.bucketSec)}</td>
                    <td className="num mono">{formatMs(b.avgMs)}</td>
                    <td className="num mono">{b.checks}</td>
                    <td className="num mono">{b.failures || "–"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function MonitorIncidents({ monitorId }: { monitorId: string }) {
  const incidents = useIncidents("all", monitorId);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Recent incidents</h2>
        <Link to="/incidents" className="link-button">
          All incidents
        </Link>
      </div>
      {incidents.isPending && (
        <div className="card-body">
          <SkeletonRows rows={2} height={28} />
        </div>
      )}
      {incidents.isError && (
        <div className="card-body">
          <Alert tone="error">Couldn't load the incidents.</Alert>
        </div>
      )}
      {incidents.data?.length === 0 && (
        <EmptyState icon={CircleCheck} title="No incidents">
          When a check fails and its retries fail too, the outage shows up here and you get an
          email.
        </EmptyState>
      )}
      {incidents.data && incidents.data.length > 0 && (
        <div className="table-scroll">
          <table className="checks">
            <thead>
              <tr>
                <th>Started</th>
                <th>Lasted</th>
                <th>Cause</th>
              </tr>
            </thead>
            <tbody>
              {incidents.data.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{formatTime(i.startedAt)}</td>
                  <td>
                    {i.resolvedAt ? (
                      formatDuration(Date.parse(i.resolvedAt) - Date.parse(i.startedAt))
                    ) : (
                      <span className="chart-tooltip-bad">
                        ongoing, {formatDuration(incidents.dataUpdatedAt - Date.parse(i.startedAt))}
                      </span>
                    )}
                  </td>
                  <td className="check-error">{i.cause ?? "No response"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
