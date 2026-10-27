import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { ApiError, api } from "../../api/client";
import { useHeartbeat, type HeartbeatDetail, type HeartbeatInput } from "../../api/heartbeats";
import { monitorKeys } from "../../api/monitors";
import { Alert, SelectField, SkeletonRows, TextField } from "../../components";
import { formatPeriod } from "../../lib/format";
import { NotFoundPage } from "../NotFound";
import "../pages.css";
import "../monitors/monitors.css";
import "./heartbeats.css";

// The common schedules, one click each; anything else is a cron expression.
const PERIODS = [
  { value: "300", label: "Every 5 minutes" },
  { value: "3600", label: "Hourly" },
  { value: "86400", label: "Daily" },
];
const GRACES = [60, 300, 900, 1800, 3600, 6 * 3600, 12 * 3600, 24 * 3600];

const schema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Give the heartbeat a name")
      .max(100, "Keep it under 100 characters"),
    // A period in seconds, as a string for the radio buttons, or "cron".
    schedule: z.string(),
    cron: z.string().trim(),
    timezone: z.string(),
    graceSec: z.number().int(),
  })
  .superRefine((form, ctx) => {
    // The API checks the expression itself; this only catches the obvious slip.
    if (form.schedule === "cron" && form.cron.split(/\s+/).filter(Boolean).length !== 5) {
      ctx.addIssue({
        code: "custom",
        path: ["cron"],
        message: "Use five fields: minute, hour, day of month, month and day of week",
      });
    }
  });
type Form = z.infer<typeof schema>;

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// Every zone the browser knows, with UTC first: it's the one people look for.
const ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];

function toForm(existing?: HeartbeatDetail): Form {
  if (!existing) {
    return {
      name: "",
      schedule: "86400",
      cron: "0 3 * * *",
      timezone: browserZone(),
      graceSec: 300,
    };
  }
  const { monitor, heartbeat } = existing;
  return {
    name: monitor.name,
    schedule: heartbeat.cron ? "cron" : String(heartbeat.periodSec),
    cron: heartbeat.cron ?? "0 3 * * *",
    timezone: heartbeat.timezone,
    graceSec: heartbeat.graceSec,
  };
}

function toInput(form: Form): HeartbeatInput {
  const cron = form.schedule === "cron";
  return {
    name: form.name,
    periodSec: cron ? null : Number(form.schedule),
    cron: cron ? form.cron : null,
    timezone: form.timezone,
    graceSec: form.graceSec,
  };
}

// The API's field names, mapped to where its errors should show.
const FIELDS: Record<string, keyof Form> = {
  name: "name",
  periodSec: "schedule",
  cron: "cron",
  timezone: "timezone",
  graceSec: "graceSec",
};

// /heartbeats/new and /heartbeats/:id/edit share one form.
export function HeartbeatFormPage() {
  const { id } = useParams();
  if (!id) return <HeartbeatEditor />;
  return <EditHeartbeat id={id} />;
}

function EditHeartbeat({ id }: { id: string }) {
  const heartbeat = useHeartbeat(id);
  if (heartbeat.isPending) {
    return (
      <div className="card card-body form-card">
        <SkeletonRows rows={4} height={52} />
      </div>
    );
  }
  if (heartbeat.error instanceof ApiError && heartbeat.error.status === 404) {
    return <NotFoundPage />;
  }
  if (heartbeat.isError) return <Alert tone="error">Couldn't load this heartbeat.</Alert>;
  return <HeartbeatEditor existing={heartbeat.data} />;
}

