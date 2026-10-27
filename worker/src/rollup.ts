import type { PrismaClient } from "@lanternly/db";

export const RAW_RETENTION_DAYS = 7;

// The start of the hour, seven days ago. Cutting on an hour boundary means an hour is
// always summarised whole, never half in raw rows and half in a rollup.
export function rollupCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  cutoff.setUTCMinutes(0, 0, 0);
  return cutoff;
}

// Moves raw results older than the cutoff into hourly rollups. It's one statement:
// the DELETE hands its rows to the INSERT, so a crash can't lose results or count
// them twice. Running it again finds nothing left to move.
export async function rollUpOldChecks(prisma: PrismaClient, now = new Date()) {
  const cutoff = rollupCutoff(now);
  const moved = await prisma.$executeRaw`
    WITH moved AS (
      DELETE FROM check_results
       WHERE checked_at < ${cutoff}
      RETURNING monitor_id, checked_at, status, response_ms
    )
    INSERT INTO check_rollups
      (monitor_id, hour, checks, failures, response_count, response_avg_ms, response_p95_ms)
    SELECT monitor_id,
           date_trunc('hour', checked_at),
           count(*),
           count(*) FILTER (WHERE status = 'DOWN'),
           count(response_ms),
           avg(response_ms),
           percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms)
      FROM moved
     GROUP BY 1, 2
    -- Only possible if results for an already rolled-up hour arrive late: merge them.
    ON CONFLICT (monitor_id, hour) DO UPDATE SET
      checks = check_rollups.checks + EXCLUDED.checks,
      failures = check_rollups.failures + EXCLUDED.failures,
      response_avg_ms = (
        coalesce(check_rollups.response_avg_ms * check_rollups.response_count, 0) +
        coalesce(EXCLUDED.response_avg_ms * EXCLUDED.response_count, 0)
      ) / nullif(check_rollups.response_count + EXCLUDED.response_count, 0),
      response_count = check_rollups.response_count + EXCLUDED.response_count,
      response_p95_ms = greatest(check_rollups.response_p95_ms, EXCLUDED.response_p95_ms)`;
  return { cutoff, hours: moved };
}
