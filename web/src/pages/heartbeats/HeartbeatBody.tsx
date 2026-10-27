import { Send } from "lucide-react";
import { useState } from "react";
import {
  useHeartbeat,
  usePings,
  type Heartbeat,
  type Ping,
  type PingKind,
} from "../../api/heartbeats";
import type { Range } from "../../api/monitors";
import {
  Alert,
  CopyButton,
  EmptyState,
  Segmented,
  SkeletonRows,
  StatusBadge,
  type Status,
} from "../../components";
import { describeSchedule, formatMs, formatPeriod, formatTime, timeAgo } from "../../lib/format";
import { MonitorIncidents, MonitorStats } from "../monitors/MonitorStats";
import { Fact } from "../monitors/parts";
import { EXAMPLES, exampleFor, type Example } from "./examples";
import "./heartbeats.css";

// The rest of a heartbeat's page, below the shared header and alerts: how to ping it,
// how its runs went, and what each ping carried.
export function HeartbeatBody({ id }: { id: string }) {
  const detail = useHeartbeat(id);

  if (detail.isPending) return <SkeletonRows rows={3} height={88} />;
  if (detail.isError) {
    return (
      <Alert tone="error">
        Couldn't load this heartbeat.{" "}
        <button className="link-button" onClick={() => void detail.refetch()}>
          Try again
        </button>
      </Alert>
    );
  }

  const { heartbeat } = detail.data;
  return (
    <>
      <PingSetup heartbeat={heartbeat} />
      <MonitorStats monitorId={id} measure="run" defaultRange={rangeFor(heartbeat)} />
      <MonitorIncidents monitorId={id} />
      <dl className="card card-body facts">
        <Fact label="Expects a ping">
          {heartbeat.cron ? (
            <>
              <span className="mono">{heartbeat.cron}</span>
              <span className="fact-note">{heartbeat.timezone}</span>
            </>
          ) : (
            describeSchedule(heartbeat)
          )}
        </Fact>
        <Fact label="Grace period">{formatPeriod(heartbeat.graceSec)}</Fact>
        <Fact label="Last ping">
          {heartbeat.lastPingAt ? timeAgo(heartbeat.lastPingAt) : "Never"}
        </Fact>
        <Fact label="Next ping due">
          <NextPing heartbeat={heartbeat} now={detail.dataUpdatedAt} />
        </Fact>
      </dl>
      <RecentPings id={id} />
    </>
  );
}

// Enough runs to draw a line: a week of an hourly job, a month of a daily one.
function rangeFor({ periodSec, cron }: Heartbeat): Range {
  if (cron || (periodSec ?? 0) >= 6 * 3600) return "30d";
  return (periodSec ?? 0) >= 600 ? "7d" : "24h";
}

// "in 12 hours", or, once the time has passed, that it's late.
function NextPing({ heartbeat, now }: { heartbeat: Heartbeat; now: number }) {
  if (!heartbeat.expectedAt) return <>After the first one</>;
  if (Date.parse(heartbeat.expectedAt) > now) return <>{timeAgo(heartbeat.expectedAt, now)}</>;
  return (
    <span className="chart-tooltip-bad">Overdue, was due {timeAgo(heartbeat.expectedAt, now)}</span>
  );
}

function PingSetup({ heartbeat }: { heartbeat: Heartbeat }) {
  const [example, setExample] = useState<Example>("curl");
  const code = exampleFor(example, heartbeat.pingUrl, heartbeat);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Ping URL</h2>
      </div>
      <div className="card-body ping-setup">
        <div className="ping-url">
          <code>{heartbeat.pingUrl}</code>
          <CopyButton text={heartbeat.pingUrl} />
        </div>
        <p className="field-hint">
          Call it when the job finishes, with GET or POST. Add <code>/start</code> when it begins to
          time every run, or <code>/fail</code> to report a failure straight away. Anyone who has
          this URL can ping it, so keep it out of public code.
        </p>
        <div className="example-head">
          <Segmented
            label="Example"
            options={EXAMPLES}
            value={example}
            onChange={setExample}
            small
          />
          <CopyButton text={code} />
        </div>
        <pre className="code-block">
          <code>{code}</code>
        </pre>
      </div>
    </section>
  );
}

const PING_BADGE: Record<PingKind, { status: Status; label: string }> = {
  SUCCESS: { status: "up", label: "Success" },
  START: { status: "pending", label: "Started" },
  FAIL: { status: "down", label: "Failed" },
};

function RecentPings({ id }: { id: string }) {
  const pings = usePings(id);

  return (
    <section className="card">
      <div className="card-body checks-head">
        <h2 className="section-title">Recent pings</h2>
      </div>
      {pings.isPending && (
        <div className="card-body">
          <SkeletonRows rows={5} height={28} />
        </div>
      )}
      {pings.isError && (
        <div className="card-body">
          <Alert tone="error">Couldn't load the pings.</Alert>
        </div>
      )}
      {pings.data?.length === 0 && (
        <EmptyState icon={Send} title="No pings yet">
          Run the job, or paste the curl line above into a terminal to see one arrive. This page
          refreshes on its own.
        </EmptyState>
      )}
      {pings.data && pings.data.length > 0 && (
        <div className="table-scroll">
          <table className="checks pings">
            <thead>
              <tr>
                <th>Time</th>
                <th>Ping</th>
                <th className="num">Run time</th>
                <th>From</th>
                <th>Output</th>
              </tr>
            </thead>
            <tbody>
              {pings.data.map((p) => (
                <PingRow key={p.id} ping={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PingRow({ ping }: { ping: Ping }) {
  const badge = PING_BADGE[ping.kind];
  return (
    <tr>
      <td className="mono">{formatTime(ping.receivedAt)}</td>
      <td>
        <StatusBadge status={badge.status} label={badge.label} />
      </td>
      <td className="num mono">{ping.durationMs === null ? "–" : formatMs(ping.durationMs)}</td>
      <td>
        <div className="mono">{ping.ip ?? "–"}</div>
        {ping.userAgent && <div className="ping-agent">{ping.userAgent}</div>}
      </td>
      <td className="ping-output">
        {ping.body ? (
          <details>
            <summary>{ping.body.length.toLocaleString("en-GB")} characters</summary>
            <pre className="code-block">{ping.body}</pre>
          </details>
        ) : (
          <span className="muted">–</span>
        )}
      </td>
    </tr>
  );
}
