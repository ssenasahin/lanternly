import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { IssuedKey } from "../../api/agents";
import { ApiError, api } from "../../api/client";
import { monitorKeys } from "../../api/monitors";
import { Alert, TextField } from "../../components";
import { InstallSteps } from "./InstallSteps";
import "../pages.css";
import "../monitors/monitors.css";

// Adding a server is two steps: name it here, then start the agent with the key the
// API hands back. The key appears once, so the page stays on it until it's saved.
export function AgentNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api<IssuedKey & { id: string }>("/agents", { method: "POST", body: { name } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: monitorKeys.all }),
  });
  const error = create.error instanceof ApiError ? create.error : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <>
      <header className="page-header">
        <div>
          <Link to="/" className="back-link">
            <ArrowLeft size={14} aria-hidden /> Monitors
          </Link>
          <h1>Add server</h1>
          <p>
            A small agent on the server reports its CPU, memory and disk use. You're alerted when
            the CPU stays over 90% for 5 minutes, a disk passes 90%, or the reports stop.
          </p>
        </div>
      </header>

      {create.data ? (
        <div className="form-card">
          <InstallSteps
            issued={create.data}
            onDone={() => navigate(`/monitors/${create.data.id}`)}
          />
        </div>
      ) : (
        <form className="card form-card" onSubmit={submit} noValidate>
          <div className="card-body form-section">
            {error && !error.fieldError("name") && <Alert tone="error">{error.message}</Alert>}
            <TextField
              label="Name"
              placeholder="Web server 1"
              hint="Shown in alerts, so make it recognisable. The agent fills in the hostname."
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={error?.fieldError("name")}
              autoFocus
            />
          </div>
          <div className="card-body form-actions">
            <Link to="/" className="btn btn-ghost">
              Cancel
            </Link>
            <button className="btn btn-primary" disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add server"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
