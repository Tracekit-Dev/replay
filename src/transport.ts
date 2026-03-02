/**
 * TraceKit Replay - Transport Layer
 * @package @tracekit/replay
 *
 * Uploads compressed replay chunks to the server every 30 seconds.
 * Uses fetch with X-API-Key header for normal uploads, sendBeacon
 * with query-parameter API key for tab-close fallback.
 *
 * Retry: exponential backoff (1s, 2s, 4s) with max 3 attempts.
 * Non-retryable status codes: 400, 401, 413.
 * On final failure: drop the chunk (replay data loss is non-critical).
 *
 * SAFETY: All external calls (fetch, sendBeacon) are wrapped in try/catch.
 * The transport NEVER throws -- replay must never crash the host app.
 */

import type { ResolvedReplayConfig } from './types';
import { gzipSync } from 'fflate';
import { CompressionWorker } from './compression';

// Retry delays in milliseconds: 1s, 2s, 4s
const RETRY_DELAYS = [1000, 2000, 4000];
const MAX_ATTEMPTS = 3;

// sendBeacon has a ~64KB payload limit
const BEACON_SIZE_LIMIT = 65536;

export class ReplayTransport {
  private pendingEvents: any[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private config: ResolvedReplayConfig;
  private compressionWorker: CompressionWorker;
  private bufferSize = 0;

  // Getter functions wired by integration layer
  private sessionIdFn: (() => string) | null = null;
  private segmentIdFn: (() => number) | null = null;
  private replayTypeFn: (() => string) | null = null;

  // Visibility change handler (stored for cleanup)
  private visibilityHandler: (() => void) | null = null;

  constructor(config: ResolvedReplayConfig, compressionWorker: CompressionWorker) {
    this.config = config;
    this.compressionWorker = compressionWorker;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the transport: begin 30-second flush interval and register
   * visibilitychange listener for sendBeacon fallback on tab close.
   */
  start(
    getSessionId: () => string,
    nextSegmentId: () => number,
    getReplayType: () => string,
  ): void {
    this.sessionIdFn = getSessionId;
    this.segmentIdFn = nextSegmentId;
    this.replayTypeFn = getReplayType;

    // Start periodic flush at config.flushInterval (default 30s)
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {
        // Never crash -- flush errors are swallowed
      });
    }, this.config.flushInterval);

