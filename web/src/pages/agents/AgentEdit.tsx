import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { usePolicies } from "../../api/alerts";
import { ApiError, api } from "../../api/client";
import { monitorKeys, type Monitor } from "../../api/monitors";
import { Alert, SelectField, TextField } from "../../components";
import "../pages.css";
import "../monitors/monitors.css";

// A server agent has no target, interval or timeout: it calls in on its own. What's
// left to change is its name and who hears when it goes down.
export function AgentEditor({ monitor }: { monitor: Monitor }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const policies = usePolicies();
  const [name, setName] = useState(monitor.name);
  const [policyId, setPolicyId] = useState(monitor.escalationPolicy?.id ?? "");

  const save = useMutation({
    mutationFn: () =>
      api(`/monitors/${monitor.id}`, {
        method: "PATCH",
        body: { name, escalationPolicyId: policyId || null },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: monitorKeys.all });
      navigate(`/monitors/${monitor.id}`);
    },
  });
  const error = save.error instanceof ApiError ? save.error : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <>
      <header className="page-header">
        <div>
          <Link to={`/monitors/${monitor.id}`} className="back-link">
            <ArrowLeft size={14} aria-hidden /> {monitor.name}
          </Link>
          <h1>Edit server</h1>
        </div>
      </header>

      <form className="card form-card" onSubmit={submit} noValidate>
        <div className="card-body form-section">
          {save.error && !error?.details && <Alert tone="error">{save.error.message}</Alert>}
          <TextField
            label="Name"
            hint="Shown in alerts, so make it recognisable."
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={error?.fieldError("name")}
          />
          {policies.data ? (
            <SelectField
              label="Escalation policy"
              hint={
                <>
                  Without one, you and every enabled channel hear at once.{" "}
                  <Link to="/escalation">Manage policies</Link>
                </>
              }
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
              error={error?.fieldError("escalationPolicyId")}
            >
              <option value="">None: alert me and every channel</option>
              {policies.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectField>
          ) : (
            <SelectField label="Escalation policy" disabled>
              <option>{policies.isError ? "Couldn't load policies" : "Loading…"}</option>
            </SelectField>
          )}
        </div>
        <div className="card-body form-actions">
          <Link to={`/monitors/${monitor.id}`} className="btn btn-ghost">
            Cancel
          </Link>
          <button className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </>
  );
}
