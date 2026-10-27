// Ready-to-paste snippets for calling a heartbeat's ping URL. Each one reports the
// start (so runs are timed), the success and, if the job fails, the failure with its
// output, which ends up in the alert.

export type Example = "curl" | "crontab" | "node" | "powershell";

export const EXAMPLES: { value: Example; label: string }[] = [
  { value: "curl", label: "curl" },
  { value: "crontab", label: "crontab" },
  { value: "node", label: "Node.js" },
  { value: "powershell", label: "PowerShell" },
];

// The closest crontab line to a fixed period, for the crontab example.
function cronFor({ periodSec, cron }: { periodSec: number | null; cron: string | null }) {
  if (cron) return cron;
  const minutes = Math.max(1, Math.round((periodSec ?? 3600) / 60));
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes < 24 * 60)
    return minutes === 60 ? "0 * * * *" : `0 */${Math.round(minutes / 60)} * * *`;
  return "0 3 * * *";
}

// -f fails on an error status, -sS stays quiet unless something goes wrong, -m caps
// the wait and --retry rides out a network blip: a ping must never hang the job.
const CURL = "curl -fsS -m 10 --retry 5 -o /dev/null";

export function exampleFor(
  example: Example,
  url: string,
  schedule: { periodSec: number | null; cron: string | null },
): string {
  switch (example) {
    case "curl":
      return [
        `# When the job starts (optional: times each run)`,
        `${CURL} ${url}/start`,
        ``,
        `# When it succeeds`,
        `${CURL} ${url}`,
        ``,
        `# When it fails, with its output`,
        `${CURL} --data-raw "$output" ${url}/fail`,
      ].join("\n");
    case "crontab":
      return [
        `# m h dom mon dow  command`,
        `${cronFor(schedule)}  /path/to/job.sh && ${CURL} ${url} || ${CURL} ${url}/fail`,
      ].join("\n");
    case "node":
      return [
        `const PING_URL = "${url}";`,
        ``,
        `await fetch(\`\${PING_URL}/start\`);`,
        `try {`,
        `  await runJob();`,
        `  await fetch(PING_URL);`,
        `} catch (err) {`,
        `  await fetch(\`\${PING_URL}/fail\`, { method: "POST", body: String(err?.stack ?? err) });`,
        `  throw err;`,
        `}`,
      ].join("\n");
    case "powershell":
      return [
        `$ping = "${url}"`,
        ``,
        `Invoke-RestMethod "$ping/start" | Out-Null`,
        `try {`,
        `  & C:\\jobs\\backup.ps1`,
        `  Invoke-RestMethod $ping | Out-Null`,
        `} catch {`,
        `  Invoke-RestMethod "$ping/fail" -Method Post -Body $_.ToString() | Out-Null`,
        `  throw`,
        `}`,
      ].join("\n");
  }
}
