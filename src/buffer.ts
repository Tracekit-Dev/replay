/** Bounded, snapshot-aware history for error-triggered recording. */

interface BufferedEvent {
  event: any;
  timestamp: number;
  bytes: number;
}

const DEFAULT_BYTES = 4 * 1024 * 1024;
const HARD_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVENTS = 2_000;
const HARD_EVENTS = 10_000;
const HARD_AGE_MS = 5 * 60_000;

function bounded(value: number | undefined, fallback: number, ceiling: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), ceiling) : fallback;
}

/** A mutation needs a retained FullSnapshot in the same history region. */
function isMutation(event: any): boolean {
  return event?.type === 3 && event?.data?.source === 0;
}

export class RingBuffer {
  private events: BufferedEvent[] = [];
  private bytes = 0;
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private readonly maxEvents: number;

  constructor(maxAgeMs = 60_000, options: { maxBytes?: number; maxEvents?: number } = {}) {
    this.maxAgeMs = bounded(maxAgeMs, 60_000, HARD_AGE_MS);
    this.maxBytes = bounded(options.maxBytes, DEFAULT_BYTES, HARD_BYTES);
    this.maxEvents = bounded(options.maxEvents, DEFAULT_EVENTS, HARD_EVENTS);
  }

  add(event: any): 'snapshot_too_large' | null {
    this.evictExpired();
    if (isMutation(event) && !this.events.some((entry) => entry.event?.type === 2)) return null;
    let bytes: number;
    try { bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength; }
    catch { return null; }
    if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes) {
      if (event?.type === 2) this.clear();
      return event?.type === 2 ? 'snapshot_too_large' : null;
    }
    const timestamp = Number.isFinite(event?.timestamp) ? event.timestamp : Date.now();
    this.events.push({ event, timestamp, bytes });
    this.bytes += bytes;
    this.enforceLimits();
    return null;
  }

  flush(): any[] {
    this.evictExpired();
    const events = this.events.map((entry) => entry.event);
    this.clear();
    return events;
  }

  clear(): void {
    this.events = [];
    this.bytes = 0;
  }

  get size(): number { return this.events.length; }
  get byteSize(): number { return this.bytes; }

  private evictExpired(): void {
    this.enforceLimits(Date.now() - this.maxAgeMs);
  }

  private enforceLimits(cutoff = Number.NEGATIVE_INFINITY): void {
    while (this.events.length > 0 &&
      (this.events[0].timestamp < cutoff || this.bytes > this.maxBytes || this.events.length > this.maxEvents)) {
      const nextSnapshot = this.events.findIndex((entry, index) => index > 0 && entry.event?.type === 2);
      if (nextSnapshot < 0) {
        this.clear();
        return;
      }
      this.discardPrefix(nextSnapshot);
    }
    if (this.events.length > 0 && this.events[0].event?.type !== 2) {
      const nextSnapshot = this.events.findIndex((entry) => entry.event?.type === 2);
      if (nextSnapshot < 0) this.clear();
      else this.discardPrefix(nextSnapshot);
    }
  }

  private discardPrefix(count: number): void {
    for (const entry of this.events.splice(0, count)) this.bytes -= entry.bytes;
  }
}
