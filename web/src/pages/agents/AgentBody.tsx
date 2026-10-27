import { useMutation } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import {
  useAgent,
  useAgentMetrics,
  type Agent,
  type AgentRange,
  type AgentSample,
  type IssuedKey,
} from "../../api/agents";
import { api } from "../../api/client";
import type { Monitor } from "../../api/monitors";
import { Alert, Segmented, Skeleton, SkeletonRows } from "../../components";
import { formatBucket, formatTime, timeAgo } from "../../lib/format";
import { MonitorIncidents } from "../monitors/MonitorStats";
import { Fact } from "../monitors/parts";
import { InstallSteps } from "./InstallSteps";
import { BUCKET_SEC, METRICS } from "./metrics";
import "../settings/settings.css";
import "./agents.css";

// Recharts loads only when a chart is shown, as on the other monitor pages.
const AgentCharts = lazy(() => import("./AgentCharts"));

const RANGES = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
] as const;

type View = "chart" | "table";
const VIEWS = [
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
] as const;

// A server agent's page: what it uses now, how that moved over time, and its key.
export function AgentBody({ monitor }: { monitor: Monitor }) {
  const agent = useAgent(monitor.id);
  const [issued, setIssued] = useState<IssuedKey | null>(null);

  if (agent.isPending) return <SkeletonRows rows={3} height={88} />;
  if (agent.isError) return <Alert tone="error">Couldn't load this server's reports.</Alert>;

  const a = agent.data;
  return (
    <>
      {issued && <InstallSteps issued={issued} onDone={() => setIssued(null)} />}
      {!a.lastSeenAt && !issued && (
        <Alert tone="info">
          Waiting for the agent's first report. Lost the key or the command? Replace the key below
          for a fresh one.
        </Alert>
      )}

      {a.latest && <Gauges latest={a.latest} now={agent.dataUpdatedAt} />}
      {a.lastSeenAt && <Usage id={monitor.id} />}
      <MonitorIncidents monitorId={monitor.id} />

      <dl className="card card-body facts">
        <Fact label="Host">
          <span className="mono">{a.hostname ?? "Not reported yet"}</span>
        </Fact>
        <Fact label="System">{a.platform ?? "Not reported yet"}</Fact>
        <Fact label="Last report">
          {a.lastSeenAt ? (
            <span title={formatTime(a.lastSeenAt)}>{timeAgo(a.lastSeenAt)}</span>
          ) : (
            "None yet"
          )}
        </Fact>
        <Fact label="Escalation">{monitor.escalationPolicy?.name ?? "None: everyone at once"}</Fact>
      </dl>

      <KeyCard agent={a} onIssued={setIssued} />
    </>
  );
}

// The latest report as three meters. Over the alert level, the meter turns red
// and says so in words, so the colour is never the only sign.
function Gauges({ latest, now }: { latest: AgentSample; now: number }) {
  // Reports come every minute; anything older means these numbers may be stale.
  const stale = now - Date.parse(latest.at) > 2 * 60_000;
  return (
    <section aria-label={`Use at ${formatTime(latest.at)}`}>
      {stale && (
        <p className="muted gauges-when">As of the last report, {timeAgo(latest.at, now)}</p>
      )}
      <div className="tiles">
        {METRICS.map((m) => {
          const value = latest[m.key];
          const over = m.limit !== null && value > m.limit;
          return (
            <div key={m.key} className="tile">
              <div className="tile-label">{m.label}</div>
              <div className="tile-value">{Math.round(value)}%</div>
              <div
                className={`meter${over ? " meter-over" : ""}`}
                role="meter"
                aria-label={`${m.label} used`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(value)}
              >
                <span style={{ width: `${Math.min(100, value)}%` }} />
              </div>
              <div className="tile-note">
                {over
                  ? `Over the ${m.limit}% alert level`
                  : m.limit
                    ? `Alert at ${m.limit}%`
                    : "No alert"}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Usage({ id }: { id: string }) {
  const [range, setRange] = useState<AgentRange>("24h");
  const [view, setView] = useState<View>("chart");
  const metrics = useAgentMetrics(id, range);
  const bucketSec = BUCKET_SEC[range];

  return (
    <>
      <div className="filter-row">
        <span className="filter-label">Use over</span>
        <Segmented label="Time range" options={RANGES} value={range} onChange={setRange} small />
      </div>
      <section className={`card${metrics.isPlaceholderData ? " is-refreshing" : ""}`}>
        <div className="card-head">
          <h2 className="section-title">Percent used</h2>
          <Segmented label="Show as" options={VIEWS} value={view} onChange={setView} small />
        </div>
        <div className="card-body">
          {metrics.isPending && <Skeleton height={480} />}
          {metrics.isError && <Alert tone="error">Couldn't load the history.</Alert>}
          {metrics.data?.length === 0 && <p className="muted">No reports in this range.</p>}
          {metrics.data && metrics.data.length > 0 && view === "chart" && (
            <Suspense fallback={<Skeleton height={480} />}>
              <AgentCharts points={metrics.data} range={range} bucketSec={bucketSec} />
            </Suspense>
          )}
          {metrics.data && metrics.data.length > 0 && view === "table" && (
            <div className="table-scroll chart-table">
              <table className="checks">
                <thead>
                  <tr>
                    <th>Time</th>
                    {METRICS.map((m) => (
                      <th key={m.key} className="num">
                        {m.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...metrics.data].reverse().map((p) => (
                    <tr key={p.at}>
                      <td className="mono">{formatBucket(p.at, bucketSec)}</td>
                      {METRICS.map((m) => (
                        <td key={m.key} className="num mono">
                          {p[m.key].toFixed(1)}%
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function KeyCard({ agent, onIssued }: { agent: Agent; onIssued: (k: IssuedKey) => void }) {
  const [confirming, setConfirming] = useState(false);
  const rotate = useMutation({
    mutationFn: () => api<IssuedKey>(`/agents/${agent.monitorId}/key`, { method: "POST" }),
    onSuccess: (issued) => {
      setConfirming(false);
      onIssued(issued);
    },
  });

  return (
    <section className="card card-body">
      <div className="security-row">
        <span className="security-icon">
          <KeyRound size={20} aria-hidden />
        </span>
        <div>
          <h2 className="security-title">Agent key</h2>
          <p className="muted">
            Starts with <code className="mono">{agent.keyPrefix}</code>. Replace it if it leaked or
            you lost it; the agent running with the old key stops being accepted at once.
          </p>
          {rotate.error && <Alert tone="error">{rotate.error.message}</Alert>}
          <div className="row agent-key-actions">
            {confirming ? (
              <>
                <span>Replace the key now?</span>
                <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => rotate.mutate()}
                  disabled={rotate.isPending}
                >
                  {rotate.isPending ? "Replacing…" : "Replace key"}
                </button>
              </>
            ) : (
              <button className="btn" onClick={() => setConfirming(true)}>
                Replace key
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
