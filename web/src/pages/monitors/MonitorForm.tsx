import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Globe, Radio } from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { ApiError, api } from "../../api/client";
import { monitorKeys, useMonitor, type Monitor } from "../../api/monitors";
import { Alert, SelectField, SkeletonRows, TextField } from "../../components";
import { formatSeconds } from "../../lib/format";
import { NotFoundPage } from "../NotFound";
import { formField, monitorSchema, NEW_MONITOR, toForm, toInput, type MonitorForm } from "./schema";
import "../pages.css";
import "./monitors.css";

const INTERVALS = [30, 60, 120, 180, 300];
const RETRIES = [0, 1, 2, 3, 4, 5];

// /monitors/new and /monitors/:id/edit share one form.
export function MonitorFormPage() {
  const { id } = useParams();
  if (!id) return <MonitorEditor />;
  return <EditMonitor id={id} />;
}

function EditMonitor({ id }: { id: string }) {
  const monitor = useMonitor(id);
  if (monitor.isPending) {
    return (
      <div className="card card-body form-card">
        <SkeletonRows rows={5} height={52} />
      </div>
    );
  }
  if (monitor.error instanceof ApiError && monitor.error.status === 404) return <NotFoundPage />;
  if (monitor.isError) return <Alert tone="error">Couldn't load this monitor.</Alert>;
  if (monitor.data.monitor.type === "HEARTBEAT") {
    return <Navigate to={`/heartbeats/${id}/edit`} replace />;
  }
  // Mounted only once the monitor has loaded, so the form starts from its values.
  return <MonitorEditor existing={monitor.data.monitor} />;
}

function MonitorEditor({ existing }: { existing?: Monitor }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<MonitorForm>({
    resolver: zodResolver(monitorSchema),
    defaultValues: existing ? toForm(existing) : NEW_MONITOR,
  });
  const type = useWatch({ control, name: "type" });

  const save = useMutation({
    mutationFn: (form: MonitorForm) =>
      existing
        ? api<{ monitor: Monitor }>(`/monitors/${existing.id}`, {
            method: "PATCH",
            body: toInput(form),
          })
        : api<{ monitor: Monitor }>("/monitors", { method: "POST", body: toInput(form) }),
    onSuccess: async ({ monitor }) => {
      await queryClient.invalidateQueries({ queryKey: monitorKeys.all });
      navigate(`/monitors/${monitor.id}`);
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) {
        setError("root", { message: "Couldn't reach Lanternly. Try again." });
        return;
      }
      // Put each of the API's complaints under the field it's about.
      let placed = false;
      for (const [apiField, messages] of Object.entries(err.details ?? {})) {
        const field = formField(apiField);
        if (field && Array.isArray(messages)) {
          setError(field, { type: "server", message: String(messages[0]) });
          placed = true;
        }
      }
      if (!placed) setError("root", { message: err.message });
    },
  });

  const cancelTo = existing ? `/monitors/${existing.id}` : "/";

  return (
    <>
      <header className="page-header">
        <div>
          <Link to={cancelTo} className="back-link">
            <ArrowLeft size={14} aria-hidden /> {existing ? existing.name : "Monitors"}
          </Link>
          <h1>{existing ? "Edit monitor" : "Add a monitor"}</h1>
          <p>
            {existing
              ? "Changing the target starts its history fresh: the next check decides its state."
              : "Lanternly checks it right away, then on the interval you pick."}
          </p>
        </div>
      </header>

      <form
        className="card form-card"
        onSubmit={handleSubmit((form) => save.mutateAsync(form).catch(() => {}))}
        noValidate
      >
        <div className="card-body form-section">
          {errors.root && <Alert tone="error">{errors.root.message}</Alert>}

          <fieldset className="field">
            <legend className="field-label">What to check</legend>
            <div className="segmented" role="radiogroup">
              <label>
                <input type="radio" value="HTTP" {...register("type")} />
                <Globe size={15} aria-hidden /> Website or API
              </label>
              <label>
                <input type="radio" value="PING" {...register("type")} />
                <Radio size={15} aria-hidden /> Ping a server
              </label>
            </div>
          </fieldset>

          <TextField
            label={type === "HTTP" ? "URL" : "Host"}
            placeholder={
              type === "HTTP" ? "https://example.com/health" : "example.com or 203.0.114.10"
            }
            autoComplete="off"
            spellCheck={false}
            mono
            hint={
              type === "HTTP"
                ? "Any answer from 200 to 399 counts as up. Redirects are followed."
                : "Up when it answers an ICMP echo request."
            }
            error={errors.target?.message}
            {...register("target")}
          />

          <TextField
            label="Name"
            placeholder="Marketing site"
            hint="Shown in alerts, so make it recognisable."
            error={errors.name?.message}
            {...register("name")}
          />
        </div>

        <div className="card-body form-section form-section-split">
          <h2 className="section-title">Timing</h2>
          <div className="form-grid">
            <SelectField
              label="Check every"
              error={errors.intervalSec?.message}
              {...register("intervalSec", { valueAsNumber: true })}
            >
              {INTERVALS.map((s) => (
                <option key={s} value={s}>
                  {formatSeconds(s)}
                </option>
              ))}
            </SelectField>

            <TextField
              label="Timeout (seconds)"
              type="number"
              inputMode="decimal"
              min={1}
              max={30}
              step="any"
              error={errors.timeoutSec?.message}
              {...register("timeoutSec", { valueAsNumber: true })}
            />

            <SelectField
              label="Retries before alerting"
              hint="Extra tries before it counts as down."
              error={errors.retries?.message}
              {...register("retries", { valueAsNumber: true })}
            >
              {RETRIES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "None" : `${n} ${n === 1 ? "retry" : "retries"}`}
                </option>
              ))}
            </SelectField>
          </div>
        </div>

        <div className="card-body form-actions">
          <Link to={cancelTo} className="btn btn-ghost">
            Cancel
          </Link>
          <button className="btn btn-primary" disabled={isSubmitting}>
            {isSubmitting ? "Checking the address…" : existing ? "Save changes" : "Add monitor"}
          </button>
        </div>
      </form>
    </>
  );
}