    // Register sendBeacon fallback for tab close
    if (typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          this.flushSync();
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  /**
   * Stop the transport: clear flush interval and remove listeners.
   */
  stop(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /**
   * Destroy the transport: stop + clear all pending events.
   */
  destroy(): void {
    this.stop();
    this.pendingEvents = [];
    this.bufferSize = 0;
  }

  // ---------------------------------------------------------------------------
  // Event accumulation
  // ---------------------------------------------------------------------------

  /**
   * Add a single rrweb event to the pending buffer.
   * If buffer exceeds maxBufferSize, oldest events are dropped.
   */
  addEvent(event: any): void {
    try {
      const eventSize = JSON.stringify(event).length;
      this.pendingEvents.push(event);
      this.bufferSize += eventSize;

      // Drop oldest events if buffer exceeds max size
      while (this.bufferSize > this.config.maxBufferSize && this.pendingEvents.length > 1) {
        const dropped = this.pendingEvents.shift();
        if (dropped) {
          try {
            this.bufferSize -= JSON.stringify(dropped).length;
          } catch {
            // Ignore sizing errors on drop
          }
        }
        if (this.config.maxBufferSize > 0) {
          console.warn('[TraceKit Replay] Buffer exceeded maxBufferSize, dropping oldest events');
        }
      }
    } catch {
      // Never crash the host app
    }
  }

  /**
   * Add multiple rrweb events at once (used for ring buffer flush-on-error).
   */
  addEvents(events: any[]): void {
    for (const event of events) {
      this.addEvent(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Flush (async -- normal upload path)
  // ---------------------------------------------------------------------------

  /**
   * Flush pending events: compress via worker and upload via fetch with retry.
   * Returns silently if no events are pending.
   */
  async flush(): Promise<void> {
    if (this.pendingEvents.length === 0) {
      return;
    }

    // Swap buffer atomically
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.bufferSize = 0;

    try {
      const sessionId = this.sessionIdFn ? this.sessionIdFn() : '';
      const segmentId = this.segmentIdFn ? this.segmentIdFn() : 0;

      if (!sessionId) {
        return; // No session -- discard events
      }

      // Compress via worker (or main-thread fallback)
      const { compressed, originalSize } = await this.compressionWorker.compress(events, segmentId);

      // Upload with retry
      await this.uploadWithRetry(sessionId, segmentId, compressed, originalSize);
    } catch {
      // Drop chunk on any unexpected error -- replay data loss is acceptable
    }
  }

  // ---------------------------------------------------------------------------
  // Flush sync (sendBeacon fallback for tab close)
  // ---------------------------------------------------------------------------

  /**
   * Synchronous flush for tab close -- uses sendBeacon.
   * Compresses on main thread with fflate gzipSync (sendBeacon must be sync).
   * Falls back to fetch with keepalive:true if sendBeacon fails.
   * If both fail, data is lost (acceptable for replay).
   */
  flushSync(): void {
    if (this.pendingEvents.length === 0) {
      return;
    }

    try {
      const events = this.pendingEvents;
      this.pendingEvents = [];
      this.bufferSize = 0;

      const sessionId = this.sessionIdFn ? this.sessionIdFn() : '';
      const segmentId = this.segmentIdFn ? this.segmentIdFn() : 0;
      const replayType = this.replayTypeFn ? this.replayTypeFn() : 'session';

      if (!sessionId) {
        return;
      }

      // Compress on main thread (sync -- sendBeacon requires sync data)
      const json = JSON.stringify(events);
      const encoded = new TextEncoder().encode(json);
      const compressed = gzipSync(encoded, { level: 6 });

      // Build URL with query parameters (sendBeacon cannot set custom headers)
      const url =
        `${this.config.endpoint}/api/replays/${sessionId}/chunks` +
        `?api_key=${encodeURIComponent(this.config.apiKey)}` +
        `&segment_id=${segmentId}` +
        `&original_size=${encoded.length}` +
        `&replay_type=${replayType}`;

      // Cast through ArrayBuffer to satisfy TypeScript 5.x Uint8Array<ArrayBufferLike> vs BlobPart
      const blob = new Blob([compressed as unknown as BlobPart], { type: 'application/octet-stream' });

      // Try sendBeacon first (works during page unload)
      if (compressed.byteLength <= BEACON_SIZE_LIMIT && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        const sent = navigator.sendBeacon(url, blob);
        if (sent) {
          return;
        }
      }

      // Fallback: fetch with keepalive (also has ~64KB limit but is the standard approach)
      if (typeof fetch !== 'undefined') {
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          body: blob,
          keepalive: true,
        }).catch(() => {
          // Data loss accepted -- replay is non-critical
        });
      }
    } catch {
      // Never crash the host app on tab close
    }
  }

  // ---------------------------------------------------------------------------
  // Upload with retry (exponential backoff)
  // ---------------------------------------------------------------------------

  /**
   * Upload compressed chunk via fetch with exponential backoff retry.
   * Retries up to 3 times with delays of 1s, 2s, 4s.
   * Non-retryable status codes (400, 401, 413) abort immediately.
   * On final failure: drop chunk silently.
   */
  private async uploadWithRetry(
    sessionId: string,
    segmentId: number,
    compressed: Uint8Array,
    originalSize: number,
  ): Promise<void> {
    const url = `${this.config.endpoint}/api/replays/${sessionId}/chunks`;
    const replayType = this.replayTypeFn ? this.replayTypeFn() : 'session';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-API-Key': this.config.apiKey,
            'X-Segment-Id': String(segmentId),
            'X-Original-Size': String(originalSize),
            'X-Replay-Type': replayType,
          },
          body: compressed as unknown as BodyInit,
          keepalive: true,
        });

        if (response.ok) {
          return; // Success
        }

        // Non-retryable status codes -- abort immediately
        if (response.status === 400 || response.status === 401 || response.status === 413) {
          return;
        }

        // Retryable failure -- wait before next attempt
        if (attempt < MAX_ATTEMPTS - 1) {
          await this.delay(RETRY_DELAYS[attempt]);
        }
      } catch {
        // Network error -- wait before retry
        if (attempt < MAX_ATTEMPTS - 1) {
          await this.delay(RETRY_DELAYS[attempt]);
        }
      }
    }

    // All attempts exhausted -- drop chunk (replay data loss is acceptable)
  }

  /**
   * Promise-based delay for retry backoff.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
