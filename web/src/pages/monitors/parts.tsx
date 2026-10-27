import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../../api/client";
import { monitorKeys, type Monitor } from "../../api/monitors";

// Pieces of the detail page that checked monitors and heartbeats share.

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Actions({ monitor }: { monitor: Monitor }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: monitorKeys.all });

  const toggle = useMutation({
    mutationFn: () =>
      api(`/monitors/${monitor.id}/${monitor.isActive ? "pause" : "resume"}`, { method: "POST" }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: () => api(`/monitors/${monitor.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: monitorKeys.detail(monitor.id) });
      await refresh();
      navigate("/", { replace: true });
    },
  });

  // Deleting throws away the monitor's whole history, so it takes a second click.
  if (confirming) {
    return (
      <div className="row confirm-delete" role="group" aria-label="Confirm delete">
        <span>Delete it and all its history?</span>
        <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
          Keep it
        </button>
        <button
          className="btn btn-danger"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          autoFocus
        >
          <Trash2 size={15} aria-hidden /> {remove.isPending ? "Deleting…" : "Delete"}
        </button>
      </div>
    );
  }

  return (
    <div className="row">
      {(toggle.error || remove.error) && (
        <span className="field-error">{(toggle.error ?? remove.error)?.message}</span>
      )}
      <button className="btn" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
        {monitor.isActive ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}
        {monitor.isActive ? "Pause" : "Resume"}
      </button>
      <Link
        to={`/${monitor.type === "HEARTBEAT" ? "heartbeats" : "monitors"}/${monitor.id}/edit`}
        className="btn"
      >
        <Pencil size={15} aria-hidden /> Edit
      </Link>
      <button
        className="btn btn-ghost btn-icon"
        onClick={() => setConfirming(true)}
        aria-label="Delete monitor"
        title="Delete monitor"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}
