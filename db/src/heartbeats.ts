// When a heartbeat's next ping is due. The API uses this to validate schedules and show
// "next expected", the worker to decide a job has gone quiet; sharing it means the two
// can never disagree about whether a ping is late.
import { CronExpressionParser } from "cron-parser";

export interface HeartbeatSchedule {
  // Exactly one of periodSec and cron is set.
  periodSec: number | null;
  cron: string | null;
  timezone: string;
  graceSec: number;
}

// A job that pings a little before its cron time (clock drift, a fast run) still
// belongs to that run, not to the one before it. Without this, a ping at 02:59:58 for
// a 03:00 job would make 03:00 the next due time, two seconds later.
const EARLY_PING_ALLOWANCE_MS = 60_000;

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Why a cron expression can't be used, in words for the form, or null if it's fine.
// Only the classic five fields: crontab has no seconds, and a job that pings every few
// seconds is better watched by an HTTP monitor.
export function cronProblem(expression: string, timezone: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return "Use five fields: minute, hour, day of month, month and day of week";
  }
  if (!isTimeZone(timezone)) return "Unknown time zone";
  try {
    CronExpressionParser.parse(fields.join(" "), { tz: timezone });
    return null;
  } catch (err) {
    return `Not a valid cron expression: ${(err as Error).message}`;
  }
}

// The next `count` times a cron expression fires after `from`.
export function nextRuns(expression: string, timezone: string, from: Date, count: number): Date[] {
  const runs = CronExpressionParser.parse(expression, { tz: timezone, currentDate: from });
  return runs.take(count).map((d) => d.toDate());
}

// When the ping after `lastPingAt` should arrive, before any grace period.
export function expectedBy(schedule: HeartbeatSchedule, lastPingAt: Date): Date {
  if (schedule.periodSec !== null) {
    return new Date(lastPingAt.getTime() + schedule.periodSec * 1000);
  }
  // A ping can be early by the allowance, but not by the whole grace period: with a
  // five-minute job and a ten-minute grace, that would skip a run.
  const allowance = Math.min(EARLY_PING_ALLOWANCE_MS, schedule.graceSec * 1000);
  const [next] = nextRuns(
    schedule.cron!,
    schedule.timezone,
    new Date(lastPingAt.getTime() + allowance),
    1,
  );
  return next!;
}

// The moment the job counts as down if no ping has come.
export function lateAfter(schedule: HeartbeatSchedule, lastPingAt: Date): Date {
  return new Date(expectedBy(schedule, lastPingAt).getTime() + schedule.graceSec * 1000);
}
