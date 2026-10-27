import { useMutation } from "@tanstack/react-query";
import { Play } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import { ApiError, api } from "../../api/client";
import { badgeStatus, type TestResult } from "../../api/monitors";
import { Alert, StatusBadge } from "../../components";
import { formatMs } from "../../lib/format";
import { RuleTable } from "./RuleTable";
import { formField, toApiSettings, type MonitorForm } from "./schema";

// The fields a test reads; only these are checked before it's sent.
const TESTED = [
  "target",
  "timeoutSec",
  "slowAfterMs",
  "method",
  "headers",
  "bodyType",
  "body",
  "expectedStatus",
  "rules",
] as const;

// Sends the request as the form stands, without saving, and shows what came back
// and how each rule fared: the quickest way to get a path or a value right.
export function TestPanel({
  form,
  monitorId,
}: {
  form: UseFormReturn<MonitorForm>;
  monitorId?: string;
}) {
  const test = useMutation({
    mutationFn: (values: MonitorForm) =>
      api<{ result: TestResult }>("/monitors/test", {
        method: "POST",
        body: {
          target: values.target,
          timeoutMs: Math.round(values.timeoutSec * 1000),
          slowAfterMs: values.slowAfterMs,
          api: toApiSettings(values),
          monitorId,
        },
      }).then((r) => r.result),
    onError: (err) => {
      // A field the API refused gets its message, as on save.
      if (!(err instanceof ApiError)) return;
      for (const [apiField, messages] of Object.entries(err.details ?? {})) {
        const field = formField(apiField);
        if (field && Array.isArray(messages)) {
          form.setError(field, { type: "server", message: String(messages[0]) });
        }
      }
    },
  });

  async function run() {
    if (await form.trigger(TESTED)) test.mutate(form.getValues());
  }

  return (
    <div className="test-panel">
      <div className="test-head">
        <button type="button" className="btn" onClick={() => void run()} disabled={test.isPending}>
          <Play size={14} aria-hidden /> {test.isPending ? "Sending…" : "Test now"}
        </button>
        <span className="field-hint">
          Sends the request once, as it stands, and checks the answer. Nothing is saved.
        </span>
      </div>
      <div aria-live="polite">
        {test.isError && !(test.error instanceof ApiError && test.error.details) && (
          <Alert tone="error">
            {test.error instanceof ApiError ? test.error.message : "Couldn't reach Lanternly."}
          </Alert>
        )}
        {test.data && <TestOutcome result={test.data} />}
      </div>
    </div>
  );
}

function TestOutcome({ result }: { result: TestResult }) {
  const { response } = result;
  return (
    <div className="test-result">
      <div className="test-summary">
        <StatusBadge status={badgeStatus(result.status)} />
        {result.statusCode !== null && <span className="mono">HTTP {result.statusCode}</span>}
        {result.responseMs !== null && <span className="mono">{formatMs(result.responseMs)}</span>}
      </div>
      {result.error && <p className="test-error">{result.error}</p>}
      {result.rules.length > 0 && <RuleTable rules={result.rules} />}
      {response && (
        <details className="test-body" open={result.rules.length === 0}>
          <summary>
            Response body
            {response.contentType && <span className="muted"> · {response.contentType}</span>}
          </summary>
          <pre className="code-block">{pretty(response.body) || "(empty)"}</pre>
          {response.truncated && <p className="field-hint">Only the start of the body is shown.</p>}
        </details>
      )}
    </div>
  );
}

// Indented if it's JSON, as it came if not.
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
