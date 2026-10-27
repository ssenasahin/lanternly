import { Lock } from "lucide-react";
import { useChecks, type ApiSettings, type Monitor } from "../../api/monitors";
import { formatTime } from "../../lib/format";
import { Fact } from "./parts";
import { RuleTable } from "./RuleTable";
import { OPERATOR_WORDS as WORDS, PRESENCE } from "./operators";

const BODY_WORDS = { NONE: "None", JSON: "JSON", FORM: "Form" };

// Why the latest check failed, rule by rule: expected beside received. Shown only
// while the last check is a failure that rules explain.
export function ApiFailure({ monitor }: { monitor: Monitor }) {
  const checks = useChecks(monitor.id);
  const latest = checks.data?.[0];
  if (!latest || latest.status !== "DOWN" || !latest.rules) return null;

  const failed = latest.rules.filter((r) => !r.passed).length;
  return (
    <section className="card failure-card">
      <div className="card-head">
        <h2 className="section-title">
          {failed === 1 ? "A rule failed" : `${failed} rules failed`}
        </h2>
        <span className="muted">
          {latest.statusCode !== null && <span className="mono">HTTP {latest.statusCode}, </span>}
          checked {formatTime(latest.checkedAt)}
        </span>
      </div>
      <RuleTable rules={latest.rules} />
    </section>
  );
}

// How the monitor calls its API and what it expects back.
export function ApiSettingsCard({ api }: { api: ApiSettings }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Request and rules</h2>
      </div>
      <dl className="card-body facts">
        <Fact label="Method">
          <span className="mono">{api.method}</span>
        </Fact>
        <Fact label="Expects">
          <span className="mono">{api.expectedStatus}</span>
        </Fact>
        <Fact label="Body">{BODY_WORDS[api.bodyType]}</Fact>
        <Fact label="Headers">
          {api.headers.length === 0 ? (
            "None"
          ) : (
            <span className="header-names">
              {api.headers.map((h) => (
                <span key={h.name} className="mono">
                  {h.secret && <Lock size={11} aria-label="secret" />} {h.name}
                </span>
              ))}
            </span>
          )}
        </Fact>
      </dl>
      {api.rules.length === 0 ? (
        <p className="card-body muted rules-empty">
          No rules: any answer with an expected status code counts as up.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="checks rule-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Check</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {api.rules.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.path}</td>
                  <td>{WORDS[r.operator]}</td>
                  <td className="mono rule-value">
                    {PRESENCE.has(r.operator) ? <span className="muted">–</span> : r.expected}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
