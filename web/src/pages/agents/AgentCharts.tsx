import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AgentRange, AgentSample } from "../../api/agents";
import { formatBucket } from "../../lib/format";
import { METRICS } from "./metrics";

const tickFormat = (range: AgentRange) => {
  const options: Intl.DateTimeFormatOptions =
    range === "1h" || range === "24h"
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short" };
  return (iso: string) => new Date(iso).toLocaleString("en-GB", options);
};

// Long ranges are labelled by date, so a tick goes on each day's first point only;
// otherwise the same date would repeat under several points.
function dayTicks(points: AgentSample[], range: AgentRange) {
  if (range === "1h" || range === "24h") return undefined;
  const day = (iso: string) => new Date(iso).toDateString();
  return points
    .filter((p, i) => i > 0 && day(p.at) !== day(points[i - 1]?.at ?? p.at))
    .map((p) => p.at);
}

interface Props {
  points: AgentSample[];
  range: AgentRange;
  bucketSec: number;
}

// Three measures on one scale (percent used), drawn as small multiples rather than
// three lines on one plot: each panel has one series, so no legend and no colour to
// tell apart. They share the time axis, so a spike reads straight down the column.
export default function AgentCharts({ points, range, bucketSec }: Props) {
  return (
    <div className="agent-charts">
      {METRICS.map((m) => (
        <figure key={m.key} className="agent-chart">
          <figcaption className="agent-chart-title">{m.label}</figcaption>
          <div className="chart">
            <ResponsiveContainer width="100%" height={150}>
              <AreaChart
                data={points}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                syncId="agent"
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="at"
                  tickFormatter={tickFormat(range)}
                  ticks={dayTicks(points, range)}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={48}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 50, 100]}
                  tickFormatter={(v: number) => `${v}%`}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                {m.limit !== null && (
                  <ReferenceLine
                    y={m.limit}
                    className="chart-threshold"
                    label={{ value: `alert at ${m.limit}%`, position: "insideBottomRight" }}
                  />
                )}
                <Tooltip
                  content={({ active, payload }) => {
                    const p = active
                      ? (payload?.[0]?.payload as AgentSample | undefined)
                      : undefined;
                    if (!p) return null;
                    return (
                      <div className="chart-tooltip">
                        <div className="chart-tooltip-time">{formatBucket(p.at, bucketSec)}</div>
                        <div className="chart-tooltip-row">
                          <span className="chart-key" aria-hidden />
                          <strong>{p[m.key].toFixed(1)}%</strong> {m.noun} used
                          {bucketSec > 60 ? ", average" : ""}
                        </div>
                      </div>
                    );
                  }}
                  cursor={{ className: "chart-cursor" }}
                  isAnimationActive={false}
                />
                <Area
                  dataKey={m.key}
                  type="monotone"
                  className="chart-series"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, className: "chart-dot" }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </figure>
      ))}
    </div>
  );
}
