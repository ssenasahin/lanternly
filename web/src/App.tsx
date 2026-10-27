import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import "./App.css";

interface Health {
  status: "ok" | "degraded";
  database: "up" | "down";
  latencyMs: number;
}

async function fetchHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  // A 503 still carries a useful body, so only treat missing JSON as a failure.
  const body = (await res.json()) as Health;
  return body;
}

export function App() {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: 30_000 });

  return (
    <main className="splash">
      <h1>Lanternly</h1>
      <p className="muted">Uptime monitoring for the jobs nobody watches.</p>

      <div className="splash-status" role="status">
        {health.isPending && (
          <>
            <LoaderCircle size={16} className="spin" aria-hidden /> Checking the API…
          </>
        )}
        {health.isError && (
          <>
            <CircleX size={16} className="bad" aria-hidden /> API unreachable. Is{" "}
            <code>npm run dev</code> running?
          </>
        )}
        {health.data && health.data.status === "ok" && (
          <>
            <CircleCheck size={16} className="good" aria-hidden /> API operational ·{" "}
            <span className="mono">{health.data.latencyMs} ms</span>
          </>
        )}
        {health.data && health.data.status !== "ok" && (
          <>
            <CircleX size={16} className="bad" aria-hidden /> API up, database down
          </>
        )}
      </div>
    </main>
  );
}
