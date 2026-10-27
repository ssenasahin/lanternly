// Samples waiting to be sent. While Lanternly can't be reached they pile up here,
// and go out together once it can. The oldest are dropped past the limit: a server
// that's been cut off for hours needs its recent numbers, not a backlog.

export interface Sample {
  at: string;
  cpu: number;
  memory: number;
  disk: number;
}

// Two hours at one a minute: what the API accepts in one report.
export const MAX_WAITING = 120;

export class Outbox {
  private samples: Sample[] = [];

  add(sample: Sample) {
    this.samples.push(sample);
    if (this.samples.length > MAX_WAITING)
      this.samples.splice(0, this.samples.length - MAX_WAITING);
  }

  // Hands everything waiting to `send`. Only once it succeeds are they forgotten,
  // so a failed send keeps them for the next try.
  async flush(send: (samples: Sample[]) => Promise<void>) {
    if (this.samples.length === 0) return;
    const batch = [...this.samples];
    await send(batch);
    this.samples.splice(0, batch.length);
  }

  get size() {
    return this.samples.length;
  }
}
