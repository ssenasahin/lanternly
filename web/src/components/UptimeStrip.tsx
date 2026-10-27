export interface StripSlot {
  // What the slot covers, for its tooltip: "14:00–15:00".
  label: string;
  checks: number;
  failures: number;
}

function describe({ label, checks, failures }: StripSlot): string {
  if (checks === 0) return `${label}: no checks`;
  if (failures === 0) return `${label}: all ${checks} checks up`;
  return `${label}: ${failures} of ${checks} checks down`;
}

// A row of slots, oldest on the left: green when every check passed, red when any
// failed, empty when nothing ran. Colour is never the only signal: each slot names
// itself on hover, and the strip always sits next to its uptime as a number.
export function UptimeStrip({ slots, label }: { slots: StripSlot[]; label: string }) {
  return (
    <span className="strip" role="img" aria-label={label}>
      {slots.map((slot, i) => (
        <span
          key={i}
          className={`strip-slot ${slot.checks === 0 ? "is-empty" : slot.failures > 0 ? "is-down" : "is-up"}`}
          title={describe(slot)}
        />
      ))}
    </span>
  );
}