// Waits for typing to pause before passing a value on, so the preview doesn't ask
// the API about every keystroke.
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function HeartbeatEditor({ existing }: { existing?: HeartbeatDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: toForm(existing) });
  const [schedule, cron, timezone] = useWatch({
    control,
    name: ["schedule", "cron", "timezone"],
  });

  // A period set through the API that isn't one of the presets still gets a button.
  const periods =
    PERIODS.some((p) => p.value === schedule) || schedule === "cron"
      ? PERIODS
      : [...PERIODS, { value: schedule, label: `Every ${formatPeriod(Number(schedule))}` }];
  const graces = GRACES.includes(existing?.heartbeat.graceSec ?? 300)
    ? GRACES
    : [...GRACES, existing!.heartbeat.graceSec].sort((a, b) => a - b);

  const save = useMutation({
    mutationFn: (form: Form) =>
      existing
        ? api<HeartbeatDetail>(`/heartbeats/${existing.monitor.id}`, {
            method: "PATCH",
            body: toInput(form),
          })
        : api<HeartbeatDetail>("/heartbeats", { method: "POST", body: toInput(form) }),
    onSuccess: async ({ monitor }) => {
      await queryClient.invalidateQueries({ queryKey: monitorKeys.all });
      navigate(`/monitors/${monitor.id}`);
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) {
        setError("root", { message: "Couldn't reach Lanternly. Try again." });
        return;
      }
      let placed = false;
      for (const [apiField, messages] of Object.entries(err.details ?? {})) {
        const field = FIELDS[apiField];
        if (field && Array.isArray(messages)) {
          setError(field, { type: "server", message: String(messages[0]) });
          placed = true;
        }
      }
      if (!placed) setError("root", { message: err.message });
    },
  });

  const cancelTo = existing ? `/monitors/${existing.monitor.id}` : "/";

  return (
    <>
      <header className="page-header">
        <div>
          <Link to={cancelTo} className="back-link">
            <ArrowLeft size={14} aria-hidden /> {existing ? existing.monitor.name : "Monitors"}
          </Link>
          <h1>{existing ? "Edit heartbeat" : "Add a heartbeat"}</h1>
          <p>
            {existing
              ? "The new schedule applies from the next ping."
              : "For cron jobs, backups and other scheduled work: the job pings Lanternly when it runs, and you hear about it when a ping doesn't come."}
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

          <TextField
            label="Name"
            placeholder="Nightly backup"
            hint="Shown in alerts, so make it recognisable."
            error={errors.name?.message}
            {...register("name")}
          />

          <fieldset className="field">
            <legend className="field-label">Expect a ping</legend>
            <div className="segmented segmented-wrap" role="radiogroup">
              {periods.map((p) => (
                <label key={p.value}>
                  <input type="radio" value={p.value} {...register("schedule")} />
                  {p.label}
                </label>
              ))}
              <label>
                <input type="radio" value="cron" {...register("schedule")} />
                On a cron schedule
              </label>
            </div>
            {errors.schedule && <span className="field-error">{errors.schedule.message}</span>}
          </fieldset>

          {schedule === "cron" && (
            <div className="form-grid">
              <TextField
                label="Cron expression"
                placeholder="0 3 * * *"
                autoComplete="off"
                spellCheck={false}
                mono
                error={errors.cron?.message}
                hint={<CronPreview cron={cron} timezone={timezone} />}
                {...register("cron")}
              />
              <SelectField
                label="Time zone"
                hint="The zone the expression is read in."
                error={errors.timezone?.message}
                {...register("timezone")}
              >
                {ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </option>
                ))}
              </SelectField>
            </div>
          )}

          <SelectField
            label="Grace period"
            hint="How late a ping may be before it counts as missed. Leave room for slow runs."
            error={errors.graceSec?.message}
            {...register("graceSec", { valueAsNumber: true })}
          >
            {graces.map((s) => (
              <option key={s} value={s}>
                {formatPeriod(s)}
              </option>
            ))}
          </SelectField>
        </div>

        <div className="card-body form-actions">
          <Link to={cancelTo} className="btn btn-ghost">
            Cancel
          </Link>
          <button className="btn btn-primary" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : existing ? "Save changes" : "Add heartbeat"}
          </button>
        </div>
      </form>
    </>
  );
}

// "Next runs: Tue 28 Oct, 03:00 · …" in the chosen zone, straight from the API's
// parser, so what the form promises is exactly what the worker will expect.
function CronPreview({ cron, timezone }: { cron: string; timezone: string }) {
  const settled = useSettled(`${cron.trim()}\n${timezone}`);
  const [expression = "", zone = "UTC"] = settled.split("\n");
  const complete = expression.split(/\s+/).filter(Boolean).length === 5;

  const preview = useQuery({
    queryKey: ["cron-preview", expression, zone],
    queryFn: () =>
      api<{ next: string[] }>("/heartbeats/schedule-preview", {
        method: "POST",
        body: { cron: expression, timezone: zone },
      }),
    enabled: complete,
    retry: false,
    staleTime: Infinity,
  });

  if (!complete) return "Minute, hour, day of month, month, day of week.";
  if (preview.isPending) return "Working out the next runs…";
  if (preview.isError) {
    const message =
      preview.error instanceof ApiError ? preview.error.fieldError("cron") : undefined;
    return <span className="field-error">{message ?? "Couldn't check this expression."}</span>;
  }
  const when = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  return <>Next runs: {preview.data.next.map(when).join(" · ")}</>;
}
