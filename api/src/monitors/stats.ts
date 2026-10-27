// Uptime and response-time figures, computed in Postgres. Results older than seven
// days only exist as hourly rollups, so every query reads one stream of "samples":
// raw checks (one check each) and rollup rows (an hour's worth each), weighted alike.
import { Prisma, type PrismaClient } from "@lanternly/db";

export const RANGES = {
  "1h": { ms: 60 * 60 * 1000, bucketSec: 60 },
  "24h": { ms: 24 * 60 * 60 * 1000, bucketSec: 15 * 60 },
  "7d": { ms: 7 * 24 * 60 * 60 * 1000, bucketSec: 2 * 60 * 60 },
  "30d": { ms: 30 * 24 * 60 * 60 * 1000, bucketSec: 6 * 60 * 60 },
} as const;

export type Range = keyof typeof RANGES;

// Raw checks and hourly rollups since `since`, as one weighted stream.
function samples(monitorId: string, since: Date) {
  return Prisma.sql`
    SELECT checked_at AS at,
           1 AS checks,
           (status = 'DOWN')::int AS failures,
           (response_ms IS NOT NULL)::int AS response_count,
           response_ms::float AS response_avg,
           response_ms::float AS response_p95
      FROM check_results
     WHERE monitor_id = ${monitorId}::uuid AND checked_at >= ${since}
    UNION ALL
    SELECT hour, checks, failures, response_count, response_avg_ms, response_p95_ms
      FROM check_rollups
     WHERE monitor_id = ${monitorId}::uuid AND hour >= ${since}`;
}

// Share of checks that weren't down, or null when there were no checks to judge by.
const uptime = (checks: number, failures: number) =>
  checks === 0 ? null : (checks - failures) / checks;

export async function uptimeWindows(prisma: PrismaClient, monitorId: string, now = new Date()) {
  const ago = (range: Range) => new Date(now.getTime() - RANGES[range].ms);
  const [row] = await prisma.$queryRaw<
    { c24: number; f24: number; c7: number; f7: number; c30: number; f30: number }[]
  >`
    WITH s AS (${samples(monitorId, ago("30d"))})
    SELECT coalesce(sum(checks) FILTER (WHERE at >= ${ago("24h")}), 0)::int AS c24,
           coalesce(sum(failures) FILTER (WHERE at >= ${ago("24h")}), 0)::int AS f24,
           coalesce(sum(checks) FILTER (WHERE at >= ${ago("7d")}), 0)::int AS c7,
           coalesce(sum(failures) FILTER (WHERE at >= ${ago("7d")}), 0)::int AS f7,
           coalesce(sum(checks), 0)::int AS c30,
           coalesce(sum(failures), 0)::int AS f30
      FROM s`;
  return {
    "24h": uptime(row!.c24, row!.f24),
    "7d": uptime(row!.c7, row!.f7),
    "30d": uptime(row!.c30, row!.f30),
  };
}

export interface RangeStats {
  checks: number;
  failures: number;
  uptime: number | null;
  avgMs: number | null;
  // Exact within the last seven days. Further back it is estimated from each hour's
  // own p95, weighted by how many checks that hour had: rollups can't keep every value.
  p95Ms: number | null;
  series: { at: string; checks: number; failures: number; avgMs: number | null }[];
  bucketSec: number;
  from: string;
  to: string;
}

export async function rangeStats(
  prisma: PrismaClient,
  monitorId: string,
  range: Range,
  now = new Date(),
): Promise<RangeStats> {
  const { ms, bucketSec } = RANGES[range];
  const since = new Date(now.getTime() - ms);

  const [totals] = await prisma.$queryRaw<
    { checks: number; failures: number; avg: number | null; p95: number | null }[]
  >`
    WITH s AS (${samples(monitorId, since)}),
    weighted AS (
      SELECT response_p95 AS v,
             sum(response_count) OVER (ORDER BY response_p95 ROWS UNBOUNDED PRECEDING) AS running,
             sum(response_count) OVER () AS total
        FROM s
       WHERE response_count > 0
    )
    SELECT coalesce((SELECT sum(checks) FROM s), 0)::int AS checks,
           coalesce((SELECT sum(failures) FROM s), 0)::int AS failures,
           (SELECT sum(response_avg * response_count) / nullif(sum(response_count), 0) FROM s) AS avg,
           -- Nearest rank: the smallest value with at least 95% of the weight at or below it.
           (SELECT min(v) FROM weighted WHERE running >= 0.95 * total) AS p95`;

  const buckets = await prisma.$queryRaw<
    { at: Date; checks: number; failures: number; avg: number | null }[]
  >`
    WITH s AS (${samples(monitorId, since)})
    SELECT date_bin(${`${bucketSec} seconds`}::interval, at, TIMESTAMP '2000-01-01') AS at,
           sum(checks)::int AS checks,
           sum(failures)::int AS failures,
           sum(response_avg * response_count) / nullif(sum(response_count), 0) AS avg
      FROM s
     GROUP BY 1
     ORDER BY 1`;

  // Every bucket in the range, including empty ones, so a gap in checking (a pause,
  // a worker outage) shows as a gap in the chart instead of a line drawn across it.
  const byStart = new Map(buckets.map((b) => [b.at.getTime(), b]));
  const step = bucketSec * 1000;
  const series: RangeStats["series"] = [];
  for (let t = Math.floor(since.getTime() / step) * step; t <= now.getTime(); t += step) {
    const b = byStart.get(t);
    series.push({
      at: new Date(t).toISOString(),
      checks: b?.checks ?? 0,
      failures: b?.failures ?? 0,
      avgMs: b?.avg === null || b?.avg === undefined ? null : Math.round(b.avg),
    });
  }

  return {
    checks: totals!.checks,
    failures: totals!.failures,
    uptime: uptime(totals!.checks, totals!.failures),
    avgMs: totals!.avg === null ? null : Math.round(totals!.avg),
    p95Ms: totals!.p95 === null ? null : Math.round(totals!.p95),
    series,
    bucketSec,
    from: since.toISOString(),
    to: now.toISOString(),
  };
}

// The list's 24-hour strip: one slot per hour, oldest first, for every given monitor.
export async function lastDayStrips(prisma: PrismaClient, monitorIds: string[], now = new Date()) {
  const strips = new Map<string, { checks: number; failures: number }[]>(
    monitorIds.map((id) => [id, Array.from({ length: 24 }, () => ({ checks: 0, failures: 0 }))]),
  );
  if (monitorIds.length === 0) return strips;

  const since = new Date(now.getTime() - RANGES["24h"].ms);
  const rows = await prisma.$queryRaw<
    { monitor_id: string; slot: number; checks: number; failures: number }[]
  >`
    SELECT monitor_id::text,
           -- 0 is the hour ending now, 23 the oldest.
           floor(extract(epoch FROM (${now}::timestamp - checked_at)) / 3600)::int AS slot,
           count(*)::int AS checks,
           count(*) FILTER (WHERE status = 'DOWN')::int AS failures
      FROM check_results
     WHERE monitor_id IN (${Prisma.join(monitorIds.map((id) => Prisma.sql`${id}::uuid`))})
       AND checked_at > ${since}
     GROUP BY 1, 2`;

  for (const row of rows) {
    const strip = strips.get(row.monitor_id);
    if (strip && row.slot >= 0 && row.slot < 24) {
      strip[23 - row.slot] = { checks: row.checks, failures: row.failures };
    }
  }
  return strips;
}
