import { Siren } from "lucide-react";
import { EmptyState } from "../components";
import "./pages.css";

export function IncidentsPage() {
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Incidents</h1>
          <p>Every outage, when it started, how long it lasted and why.</p>
        </div>
      </header>

      <section className="card">
        <EmptyState icon={Siren} title="No incidents">
          When a monitor goes down, Lanternly opens an incident here and closes it when the monitor
          recovers.
        </EmptyState>
      </section>
    </>
  );
}
