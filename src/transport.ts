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

import type { ReplayIdentity, ReplaySegmentAllocation, ReplayStatus, ReplayStatusListener, ResolvedReplayConfig } from './types';
import { gzipSync } from 'fflate';
import { CompressionWorker } from './compression';
import { sanitizeMetadataValue, sanitizeReplayEvents, sanitizeReplayUrl } from './privacy';

// Retry delays in milliseconds: 1s, 2s, 4s
const RETRY_DELAYS = [1000, 2000, 4000];
const MAX_ATTEMPTS = 3;

// sendBeacon has a ~64KB payload limit
const BEACON_SIZE_LIMIT = 65536;

function utf8Size(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength; } catch { return 0; }
}

export class ReplayTransport {
  private pendingEvents: any[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private config: ResolvedReplayConfig;
  private compressionWorker: CompressionWorker;
  private bufferSize = 0;
  private recordingWindowStart: number | null = null;
  private recordingDeadlineFn: (() => number) | null = null;
  private allocateSegmentFn: (() => ReplaySegmentAllocation) | null = null;
  private identityFn: (() => ReplayIdentity) | null = null;
  private pendingIdentity: ReplayIdentity | null = null;
  private generation = 0;
  private activeRequests = new Set<AbortController>();
  private retryWaiters = new Map<ReturnType<typeof setTimeout>, (active: boolean) => void>();
  private cancelled = false;
  private activeCompressions = 0;
  private listeners = new Set<ReplayStatusListener>();
  private status: ReplayStatus = {
    state: 'idle',
    pendingBytes: 0,
    pendingEvents: 0,
    pendingChunks: 0,
    inflightPayloads: 0,
    inflightFetches: 0,
    acknowledgedChunks: 0,
    droppedChunks: 0,
    droppedEvents: 0,
    unknownChunks: 0,
    lastReason: null,
  };

  // Interaction counters (accumulated across all chunks)
  private clickCount = 0;
  private keypressCount = 0;

  // Getter functions wired by integration layer
  private sessionIdFn: (() => string) | null = null;
  private segmentIdFn: (() => number) | null = null;
  private replayTypeFn: (() => string) | null = null;
  private urlFn: (() => string) | null = null;
  private userIdFn: (() => string) | null = null;

  constructor(config: ResolvedReplayConfig, compressionWorker: CompressionWorker) {
    this.config = config;
    this.compressionWorker = compressionWorker;
  }

  getStatus(): ReplayStatus {
    return { ...this.status, pendingBytes: this.bufferSize, pendingEvents: this.pendingEvents.length, inflightFetches: this.activeRequests.size };
  }

  subscribeStatus(listener: ReplayStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  private publish(reason?: string): void {
    if (reason) this.status.lastReason = reason;
    const snapshot = this.getStatus();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* Observers cannot break capture. */ }
    }
  }

