/** Bounded, snapshot-aware history for error-triggered recording. */

interface BufferedEvent {
  event: any;
  arrivedAt: number;
  bytes: number;
}

export interface RingBufferResult {
  reason: 'baseline_lost' | 'snapshot_too_large' | 'event_dropped';
  droppedEvents: number;
  droppedBytes: number;
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

function isSnapshot(event: any): boolean { return event?.type === 2; }
function isMutation(event: any): boolean { return event?.type === 3 && event?.data?.source === 0; }

export class RingBuffer {
  private events: BufferedEvent[] = [];
  private bytes = 0;
  private lostEvents = 0;
  private lostBytes = 0;
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private readonly maxEvents: number;

  constructor(maxAgeMs = 60_000, options: { maxBytes?: number; maxEvents?: number } = {}) {
    this.maxAgeMs = bounded(maxAgeMs, 60_000, HARD_AGE_MS);
    this.maxBytes = bounded(options.maxBytes, DEFAULT_BYTES, HARD_BYTES);
    this.maxEvents = bounded(options.maxEvents, DEFAULT_EVENTS, HARD_EVENTS);
  }

  add(event: any): RingBufferResult | null {
    let result = this.evictExpired();
    let size: number;
    try { size = new TextEncoder().encode(JSON.stringify(event)).byteLength; }
    catch { return result; }
    if (!Number.isSafeInteger(size)) return result;

    if (size > this.maxBytes) {
      if (isSnapshot(event) || isMutation(event)) {
        const lost = this.discardAll();
        result = this.merge(result, this.recordLoss(isSnapshot(event) ? 'snapshot_too_large' : 'baseline_lost',
          lost.droppedEvents + 1, lost.droppedBytes + size));
      } else result = this.merge(result, this.recordLoss('event_dropped', 1, size));
      return result;
    }
    if (isMutation(event) && !this.hasBaseline) {
      return this.merge(result, this.recordLoss(result?.reason === 'baseline_lost' ? 'baseline_lost' : 'event_dropped', 1, size));
    }

    this.events.push({ event, arrivedAt: Date.now(), bytes: size });
    this.bytes += size;
    return this.merge(result, this.enforceLimits());
  }

  flush(): any[] {
    this.evictExpired();
    const events = this.events.map((entry) => entry.event);
    this.events = [];
    this.bytes = 0;
    return events;
  }

  clear(): void {
    this.events = [];
    this.bytes = 0;
    this.lostEvents = 0;
    this.lostBytes = 0;
  }

  /** Collect drop evidence once after an add or expiry-driven flush. */
  takeLossReport(): { droppedEvents: number; droppedBytes: number } {
    const report = { droppedEvents: this.lostEvents, droppedBytes: this.lostBytes };
    this.lostEvents = 0;
    this.lostBytes = 0;
    return report;
  }

  get size(): number { return this.events.length; }
  get byteSize(): number { return this.bytes; }
  get hasBaseline(): boolean { return this.events.some((entry) => isSnapshot(entry.event)); }

  private evictExpired(): RingBufferResult | null {
    return this.enforceLimits(Date.now() - this.maxAgeMs);
  }

  private enforceLimits(cutoff = Number.NEGATIVE_INFINITY): RingBufferResult | null {
    let result: RingBufferResult | null = null;
    while (this.events.length > 0 &&
      (this.events[0].arrivedAt < cutoff || this.bytes > this.maxBytes || this.events.length > this.maxEvents)) {
      const nextSnapshot = this.events.findIndex((entry, index) => index > 0 && isSnapshot(entry.event));
      if (nextSnapshot < 0) {
        const hadBaseline = this.hasBaseline;
        const lost = this.discardAll();
        if (!hadBaseline) return result;
        return this.merge(result, this.recordLoss('baseline_lost',
          lost.droppedEvents, lost.droppedBytes));
      }
      const lost = this.discardPrefix(nextSnapshot);
      result = this.merge(result, this.recordLoss('event_dropped', lost.droppedEvents, lost.droppedBytes));
    }
    if (this.events.length > 0 && !isSnapshot(this.events[0].event)) {
      const nextSnapshot = this.events.findIndex((entry) => isSnapshot(entry.event));
      if (nextSnapshot < 0) this.discardAll();
      else this.discardPrefix(nextSnapshot);
    }
    return result;
  }

  private discardAll(): { droppedEvents: number; droppedBytes: number } {
    const lost = { droppedEvents: this.events.length, droppedBytes: this.bytes };
    this.events = [];
    this.bytes = 0;
    return lost;
  }

  private discardPrefix(count: number): { droppedEvents: number; droppedBytes: number } {
    const removed = this.events.splice(0, count);
    const bytes = removed.reduce((sum, entry) => sum + entry.bytes, 0);
    this.bytes -= bytes;
    return { droppedEvents: removed.length, droppedBytes: bytes };
  }

  private recordLoss(reason: RingBufferResult['reason'], droppedEvents: number, droppedBytes: number): RingBufferResult {
    this.lostEvents += droppedEvents;
    this.lostBytes += droppedBytes;
    return { reason, droppedEvents, droppedBytes };
  }

  private merge(a: RingBufferResult | null, b: RingBufferResult | null): RingBufferResult | null {
    if (!a) return b;
    if (!b) return a;
    const reason = a.reason === 'snapshot_too_large' || b.reason === 'snapshot_too_large' ? 'snapshot_too_large' :
      a.reason === 'baseline_lost' || b.reason === 'baseline_lost' ? 'baseline_lost' : 'event_dropped';
    return { reason, droppedEvents: a.droppedEvents + b.droppedEvents, droppedBytes: a.droppedBytes + b.droppedBytes };
  }
}
