import { describe, expect, it } from "vitest";
import { MAX_WAITING, Outbox, type Sample } from "./outbox.js";

const sample = (n: number): Sample => ({
  at: new Date(n * 60_000).toISOString(),
  cpu: n,
  memory: 1,
  disk: 1,
});

describe("Outbox", () => {
  it("keeps samples until a send succeeds", async () => {
    const outbox = new Outbox();
    outbox.add(sample(1));
    await expect(
      outbox.flush(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    outbox.add(sample(2));

    const sent: Sample[][] = [];
    await outbox.flush(async (batch) => void sent.push(batch));
    expect(sent).toEqual([[sample(1), sample(2)]]);
    expect(outbox.size).toBe(0);
  });

  it("drops the oldest once it's full", () => {
    const outbox = new Outbox();
    for (let n = 0; n < MAX_WAITING + 5; n++) outbox.add(sample(n));
    expect(outbox.size).toBe(MAX_WAITING);
  });

  it("keeps a sample taken while a send was in flight", async () => {
    const outbox = new Outbox();
    outbox.add(sample(1));
    await outbox.flush(async () => outbox.add(sample(2)));
    expect(outbox.size).toBe(1);
  });
});