  private outcome(outcome: 'acknowledged' | 'dropped' | 'unknown', reason: string): void {
    if (outcome === 'acknowledged') this.status.acknowledgedChunks++;
    if (outcome === 'dropped') this.status.droppedChunks++;
    if (outcome === 'unknown') this.status.unknownChunks++;
    this.publish(reason);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the transport: begin 30-second flush interval.
   * Note: visibilitychange-based flushSync is handled by SessionManager's
   * pauseCallback to avoid duplicate flush calls on tab hide.
   */
  start(
    getSessionId: () => string,
    nextSegmentId: () => number,
    getReplayType: () => string,
    getUrl: () => string,
    getUserId: () => string,
    getRecordingDeadline?: () => number,
    allocateSegment?: () => ReplaySegmentAllocation,
    getIdentity?: () => ReplayIdentity,
  ): void {
    this.stop();
    this.cancel();
    this.sessionIdFn = getSessionId;
    this.segmentIdFn = nextSegmentId;
    this.replayTypeFn = getReplayType;
    this.urlFn = getUrl;
    this.userIdFn = getUserId;
    this.recordingDeadlineFn = getRecordingDeadline ?? null;
    this.allocateSegmentFn = allocateSegment ?? null;
    this.identityFn = getIdentity ?? null;
    this.cancelled = false;
    this.status.state = 'recording';
    this.publish('started');

    // Start periodic flush at config.flushInterval (default 30s)
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {
        // Never crash -- flush errors are swallowed
      });
    }, this.config.flushInterval);
  }

  /**
   * Stop the transport: clear flush interval.
   */
  stop(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Destroy the transport: stop + clear all pending events.
   */
  destroy(): void {
    this.stop();
    this.cancel();
  }

  /** Invalidate asynchronous work and discard all local pending data. */
  cancel(): void {
    this.generation += 1;
    this.cancelled = true;
    this.pendingEvents = [];
    this.bufferSize = 0;
    this.recordingWindowStart = null;
    this.pendingIdentity = null;
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    for (const [timer, resolve] of this.retryWaiters) {
      clearTimeout(timer);
      this.retryWaiters.delete(timer);
      resolve(false);
    }
    this.status.state = 'stopped';
    this.publish('cancelled');
  }

  /** Start a visible recorder interval. Hidden time never belongs to a chunk. */
  startRecordingWindow(): void {
    this.recordingWindowStart = Date.now();
  }

  /** Close the interval before stopping, hiding, or changing session identity. */
  stopRecordingWindow(): void {
    this.appendRecordingBoundaries();
    this.recordingWindowStart = null;
  }

  private appendRecordingBoundaries(): void {
    if (this.recordingWindowStart === null) return;
    const mode = this.replayTypeFn?.() ?? 'session';
    // Error-only recording must not upload until the error buffer is released.
    if (mode !== 'session' && this.pendingEvents.length === 0) return;
    const deadline = this.recordingDeadlineFn?.() ?? Date.now();
    const end = Math.min(Date.now(), deadline);
    const start = Math.min(this.recordingWindowStart, end);
    const boundary = (kind: string, timestamp: number) => ({
      type: 5, timestamp,
      data: { tag: 'tracekit.recording-boundary', payload: { kind } },
    });
    this.enqueuePendingEvent(boundary('start', start), true, false);
    this.enqueuePendingEvent(boundary('end', end), false, false);
    this.recordingWindowStart = end;
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
      if (this.cancelled) return;
      const safeEvent = sanitizeReplayEvents([event], { unmask: this.config.unmask, blockMedia: this.config.blockMedia })[0];
      if (!safeEvent) return;
      event = safeEvent;
      if (this.pendingEvents.length === 0 && this.identityFn) {
        this.pendingIdentity = this.identityFn();
      }
      // An error buffer begins at its oldest retained event, not recorder start.
      if (this.pendingEvents.length === 0 && this.replayTypeFn?.() === 'buffer' &&
          Number.isFinite(event.timestamp)) {
        this.recordingWindowStart = event.timestamp;
      }
      // Count mouse clicks (rrweb IncrementalSnapshot=3, MouseInteraction=2, Click=2)
      if (event.type === 3 && event.data?.source === 2 && event.data?.type === 2) {
        this.clickCount++;
      }
      // Count keypresses (rrweb IncrementalSnapshot=3, Input=5)
      if (event.type === 3 && event.data?.source === 5) {
        this.keypressCount++;
      }

      this.enqueuePendingEvent(event);
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

  private enqueuePendingEvent(event: any, prepend = false, evictAge = true): void {
    const bytes = utf8Size(event);
    if (bytes <= 0) return;
    if (bytes > this.config.maxBufferSize) {
      this.status.droppedEvents++;
      this.publish('snapshot_too_large');
      if (event?.type === 2) {
        this.pendingEvents = [];
        this.bufferSize = 0;
      }
      return;
    }
    if (prepend) this.pendingEvents.unshift(event);
    else this.pendingEvents.push(event);
    this.bufferSize += bytes;
    if (evictAge) this.evictPendingAge();
    this.enforcePendingBounds();
  }

  private evictPendingAge(): void {
    const cutoff = Date.now() - this.config.maxBufferAgeMs;
    while (this.pendingEvents.length > 0 && Number(this.pendingEvents[0]?.timestamp ?? Date.now()) < cutoff) {
      const dropped = this.pendingEvents.shift();
      this.bufferSize -= utf8Size(dropped);
      this.status.droppedEvents++;
    }
    this.removePendingOrphans();
  }

  private enforcePendingBounds(): void {
    while (this.pendingEvents.length > this.config.maxBufferEvents || this.bufferSize > this.config.maxBufferSize) {
      if (this.pendingEvents.length <= 1) {
        this.pendingEvents = [];
        this.bufferSize = 0;
        this.status.droppedEvents++;
        this.publish('snapshot_too_large');
        return;
      }
      const dropped = this.pendingEvents.shift();
      this.bufferSize -= utf8Size(dropped);
      this.status.droppedEvents++;
      this.publish('queue_limit');
    }
  }

  private removePendingOrphans(): void {
    const snapshot = this.pendingEvents.findIndex((event) => event?.type === 2);
    if (snapshot > 0) {
      const removed = this.pendingEvents.splice(0, snapshot);
      this.bufferSize -= removed.reduce((total, event) => total + utf8Size(event), 0);
      this.status.droppedEvents += removed.length;
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
    const generation = this.generation;
    if (this.cancelled) return;
    this.appendRecordingBoundaries();
    if (this.pendingEvents.length === 0) {
      return;
    }

    if (this.activeCompressions >= 4) {
      this.status.droppedEvents += this.pendingEvents.length;
      this.pendingEvents = [];
      this.bufferSize = 0;
      this.outcome('dropped', 'compression_queue_limit');
      return;
    }

    // Swap buffer atomically
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.bufferSize = 0;
    const pendingIdentity = this.pendingIdentity;
    this.pendingIdentity = null;

    this.activeCompressions++;
    try {
      if (!this.isCurrent(generation)) return;
      const allocation = this.allocateSegmentFn?.() ?? {
        sessionId: this.sessionIdFn ? this.sessionIdFn() : '',
        segmentId: this.segmentIdFn ? this.segmentIdFn() : 0,
        mode: this.replayTypeFn?.() ?? 'session',
        userId: this.userIdFn?.() ?? '',
      };
      const { sessionId, segmentId } = allocation;

      if (!sessionId) {
        return; // No session -- discard events
      }
      if (pendingIdentity && (pendingIdentity.sessionId !== allocation.sessionId || pendingIdentity.userId !== allocation.userId)) {
        return; // Do not attribute events across an identity boundary.
      }

      const safeEvents = sanitizeReplayEvents(events, { unmask: this.config.unmask, blockMedia: this.config.blockMedia });
      if (safeEvents.length === 0) return;

      if (safeEvents.length > this.config.maxChunkEvents) {
        this.outcome('dropped', 'chunk_event_limit');
        return;
      }

      const headers = this.uploadHeaders(segmentId, allocation.userId, allocation.mode);

      // Compress via worker (or main-thread fallback)
      const { compressed, originalSize } = await this.compressionWorker.compress(safeEvents, segmentId);
      if (!this.isCurrent(generation)) return;

      if (compressed.byteLength > this.config.maxChunkBytes) {
        this.outcome('dropped', 'chunk_byte_limit');
        return;
      }

      // Upload with retry
      const outcome = await this.uploadWithRetry(sessionId, compressed, originalSize, headers, generation);
      this.outcome(outcome.state, outcome.reason);
      if (!this.isCurrent(generation)) return;
    } catch {
      this.outcome('dropped', 'flush_error');
    } finally {
      this.activeCompressions--;
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
    const generation = this.generation;
    if (this.cancelled) return;
    this.appendRecordingBoundaries();
    if (this.pendingEvents.length === 0) {
      return;
    }

    try {
      const events = this.pendingEvents;
      this.pendingEvents = [];
      this.bufferSize = 0;
      const pendingIdentity = this.pendingIdentity;
      this.pendingIdentity = null;

      const allocation = this.allocateSegmentFn?.() ?? {
        sessionId: this.sessionIdFn ? this.sessionIdFn() : '',
        segmentId: this.segmentIdFn ? this.segmentIdFn() : 0,
        mode: this.replayTypeFn?.() ?? 'session',
        userId: this.userIdFn?.() ?? '',
      };
      const { sessionId, segmentId, mode: replayType } = allocation;

      if (!sessionId) {
        this.outcome('dropped', 'missing_session');
        return;
      }
      if (pendingIdentity && (pendingIdentity.sessionId !== allocation.sessionId || pendingIdentity.userId !== allocation.userId)) {
        this.outcome('dropped', 'identity_changed');
        return;
      }

      const safeEvents = sanitizeReplayEvents(events, { unmask: this.config.unmask, blockMedia: this.config.blockMedia });
      if (safeEvents.length === 0 || !this.isCurrent(generation)) {
        this.outcome('dropped', 'cancelled');
        return;
      }
      if (safeEvents.length > this.config.maxChunkEvents) {
        this.outcome('dropped', 'chunk_event_limit');
        return;
      }

      // Compress on main thread (sync -- sendBeacon requires sync data)
      const json = JSON.stringify(safeEvents);
      const encoded = new TextEncoder().encode(json);
      const compressed = gzipSync(encoded, { level: 6 });

      if (compressed.byteLength > this.config.maxChunkBytes) {
        this.outcome('dropped', 'chunk_byte_limit');
        return;
      }

      // Build URL with query parameters (sendBeacon cannot set custom headers)
      const replayUrl = sanitizeReplayUrl(this.urlFn ? this.urlFn() : '');
      const replayUserId = sanitizeMetadataValue(allocation.userId);
      const serviceName = this.boundedServiceName();
      const url =
        `${this.config.endpoint}/api/replays/${sessionId}/chunks` +
        `?api_key=${encodeURIComponent(this.config.apiKey)}` +
        `&segment_id=${segmentId}` +
        `&original_size=${encoded.length}` +
        `&replay_type=${replayType}` +
        `&replay_url=${encodeURIComponent(replayUrl)}` +
        `&replay_user_id=${encodeURIComponent(replayUserId)}` +
        (serviceName ? `&replay_service_name=${encodeURIComponent(serviceName)}` : '') +
        `&click_count=${this.clickCount}` +
        `&keypress_count=${this.keypressCount}`;

      // Cast through ArrayBuffer to satisfy TypeScript 5.x Uint8Array<ArrayBufferLike> vs BlobPart
      const blob = new Blob([compressed as unknown as BlobPart], { type: 'application/octet-stream' });

      if (!this.isCurrent(generation)) return;

      // Try sendBeacon first (works during page unload)
      if (compressed.byteLength <= BEACON_SIZE_LIMIT && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        const sent = navigator.sendBeacon(url, blob);
        if (sent) {
          this.outcome('unknown', 'beacon_queued');
          return;
        }
      }

      // Fallback: fetch with keepalive (also has ~64KB limit but is the standard approach)
      if (typeof fetch !== 'undefined') {
        if (!this.isCurrent(generation)) return;
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
        this.outcome('unknown', 'beacon_fallback_queued');
        return;
      }
      this.outcome('dropped', 'beacon_unavailable');
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
    compressed: Uint8Array,
    originalSize: number,
    headers: Record<string, string>,
    generation: number,
  ): Promise<{ state: 'acknowledged' | 'dropped' | 'unknown'; reason: string }> {
    const url = `${this.config.endpoint}/api/replays/${sessionId}/chunks`;
    const startedAt = Date.now();
    this.status.inflightPayloads++;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (!this.isCurrent(generation)) {
        this.status.inflightPayloads--;
        return { state: 'unknown', reason: 'cancelled' };
      }
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (controller) this.activeRequests.add(controller);
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const request = fetch(url, {
          method: 'POST',
          headers: { ...headers, 'X-Original-Size': String(originalSize) },
          body: compressed as unknown as BodyInit,
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (controller) timeout = setTimeout(() => controller.abort(), this.config.fetchTimeoutMs);
        const response = await request;
        if (!this.isCurrent(generation)) {
          this.status.inflightPayloads--;
          return { state: 'unknown', reason: 'cancelled' };
        }

        if (response.ok) {
          this.status.inflightPayloads--;
          return { state: 'acknowledged', reason: 'acknowledged' };
        }

        // Non-retryable status codes -- abort immediately
        if (response.status === 400 || response.status === 401 || response.status === 413) {
          this.status.inflightPayloads--;
          return { state: 'dropped', reason: `http_${response.status}` };
        }

        if (response.status === 429) this.publish('rate_limited');

        // Retryable failure -- wait before next attempt
        if (attempt < MAX_ATTEMPTS - 1) {
          const retryAfter = response.status === 429 ? this.retryAfterMs(response) : RETRY_DELAYS[attempt];
          const remaining = this.config.retryMaxAgeMs - (Date.now() - startedAt);
          if (remaining <= 0 || !(await this.delay(Math.min(retryAfter, remaining), generation))) {
            this.status.inflightPayloads--;
            return { state: 'dropped', reason: response.status === 429 ? 'rate_limit_expired' : 'retry_expired' };
          }
        }
      } catch {
        if (!this.isCurrent(generation)) {
          this.status.inflightPayloads--;
          return { state: 'unknown', reason: 'cancelled' };
        }
        // Network error -- wait before retry
        if (attempt < MAX_ATTEMPTS - 1) {
          const remaining = this.config.retryMaxAgeMs - (Date.now() - startedAt);
          if (remaining <= 0 || !(await this.delay(Math.min(RETRY_DELAYS[attempt], remaining), generation))) {
            this.status.inflightPayloads--;
            return { state: 'dropped', reason: 'retry_expired' };
          }
        }
      } finally {
        if (timeout !== null) clearTimeout(timeout);
        if (controller) this.activeRequests.delete(controller);
      }
    }

    // All attempts exhausted -- drop chunk (replay data loss is acceptable)
    this.status.inflightPayloads--;
    return { state: 'dropped', reason: 'retry_exhausted' };
  }

  private retryAfterMs(response: Response): number {
    const value = response.headers.get('Retry-After');
    const seconds = value === null ? NaN : Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return RETRY_DELAYS[0];
    return Math.min(seconds * 1000, this.config.retryMaxAgeMs);
  }

  /** Capture metadata before compression or retries can cross a session boundary. */
  private uploadHeaders(segmentId: number, userId: string, replayType: string): Record<string, string> {
    const serviceName = this.boundedServiceName();
    return {
      'Content-Type': 'application/octet-stream',
      'X-API-Key': this.config.apiKey,
      'X-Segment-Id': String(segmentId),
      'X-Replay-Type': replayType,
      'X-Replay-Url': sanitizeReplayUrl(this.urlFn?.() ?? ''),
      'X-Replay-User-Id': sanitizeMetadataValue(userId),
      'X-Replay-User-Agent': sanitizeMetadataValue(typeof navigator !== 'undefined' ? navigator.userAgent : ''),
      'X-Click-Count': String(this.clickCount),
      'X-Keypress-Count': String(this.keypressCount),
      ...(serviceName ? { 'X-Replay-Service-Name': serviceName } : {}),
    };
  }

  /** Return only a bounded, non-control service discriminator for the server. */
  private boundedServiceName(): string {
    const serviceName = sanitizeMetadataValue(this.config.serviceName).trim();
    if (serviceName.length === 0 || serviceName.length > 255 || /[\u0000-\u001f\u007f]/.test(serviceName)) {
      return '';
    }
    return serviceName;
  }

  /**
   * Promise-based delay for retry backoff.
   */
  private delay(ms: number, generation: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.isCurrent(generation)) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        this.retryWaiters.delete(timer);
        resolve(this.isCurrent(generation));
      }, ms);
      this.retryWaiters.set(timer, resolve);
    });
  }

  private isCurrent(generation: number): boolean {
    return !this.cancelled && this.generation === generation;
  }
}
