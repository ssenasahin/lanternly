import { Check, X } from "lucide-react";
import type { RuleResult } from "../../api/monitors";
import { OPERATOR_WORDS as WORDS, PRESENCE } from "./operators";

// Each rule beside what the response actually held: expected on the left, received on
// the right, so a failure explains itself.
export function RuleTable({ rules }: { rules: RuleResult[] }) {
  return (
    <div className="table-scroll">
      <table className="checks rule-table">
        <thead>
          <tr>
            <th>
              <span className="sr-only">Result</span>
            </th>
            <th>Rule</th>
            <th>Expected</th>
            <th>Received</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={i} className={r.passed ? undefined : "rule-failed"}>
              <td className="rule-verdict">
                {r.passed ? (
                  <Check size={14} aria-label="Passed" className="rule-pass" />
                ) : (
                  <X size={14} aria-label="Failed" className="rule-fail" />
                )}
              </td>
              <td>
                <span className="mono">{r.path}</span> {WORDS[r.operator]}
              </td>
              <td className="mono rule-value">
                {PRESENCE.has(r.operator) ? <span className="muted">–</span> : r.expected}
              </td>
              <td className="mono rule-value">
                {r.received ?? <span className="muted">nothing there</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
