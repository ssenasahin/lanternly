import { Plus, Radar } from "lucide-react";
import { EmptyState } from "../components";
import "./pages.css";

// Lists the signed-in user's monitors. Until the monitoring engine lands there is
// nothing to fetch, so the page shows its empty state.
export function MonitorsPage() {
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Monitors</h1>
          <p>Websites, APIs and jobs Lanternly checks on a schedule.</p>
        </div>
      </header>

      <section className="card">
        <EmptyState
          icon={Radar}
          title="No monitors yet"
          action={
            <button className="btn btn-primary" disabled>
              <Plus size={16} aria-hidden /> Add monitor
            </button>
          }
        >
          Add a website, API or cron job and Lanternly will start checking it within a minute.
        </EmptyState>
      </section>
    </>
  );
}
