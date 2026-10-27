import { describe, expect, it } from "vitest";
import { formatDuration, incidentEmail, slowEmail } from "./notify.js";

const incident = {
  monitor: { id: "m1", name: "Shop <script>", target: "https://shop.example.com/?a=1&b=2" },
  startedAt: new Date("2026-10-27T09:00:00Z"),
  resolvedAt: new Date("2026-10-27T09:04:30Z"),
  cause: "Connection refused",
};

describe("incidentEmail", () => {
  it("says what's down, why and since when", () => {
    const mail = incidentEmail("down", { ...incident, resolvedAt: null }, "https://app.test");
    expect(mail.subject).toBe("Down: Shop <script>");
    expect(mail.text).toContain("Cause: Connection refused");
    expect(mail.text).toContain("Since: 2026-10-27 09:00 UTC");
    expect(mail.html).toContain('href="https://app.test/monitors/m1"');
  });

  it("says how long it was down for when it recovers", () => {
    const mail = incidentEmail("up", incident, "https://app.test");
    expect(mail.subject).toBe("Back up: Shop <script> (down for 5 min)");
  });

  it("escapes everything the user typed in the HTML", () => {
    const { html } = incidentEmail("down", incident, "https://app.test");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Shop &lt;script&gt;");
    expect(html).toContain("a=1&amp;b=2");
  });
});

describe("slowEmail", () => {
  const check = {
    monitor: { id: "h1", name: "Nightly backup", target: "" },
    checkedAt: new Date("2026-10-27T03:04:00Z"),
    error: "Ran for 9 min, more than twice the usual 4 min",
  };

  it("says what got slow and by how much, without opening an incident", () => {
    const mail = slowEmail(check, "https://app.test");
    expect(mail.subject).toBe("Slow: Nightly backup");
    expect(mail.text).toContain("Detail: Ran for 9 min, more than twice the usual 4 min");
    expect(mail.text).toContain("no incident is open");
  });

  it("leaves out the target for a heartbeat, which has none", () => {
    const mail = slowEmail(check, "https://app.test");
    expect(mail.text).not.toContain("Target:");
    expect(mail.html).not.toContain("Target");
  });
});

describe("formatDuration", () => {
  it.each([
    [400, "1 s"],
    [35_000, "35 s"],
    [4 * 60_000, "4 min"],
    [60 * 60_000, "1 h"],
    [125 * 60_000, "2 h 5 min"],
  ])("%i ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
