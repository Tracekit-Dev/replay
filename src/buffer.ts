/**
 * TraceKit Replay - bounded snapshot ring buffer.
 *
 * A retained region always starts with a full rrweb snapshot. Mutations before
 * the next snapshot are discarded when a byte, event, or age bound is hit.
 */

export interface RingBufferLimits {
  maxAgeMs: number;
  maxBytes: number;
  maxEvents: number;
}

export interface RingBufferStats {
  bytes: number;
  events: number;
  dropped: number;
  reason: string | null;
}

interface BufferedEvent {
  event: any;
  timestamp: number;
  bytes: number;
}

let DEFAULT_LIMITS: RingBufferLimits = {
  maxAgeMs: 60_000,
  maxBytes: 24_117_248,
  maxEvents: 10_000,
};

/** Configure the numeric constructor used by the session manager. */
export function configureRingBufferDefaults(limits: Partial<RingBufferLimits> & {
  maxBufferSize?: number;
  maxBufferEvents?: number;
}): void {
  const maxAgeMs = Number(limits.maxAgeMs);
  const maxBytes = Number(limits.maxBytes ?? (limits as Partial<RingBufferLimits> & { maxBufferSize?: number }).maxBufferSize);
  const maxEvents = Number(limits.maxEvents ?? (limits as Partial<RingBufferLimits> & { maxBufferEvents?: number }).maxBufferEvents);
  DEFAULT_LIMITS = {
    ...DEFAULT_LIMITS,
    ...(Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? { maxAgeMs } : {}),
    ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
    ...(Number.isFinite(maxEvents) && maxEvents > 0 ? { maxEvents: Math.floor(maxEvents) } : {}),
  } as RingBufferLimits;
}

function utf8Size(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength;
  } catch {
    return 0;
  }
}

function isSnapshot(event: any): boolean {
  return event?.type === 2;
}

export class RingBuffer {
  private events: BufferedEvent[] = [];
  private limits: RingBufferLimits;
  private byteSize = 0;
  private droppedCount = 0;
  private lastReason: string | null = null;
  private awaitingSnapshot = false;

  constructor(maxAgeMsOrLimits: number | Partial<RingBufferLimits> = DEFAULT_LIMITS.maxAgeMs) {
    this.limits = typeof maxAgeMsOrLimits === 'number'
      ? { ...DEFAULT_LIMITS, maxAgeMs: maxAgeMsOrLimits }
      : { ...DEFAULT_LIMITS, ...maxAgeMsOrLimits };
  }

  add(event: any): boolean {
    const timestamp = Number.isFinite(event?.timestamp) ? Number(event.timestamp) : Date.now();
    const bytes = utf8Size(event);
    if (bytes <= 0) return false;

    if (this.awaitingSnapshot && !isSnapshot(event)) {
      this.droppedCount++;
      if (this.lastReason !== 'snapshot_too_large') this.lastReason = 'missing_snapshot';
      return false;
    }
    if (isSnapshot(event) && bytes > this.limits.maxBytes) {
      this.clear();
      this.awaitingSnapshot = true;
      this.droppedCount++;
      this.lastReason = 'snapshot_too_large';
      return false;
    }

    if (isSnapshot(event)) {
      this.awaitingSnapshot = false;
      this.lastReason = null;
    }
    this.events.push({ event, timestamp, bytes });
    this.byteSize += bytes;
    this.evictExpired();
    this.enforceBounds();
    return true;
  }

  flush(): any[] {
    this.evictExpired();
    this.enforceBounds();
    const firstSnapshot = this.events.findIndex((entry) => isSnapshot(entry.event));
    if (firstSnapshot < 0) {
      this.clear();
      this.awaitingSnapshot = true;
      return [];
    }
    if (firstSnapshot > 0) this.removeBefore(firstSnapshot);
    const flushed = this.events.map((entry) => entry.event);
    this.clear();
    return flushed;
  }

  clear(): void {
    this.events = [];
    this.byteSize = 0;
  }

  get size(): number {
    return this.events.length;
  }

  get stats(): RingBufferStats {
    return {
      bytes: this.byteSize,
      events: this.events.length,
      dropped: this.droppedCount,
      reason: this.lastReason,
    };
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.limits.maxAgeMs;
    let removed = 0;
    while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
      this.removeFirst();
      removed++;
    }
    if (removed > 0) {
      this.droppedCount += removed;
      this.lastReason = 'age_limit';
      this.removeOrphanMutations();
    }
  }

  private enforceBounds(): void {
    while (this.events.length > this.limits.maxEvents || this.byteSize > this.limits.maxBytes) {
      const latestSnapshot = this.findLastSnapshot();
      if (latestSnapshot < 0) {
        this.clear();
        this.awaitingSnapshot = true;
        this.droppedCount++;
        this.lastReason = 'missing_snapshot';
        return;
      }
      const snapshot = this.events[latestSnapshot];
      if (snapshot.bytes > this.limits.maxBytes) {
        this.clear();
        this.awaitingSnapshot = true;
        this.droppedCount++;
        this.lastReason = 'snapshot_too_large';
        return;
      }
      if (latestSnapshot > 0) this.removeBefore(latestSnapshot);
      if (this.events.length > this.limits.maxEvents || this.byteSize > this.limits.maxBytes) {
        const index = this.events.findIndex((entry, offset) => offset > 0 && !isSnapshot(entry.event));
        if (index < 0) break;
        this.removeAt(index);
        this.droppedCount++;
        this.lastReason = 'queue_limit';
      }
    }
  }

  private removeOrphanMutations(): void {
    const firstSnapshot = this.events.findIndex((entry) => isSnapshot(entry.event));
    if (firstSnapshot < 0) {
      this.clear();
      this.awaitingSnapshot = true;
      return;
    }
    if (firstSnapshot > 0) this.removeBefore(firstSnapshot);
  }

  private findLastSnapshot(): number {
    for (let index = this.events.length - 1; index >= 0; index--) {
      if (isSnapshot(this.events[index].event)) return index;
    }
    return -1;
  }

  private removeBefore(index: number): void {
    const removed = this.events.splice(0, index);
    this.byteSize -= removed.reduce((total, entry) => total + entry.bytes, 0);
    this.droppedCount += removed.length;
  }

  private removeFirst(): void {
    const entry = this.events.shift();
    if (entry) this.byteSize -= entry.bytes;
  }

  private removeAt(index: number): void {
    const [entry] = this.events.splice(index, 1);
    if (entry) this.byteSize -= entry.bytes;
  }
}
