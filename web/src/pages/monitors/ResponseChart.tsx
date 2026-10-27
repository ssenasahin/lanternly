import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Bucket, Range } from "../../api/monitors";
import { formatBucket, formatMs } from "../../lib/format";

// Short ticks for short ranges, dates for long ones.
function tickFormat(range: Range) {
  const options: Intl.DateTimeFormatOptions =
    range === "1h" || range === "24h"
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short" };
  return (iso: string) => new Date(iso).toLocaleString("en-GB", options);
}

// Long ranges are labelled by date, so a tick goes on each day's first bucket only;
// otherwise the same date would repeat under several buckets. Short ranges let
// Recharts space the clock times out itself.
function dayTicks(series: Bucket[], range: Range) {
  if (range === "1h" || range === "24h") return undefined;
  const day = (iso: string) => new Date(iso).toDateString();
  return series
    .filter((b, i) => i > 0 && day(b.at) !== day(series[i - 1]?.at ?? b.at))
    .map((b) => b.at);
}

// Recharts picks round numbers of milliseconds, which in minutes read as 2.333… For
// runs of a minute or more, ticks land on whole minutes instead.
const MINUTE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240];
function minuteTicks(series: Bucket[]) {
  const max = Math.max(0, ...series.map((b) => b.avgMs ?? 0));
  if (max < 60_000) return undefined;
  const minutes = max / 60_000;
  const step = MINUTE_STEPS.find((s) => s * 4 >= minutes) ?? MINUTE_STEPS.at(-1)!;
  const count = Math.ceil(minutes / step);
  return Array.from({ length: count + 1 }, (_, i) => i * step * 60_000);
}

const msTick = (ms: number) =>
  ms >= 60_000 ? `${ms / 60_000} min` : ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`;

// Consecutive buckets with a failed check, merged into one shaded span each.
function outageSpans(series: Bucket[], bucketSec: number) {
  const spans: { from: string; to: string }[] = [];
  for (const b of series) {
    if (b.failures === 0) continue;
    const end = new Date(new Date(b.at).getTime() + bucketSec * 1000).toISOString();
    const last = spans.at(-1);
    if (last && last.to === b.at) last.to = end;
    else spans.push({ from: b.at, to: end });
  }
  return spans;
}

interface Props {
  series: Bucket[];
  range: Range;
  bucketSec: number;
  // What each result is, for the tooltip: "3 checks" or "3 runs".
  noun?: string;
  // Draw the line across empty buckets. Right for a job that runs now and then, where
  // a bucket without a run is normal; wrong for checks, where a gap means no data.
  sparse?: boolean;
}

// Average response time over the range, one series, so no legend: the card's title
// names it. Spans with a failed check are shaded, and the tooltip says how many.
export default function ResponseChart({
  series,
  range,
  bucketSec,
  noun = "check",
  sparse = false,
}: Props) {
  const yTicks = minuteTicks(series);
  // The last bucket's x is its start; spans may end after it, so clamp them.
  const lastAt = series.at(-1)?.at;
  const spans = outageSpans(series, bucketSec).map((s) => ({
    from: s.from,
    to: lastAt && s.to > lastAt ? lastAt : s.to,
  }));

  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="at"
            tickFormatter={tickFormat(range)}
            ticks={dayTicks(series, range)}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            tickFormatter={msTick}
            ticks={yTicks}
            domain={yTicks ? [0, yTicks.at(-1)!] : undefined}
            tickLine={false}
            axisLine={false}
            width={56}
          />
          {spans.map((s) => (
            <ReferenceArea
              key={s.from}
              x1={s.from}
              x2={s.to}
              className="chart-outage"
              ifOverflow="extendDomain"
            />
          ))}
          <Tooltip
            content={({ active, payload }) => (
              <ChartTooltip
                bucket={active ? (payload?.[0]?.payload as Bucket | undefined) : undefined}
                bucketSec={bucketSec}
                noun={noun}
              />
            )}
            cursor={{ className: "chart-cursor" }}
            isAnimationActive={false}
          />
          <Area
            dataKey="avgMs"
            type="monotone"
            className="chart-series"
            strokeWidth={2}
            connectNulls={sparse}
            // With runs far apart, each one gets a dot, so a single run still shows.
            dot={sparse ? { r: 2.5, className: "chart-dot" } : false}
            isAnimationActive={false}
            activeDot={{ r: 4, className: "chart-dot" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartTooltip({
  bucket,
  bucketSec,
  noun,
}: {
  bucket?: Bucket;
  bucketSec: number;
  noun: string;
}) {
  if (!bucket) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-time">{formatBucket(bucket.at, bucketSec)}</div>
      {bucket.checks === 0 ? (
        <div className="chart-tooltip-row">No {noun}s</div>
      ) : (
        <>
          <div className="chart-tooltip-row">
            <span className="chart-key" aria-hidden />
            <strong>{formatMs(bucket.avgMs)}</strong> average
          </div>
          <div className="chart-tooltip-row muted">
            {bucket.checks} {bucket.checks === 1 ? noun : `${noun}s`}
            {bucket.failures > 0 && (
              <>
                , <span className="chart-tooltip-bad">{bucket.failures} down</span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
