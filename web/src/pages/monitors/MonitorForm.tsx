import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Braces, Globe, Network, Plug, Radio } from "lucide-react";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { usePolicies } from "../../api/alerts";
import { ApiError, api } from "../../api/client";
import { monitorKeys, useMonitor, type Monitor } from "../../api/monitors";
import { Alert, SelectField, SkeletonRows, TextField } from "../../components";
import { formatSeconds } from "../../lib/format";
import { AgentEditor } from "../agents/AgentEdit";
import { NotFoundPage } from "../NotFound";
import { RequestFields, ResponseFields } from "./ApiFields";
import { DnsFields } from "./DnsFields";
import { METHODS } from "./operators";
import { formField, monitorSchema, NEW_MONITOR, toForm, toInput, type MonitorForm } from "./schema";
import { TestPanel } from "./TestPanel";
import "../pages.css";
import "./monitors.css";

const INTERVALS = [30, 60, 120, 180, 300];
const RETRIES = [0, 1, 2, 3, 4, 5];

const TARGET = {
  HTTP: {
    label: "URL",
    placeholder: "https://example.com/health",
    hint: "Any answer from 200 to 399 counts as up. Redirects are followed.",
  },
  API: {
    label: "URL",
    placeholder: "https://api.example.com/v1/health",
    hint: undefined,
  },
  PING: {
    label: "Host",
    placeholder: "example.com or 203.0.114.10",
    hint: "Up when it answers an ICMP echo request.",
  },
  TCP: {
    label: "Host and port",
    placeholder: "db.example.com:5432",
    hint: "Up when the port accepts a connection. Nothing is sent.",
  },
  DNS: {
    label: "Domain name",
    placeholder: "example.com",
    hint: undefined,
  },
};

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
  if (monitor.data.monitor.type === "AGENT") return <AgentEditor monitor={monitor.data.monitor} />;
  // Mounted only once the monitor has loaded, so the form starts from its values.
  return <MonitorEditor existing={monitor.data.monitor} />;
}

function MonitorEditor({ existing }: { existing?: Monitor }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<MonitorForm>({
    resolver: zodResolver(monitorSchema),
    defaultValues: existing ? toForm(existing) : NEW_MONITOR,
  });
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = form;
  const type = useWatch({ control, name: "type" });
  const target = TARGET[type];

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
            <div className="segmented segmented-wrap" role="radiogroup">
              <label>
                <input type="radio" value="HTTP" {...register("type")} />
                <Globe size={15} aria-hidden /> Website
              </label>
              <label>
                <input type="radio" value="API" {...register("type")} />
                <Braces size={15} aria-hidden /> API with rules
              </label>
              <label>
                <input type="radio" value="PING" {...register("type")} />
                <Radio size={15} aria-hidden /> Ping a server
              </label>
              <label>
                <input type="radio" value="TCP" {...register("type")} />
                <Plug size={15} aria-hidden /> TCP port
              </label>
              <label>
                <input type="radio" value="DNS" {...register("type")} />
                <Network size={15} aria-hidden /> DNS record
              </label>
            </div>
          </fieldset>

          <div className={type === "API" ? "request-line" : undefined}>
            {type === "API" && (
              <SelectField label="Method" {...register("method")}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </SelectField>
            )}
            <TextField
              label={target.label}
              placeholder={target.placeholder}
              autoComplete="off"
              spellCheck={false}
              mono
              hint={target.hint}
              error={errors.target?.message}
              {...register("target")}
            />
          </div>

          <TextField
            label="Name"
            placeholder="Marketing site"
            hint="Shown in alerts, so make it recognisable."
            error={errors.name?.message}
            {...register("name")}
          />
        </div>

        {type === "DNS" && (
          <div className="card-body form-section form-section-split">
            <h2 className="section-title">Lookup</h2>
            <DnsFields form={form} />
          </div>
        )}

        {type === "API" && (
          <>
            <div className="card-body form-section form-section-split">
              <h2 className="section-title">Request</h2>
              <RequestFields form={form} />
            </div>
            <div className="card-body form-section form-section-split">
              <h2 className="section-title">Response</h2>
              <ResponseFields form={form} />
              <TestPanel form={form} monitorId={existing?.id} />
            </div>
          </>
        )}

        <div className="card-body form-section form-section-split">
          <h2 className="section-title">Timing</h2>
          <div className="form-grid form-grid-2">
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

            <TextField
              label="Slow after (ms)"
              type="number"
              inputMode="numeric"
              min={10}
              step={1}
              placeholder="No limit"
              hint="Slower answers count as degraded, with one warning."
              error={errors.slowAfterMs?.message}
              {...register("slowAfterMs", {
                setValueAs: (v: string | number | null) =>
                  v === "" || v === null ? null : Number(v),
              })}
            />
          </div>
        </div>

        <div className="card-body form-section form-section-split">
          <h2 className="section-title">Alerts</h2>
          <EscalationField form={form} />
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

// Who hears when it goes down. Without a policy, the owner and every enabled channel
// hear at once; a policy alerts its first step and escalates from there.
function EscalationField({ form }: { form: UseFormReturn<MonitorForm> }) {
  const policies = usePolicies();
  const {
    register,
    formState: { errors },
  } = form;
  // Mounted once the options exist, so the saved choice has an option to select.
  if (!policies.data) {
    return (
      <SelectField label="Escalation policy" disabled>
        <option>{policies.isError ? "Couldn't load policies" : "Loading…"}</option>
      </SelectField>
    );
  }
  return (
    <SelectField
      label="Escalation policy"
      hint={
        <>
          Without one, you and every enabled channel hear at once.{" "}
          <Link to="/escalation">Manage policies</Link>
        </>
      }
      error={errors.escalationPolicyId?.message}
      {...register("escalationPolicyId")}
    >
      <option value="">None: alert me and every channel</option>
      {policies.data.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </SelectField>
  );
}
