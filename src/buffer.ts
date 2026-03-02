/**
 * TraceKit Replay - Ring Buffer
 * @package @tracekit/replay
 *
 * Timestamp-based ring buffer for error-mode capture.
 * Maintains exactly 60 seconds of rrweb events, evicting expired
 * entries on every add(). On error, the buffer is flushed and
 * the session switches from 'buffer' to 'session' mode.
 */

export class RingBuffer {
  private events: Array<{ event: any; timestamp: number }> = [];
  private maxAgeMs: number;

  constructor(maxAgeMs: number = 60_000) {
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Add an event to the buffer. Uses `event.timestamp` from rrweb
   * (milliseconds since epoch), falling back to Date.now().
   * Evicts expired entries after each add.
   */
  add(event: any): void {
    this.events.push({ event, timestamp: event.timestamp ?? Date.now() });
    this.evictExpired();
  }

  /**
   * Flush all buffered events and clear the buffer.
   * Returns the raw rrweb events (unwrapped from the timestamp envelope).
   */
  flush(): any[] {
    const flushed = this.events.map((e) => e.event);
    this.events = [];
    return flushed;
  }

  /**
   * Discard all buffered events.
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Number of events currently in the buffer.
   */
  get size(): number {
    return this.events.length;
  }

  /**
   * Evict events older than maxAgeMs from the front of the buffer.
   */
  private evictExpired(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
      this.events.shift();
    }
  }
}
