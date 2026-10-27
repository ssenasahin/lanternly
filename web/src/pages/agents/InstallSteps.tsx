import { useState } from "react";
import type { IssuedKey } from "../../api/agents";
import { CopyButton, Segmented } from "../../components";
import "../alerts/alerts.css";
import "../settings/settings.css";
import "./agents.css";

type Shell = "shell" | "powershell";
const SHELLS = [
  { value: "shell", label: "Linux or macOS" },
  { value: "powershell", label: "Windows" },
] as const;

// A just-issued agent key and the command that starts the agent with it. Only its
// hash is stored, so this is the one time the key can be shown.
export function InstallSteps({ issued, onDone }: { issued: IssuedKey; onDone: () => void }) {
  const [shell, setShell] = useState<Shell>("shell");
  const command = issued.install[shell];

  return (
    <section className="card card-body secret-once">
      <h2 className="security-title">Start the agent on your server</h2>
      <ol className="install-steps">
        <li>
          <p>
            Copy this key somewhere safe. It's only shown now; if you lose it, replace it from the
            server's page.
          </p>
          <div className="secret-value">
            <code>{issued.key}</code>
            <CopyButton text={issued.key} label="Copy key" />
          </div>
        </li>
        <li>
          <p>
            On the server, in a copy of the Lanternly repository with Node.js 20 or later and{" "}
            <code className="inline-code">npm install</code> done, run:
          </p>
          <Segmented
            label="Server's system"
            options={SHELLS}
            value={shell}
            onChange={setShell}
            small
          />
          <pre className="code-block install-command">{command}</pre>
          <div>
            <CopyButton text={command} label="Copy command" />
          </div>
        </li>
        <li>
          <p>
            The agent reports CPU, memory and disk once a minute. The first report shows up here
            within a minute; if the server goes quiet for 3, you're alerted that it's down.
          </p>
        </li>
      </ol>
      <div>
        <button className="btn" onClick={onDone}>
          I've saved the key
        </button>
      </div>
    </section>
  );
}
