/**
 * TraceKit Replay - Transport Layer
 * @package @tracekit/replay
 *
 * Uploads compressed replay chunks to the server every 30 seconds.
 * Uses fetch with X-API-Key header for normal uploads, sendBeacon
 * with query-parameter API key for tab-close fallback.
 *
 * Retry: bounded exponential backoff with finite count and age.
 * Terminal client responses are never retried.
 * On final failure: drop the chunk (replay data loss is non-critical).
 *
 * SAFETY: All external calls (fetch, sendBeacon) are wrapped in try/catch.
 * The transport NEVER throws -- replay must never crash the host app.
 */

import type { ReplayStatus, ResolvedReplayConfig } from './types';
import { gzipSync } from 'fflate';
import { CompressionWorker } from './compression';
import { ReplayPrivacySanitizer, sanitizeReplayUrl } from './privacy';

// sendBeacon has a ~64KB payload limit
const BEACON_SIZE_LIMIT = 65536;
const FALLBACK_INPUT_LIMIT = 4 * 1024 * 1024;
const REPORTED_DROP_LIMIT = 1_000_000;
const textEncoder = new TextEncoder();

function serializedSize(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function isFullSnapshot(event: any): boolean { return event?.type === 2; }
function isDOMMutation(event: any): boolean { return event?.type === 3 && event?.data?.source === 0; }

interface FrozenTerminal {
  sessionId: string;
  body: Uint8Array;
  originalSize: number;
  rawBytes: number;
  events: number;
  headers: Record<string, string>;
  done: Promise<void>;
  resolve: () => void;
}

// A service name is only a lookup hint. The server makes the scope decision.
function boundedServiceName(name: string | undefined): string | null {
  if (name === undefined || name === '') return '';
  const value = name.trim();
  if (!value || new TextEncoder().encode(value).byteLength > 255 || /\p{Cc}/u.test(value)) {
    return null;
  }
  return value;
}

export class ReplayTransport {
  private pendingEvents: any[] = [];
  private pendingTimes: number[] = [];
  private pendingSessionId = '';
  private frozenTerminal: FrozenTerminal | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private config: ResolvedReplayConfig;
  private compressionWorker: CompressionWorker;
  private bufferSize = 0;
  private activeRawBytes = 0;
  private activeCompressedBytes = 0;
  private activeEvents = 0;
  private activeFlush: Promise<void> | null = null;
  private activeStartedAt = 0;
  private activeSessionId = '';
  private reportingSessionId = '';
  private dropBaselineTotal = 0;
  private needsSnapshot = false;
  private snapshotRequested = false;
  private requestSnapshot: (() => void) | null = null;
  private failureCallback: (() => void) | null = null;
  private recordingWindowStart: number | null = null;
  private recordingDeadlineFn: (() => number) | null = null;
  private generation = 0;
  private destroyed = false;
  private abortController = new AbortController();
  private sanitizer: ReplayPrivacySanitizer;
  private status: ReplayStatus = {
    captureState: 'recording', deliveryState: 'idle', reason: 'none', queueBytes: 0,
    queueEvents: 0, queueChunks: 0, acceptedEvents: 0, acknowledgedChunks: 0,
    queuedBeacons: 0, retries: 0, droppedEvents: 0, droppedBytes: 0,
    droppedChunks: 0, lastAcknowledgedAt: null, compressionMode: 'unknown',
  };
  private statusListeners = new Set<(status: ReplayStatus) => void>();
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.sanitizer = new ReplayPrivacySanitizer(config);
  }

  /** A controlled checkout is requested once after a lost baseline. */
  setSnapshotRequest(callback: () => void): void { this.requestSnapshot = callback; }
  setFailureCallback(callback: () => void): void { this.failureCallback = callback; }

  /** Stop capture when a baseline cannot fit the error history. */
  failSnapshotTooLarge(): void {
    this.dropPending('snapshot_too_large');
    this.status.captureState = 'failed';
    this.status.reason = 'snapshot_too_large';
    this.publishStatus();
    this.failureCallback?.();
  }

  getStatus(): ReplayStatus {
    return { ...this.status, queueBytes: this.totalBytes(),
      queueEvents: this.pendingEvents.length + this.activeEvents + (this.frozenTerminal?.events ?? 0),
      queueChunks: Number(this.pendingEvents.length > 0) + Number(this.activeFlush !== null) +
        Number(this.frozenTerminal !== null),
    };
  }

  /** Include bounded error-history loss in later immutable chunk evidence. */
  recordDroppedEvents(events: number, bytes: number): void {
    if (this.destroyed) return;
    if (!Number.isFinite(events) || !Number.isFinite(bytes) || events <= 0 || bytes < 0) return;
    try { this.setSessionIdentity(this.sessionIdFn?.() ?? ''); } catch { /* Keep diagnostics isolated. */ }
    this.status.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, this.status.droppedEvents + Math.floor(events));
    this.status.droppedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.status.droppedBytes + Math.floor(bytes));
    this.status.reason = 'queue_limit';
    this.publishStatus();
  }

  /** Reset only upload evidence when a new recording identity begins. */
  setSessionIdentity(sessionId: string): void {
    if (!sessionId || sessionId === this.reportingSessionId) return;
    if (this.pendingEvents.length && this.pendingSessionId && this.pendingSessionId !== sessionId) {
      this.dropPendingForOldIdentity();
    }
    this.reportingSessionId = sessionId;
    this.dropBaselineTotal = this.status.droppedEvents;
    this.clickCount = 0;
    this.keypressCount = 0;
  }

  private reportedDrops(): string {
    return String(Math.min(REPORTED_DROP_LIMIT,
      Math.max(0, Math.floor(this.status.droppedEvents - this.dropBaselineTotal))));
  }

  subscribeStatus(listener: (status: ReplayStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private totalBytes(): number {
    return this.bufferSize + this.activeRawBytes + this.activeCompressedBytes +
      (this.frozenTerminal?.body.byteLength ?? 0);
  }

  private publishStatus(): void {
    if (this.statusTimer !== null || this.statusListeners.size === 0) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      const current = this.getStatus();
      for (const listener of this.statusListeners) {
        try { listener(current); } catch { /* Diagnostics never affect capture. */ }
      }
    }, 250);
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
  ): void {
    this.sessionIdFn = getSessionId;
    this.segmentIdFn = nextSegmentId;
    this.replayTypeFn = getReplayType;
    this.urlFn = getUrl;
    this.userIdFn = getUserId;
    this.recordingDeadlineFn = getRecordingDeadline ?? null;
    try { this.setSessionIdentity(getSessionId()); } catch { /* Identity is checked during flush. */ }

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
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    this.abortController.abort();
    this.stop();
    this.pendingEvents = [];
    this.pendingTimes = [];
    this.pendingSessionId = '';
    this.frozenTerminal?.resolve();
    this.frozenTerminal = null;
    this.bufferSize = 0;
    this.activeRawBytes = 0;
    this.activeCompressedBytes = 0;
    this.activeEvents = 0;
    this.activeFlush = null;
    this.recordingWindowStart = null;
    this.sanitizer.clear();
    this.requestSnapshot = null;
    this.failureCallback = null;
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.statusListeners.clear();
    this.status.captureState = 'stopped';
    this.status.deliveryState = 'idle';
    this.status.reason = 'privacy_stop';
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
    const first = boundary('start', start);
    const last = boundary('end', end);
    const firstBytes = serializedSize(first);
    const lastBytes = serializedSize(last);
    if (this.totalBytes() + firstBytes + lastBytes <= this.config.maxBufferSize &&
        this.pendingEvents.length + this.activeEvents + 2 <= this.config.maxEventCount) {
      if (this.pendingEvents.length === 0) this.pendingSessionId = this.sessionIdFn?.() ?? '';
      this.pendingEvents.unshift(first);
      this.pendingTimes.unshift(Date.now());
      this.pendingEvents.push(last);
      this.pendingTimes.push(Date.now());
      this.bufferSize += firstBytes + lastBytes;
    }
    this.recordingWindowStart = end;
  }

  // ---------------------------------------------------------------------------
  // Event accumulation
  // ---------------------------------------------------------------------------

  /** Keep no dependent mutations after an event or region is lost. */
  private dropPending(reason: ReplayStatus['reason']): void {
    if (this.pendingEvents.length === 0) return;
    this.status.droppedEvents += this.pendingEvents.length;
    this.status.droppedBytes += this.bufferSize;
    this.pendingEvents = [];
    this.pendingTimes = [];
    this.pendingSessionId = '';
    this.bufferSize = 0;
    this.needsSnapshot = true;
    this.status.reason = reason;
    this.requestFreshSnapshot();
    this.publishStatus();
  }

  /** A rotated identity cannot inherit an older recording's pending events. */
  private dropPendingForOldIdentity(): void {
    if (!this.pendingEvents.length) return;
    this.status.droppedEvents += this.pendingEvents.length;
    this.status.droppedBytes += this.bufferSize;
    this.status.droppedChunks++;
    this.status.reason = 'queue_limit';
    this.status.deliveryState = 'degraded';
    this.pendingEvents = [];
    this.pendingTimes = [];
    this.pendingSessionId = '';
    this.bufferSize = 0;
    this.publishStatus();
  }

  private requestFreshSnapshot(): void {
    if (this.snapshotRequested || !this.requestSnapshot || this.destroyed || this.status.captureState === 'failed') return;
    this.snapshotRequested = true;
    queueMicrotask(() => {
      if (!this.destroyed && this.needsSnapshot && this.status.captureState !== 'failed') {
        if (this.getStatus().queueChunks >= this.config.maxChunkCount) {
          this.snapshotRequested = false;
          return;
        }
        try { this.requestSnapshot?.(); } catch { /* Keep capture isolated. */ }
      }
    });
  }

  private expirePending(): void {
    if (this.pendingTimes.length > 0 && this.pendingTimes[0] < Date.now() - this.config.maxBufferAgeMs) {
      this.dropPending('queue_limit');
    }
  }

  /** Add one sanitized event within the aggregate serialized-byte budget. */
  addEvent(event: any): void {
    if (this.destroyed || this.status.captureState === 'failed') return;
    try {
      this.setSessionIdentity(this.sessionIdFn?.() ?? '');
      this.expirePending();
      const safe = this.sanitizer.sanitize(event);
      if (!safe) return;
      event = safe;
      const eventSize = serializedSize(event);
      if (!Number.isSafeInteger(eventSize)) return;
      if (eventSize > this.config.maxBufferSize) {
        this.status.droppedEvents++;
        this.status.droppedBytes += eventSize;
        if (isFullSnapshot(event)) {
          this.dropPending('snapshot_too_large');
          this.status.captureState = 'failed';
          this.status.reason = 'snapshot_too_large';
          this.failureCallback?.();
        } else {
          this.status.reason = 'queue_limit';
        }
        this.publishStatus();
        return;
      }
      if (isDOMMutation(event) && this.needsSnapshot) {
        this.status.droppedEvents++;
        this.status.droppedBytes += eventSize;
        this.publishStatus();
        return;
      }
      if (this.totalBytes() + eventSize > this.config.maxBufferSize ||
          this.pendingEvents.length + this.activeEvents + (this.frozenTerminal?.events ?? 0) + 1 > this.config.maxEventCount ||
          (this.pendingEvents.length === 0 && Number(this.activeFlush !== null) + Number(this.frozenTerminal !== null) >= this.config.maxChunkCount)) {
        this.dropPending('queue_limit');
      }
      if (this.totalBytes() + eventSize > this.config.maxBufferSize ||
          this.pendingEvents.length + this.activeEvents + (this.frozenTerminal?.events ?? 0) + 1 > this.config.maxEventCount ||
          (this.pendingEvents.length === 0 && Number(this.activeFlush !== null) + Number(this.frozenTerminal !== null) >= this.config.maxChunkCount)) {
        this.status.droppedEvents++;
        this.status.droppedBytes += eventSize;
        this.status.reason = 'queue_limit';
        this.needsSnapshot = true;
        this.requestFreshSnapshot();
        this.publishStatus();
        return;
      }
    if (isDOMMutation(event) && this.needsSnapshot) {
      this.status.droppedEvents++;
      this.status.droppedBytes += eventSize;
      this.publishStatus();
      return;
    }
      if (isFullSnapshot(event)) {
        this.needsSnapshot = false;
        this.snapshotRequested = false;
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

      this.pendingEvents.push(event);
      this.pendingTimes.push(Date.now());
      if (this.pendingEvents.length === 1) this.pendingSessionId = this.sessionIdFn?.() ?? '';
      this.bufferSize += eventSize;
      this.status.acceptedEvents++;
      this.publishStatus();
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
  async flush(final = false): Promise<void> {
    if (this.destroyed) return;
    if (this.activeFlush && !final) return this.activeFlush;
    const generation = this.generation;
    this.appendRecordingBoundaries();
    this.expirePending();
    if (this.activeFlush) return this.freezeTerminalChunk();
    if (this.pendingEvents.length === 0) {
      return;
    }
    const events = this.pendingEvents;
    const rawBytes = this.bufferSize;
    this.pendingEvents = [];
    this.pendingTimes = [];
    this.pendingSessionId = '';
    this.bufferSize = 0;
    this.activeRawBytes = rawBytes;
    this.activeEvents = events.length;
    this.activeStartedAt = Date.now();
    this.status.deliveryState = 'pending';
    this.publishStatus();
    let finish!: () => void;
    const job = new Promise<void>((resolve) => { finish = resolve; });
    this.activeFlush = job;
    void (async () => {
    try {
      const sessionId = this.sessionIdFn ? this.sessionIdFn() : '';
      this.setSessionIdentity(sessionId);
      this.activeSessionId = sessionId;
      const segmentId = this.segmentIdFn ? this.segmentIdFn() : 0;

      if (!sessionId) {
        this.dropActive('missing_identity');
        return;
      }

      // An invalid configured claim must not become a legacy upload.
      if (boundedServiceName(this.config.serviceName) === null) {
        this.dropActive('invalid_scope');
        return;
      }

      const headers = this.uploadHeaders(segmentId, final, this.reportedDrops());
      this.status.compressionMode = this.compressionWorker.getMode?.() ?? 'unknown';
      const { compressed, originalSize } = await this.compressionWorker.compress(
        events, segmentId, { timeoutMs: this.config.compressionTimeoutMs, maxInputBytes: this.config.maxBufferSize },
      );
      if (this.destroyed || generation !== this.generation) return;
      this.status.compressionMode = this.compressionWorker.getMode?.() ?? 'unknown';
      if (compressed.byteLength > this.config.maxBufferSize - this.bufferSize - this.activeRawBytes) {
        this.dropActive('queue_limit');
        return;
      }
      this.activeCompressedBytes = compressed.byteLength;
      this.publishStatus();
      await this.uploadWithRetry(sessionId, compressed, originalSize, headers, generation);
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        this.dropActive(error instanceof Error && error.message.includes('timeout')
          ? 'compression_timeout' : 'compression_failed');
      }
    } finally {
      if (generation === this.generation) {
        this.activeRawBytes = 0;
        this.activeCompressedBytes = 0;
        this.activeEvents = 0;
        this.activeStartedAt = 0;
        this.activeSessionId = '';
        if (this.activeFlush === job) this.activeFlush = null;
        if (this.status.deliveryState !== 'degraded') this.status.deliveryState = this.pendingEvents.length ? 'pending' : 'idle';
        if (this.frozenTerminal && !this.destroyed) this.runFrozenTerminal(this.frozenTerminal, generation);
        if (this.needsSnapshot) this.requestFreshSnapshot();
        this.publishStatus();
      }
    }
    })().then(finish, finish);
    return job;
  }

  /** Freeze a known final segment before its recording identity can rotate. */
  private freezeTerminalChunk(): Promise<void> {
    if (this.frozenTerminal) {
      this.dropPendingForOldIdentity();
      return this.frozenTerminal.done;
    }
    if (!this.pendingEvents.length) return this.activeFlush ?? Promise.resolve();
    if (this.config.maxChunkCount < 2 || this.bufferSize > FALLBACK_INPUT_LIMIT) {
      this.dropPendingForOldIdentity();
      return this.activeFlush ?? Promise.resolve();
    }
    try {
      const sessionId = this.pendingSessionId || this.sessionIdFn?.() || '';
      if (!sessionId || boundedServiceName(this.config.serviceName) === null) {
        this.dropPendingForOldIdentity();
        return this.activeFlush ?? Promise.resolve();
      }
      const segmentId = this.segmentIdFn?.() ?? 0;
      const encoded = textEncoder.encode(JSON.stringify(this.pendingEvents));
      if (encoded.byteLength > FALLBACK_INPUT_LIMIT) {
        this.dropPendingForOldIdentity();
        return this.activeFlush ?? Promise.resolve();
      }
      const body = gzipSync(encoded, { level: 6 });
      if (this.activeRawBytes + this.activeCompressedBytes + body.byteLength > this.config.maxBufferSize) {
        this.dropPendingForOldIdentity();
        return this.activeFlush ?? Promise.resolve();
      }
      const headers = this.uploadHeaders(segmentId, true, this.reportedDrops());
      const rawBytes = this.bufferSize;
      const events = this.pendingEvents.length;
      let resolve!: () => void;
      const done = new Promise<void>((finish) => { resolve = finish; });
      this.frozenTerminal = { sessionId, body, originalSize: encoded.byteLength,
        rawBytes, events, headers, done, resolve };
      this.pendingEvents = [];
      this.pendingTimes = [];
      this.pendingSessionId = '';
      this.bufferSize = 0;
      this.publishStatus();
      return done;
    } catch {
      this.dropPendingForOldIdentity();
      return this.activeFlush ?? Promise.resolve();
    }
  }

  /** Drain one already-frozen final chunk after the active chunk settles. */
  private runFrozenTerminal(terminal: FrozenTerminal, generation: number): void {
    if (this.frozenTerminal !== terminal || this.destroyed || generation !== this.generation) return;
    this.frozenTerminal = null;
    this.activeRawBytes = 0;
    this.activeCompressedBytes = terminal.body.byteLength;
    this.activeEvents = terminal.events;
    this.activeStartedAt = Date.now();
    this.activeSessionId = terminal.sessionId;
    this.status.deliveryState = 'pending';
    let finish!: () => void;
    const job = new Promise<void>((resolve) => { finish = resolve; });
    this.activeFlush = job;
    void this.uploadWithRetry(terminal.sessionId, terminal.body, terminal.originalSize,
      terminal.headers, generation).catch(() => {
      if (!this.destroyed && generation === this.generation) this.dropActive('retry_exhausted');
    }).finally(() => {
      if (generation === this.generation) {
        this.activeRawBytes = 0;
        this.activeCompressedBytes = 0;
        this.activeEvents = 0;
        this.activeStartedAt = 0;
        this.activeSessionId = '';
        if (this.activeFlush === job) this.activeFlush = null;
        if (this.status.deliveryState !== 'degraded') this.status.deliveryState = this.pendingEvents.length ? 'pending' : 'idle';
        if (this.needsSnapshot) this.requestFreshSnapshot();
        this.publishStatus();
      }
      terminal.resolve();
      finish();
    });
  }

  private dropActive(reason: ReplayStatus['reason']): void {
    const affectsCurrentIdentity = !this.activeSessionId || this.activeSessionId === this.reportingSessionId;
    this.status.droppedEvents += this.activeEvents;
    if (!affectsCurrentIdentity) {
      this.dropBaselineTotal += this.activeEvents;
    }
    this.status.droppedBytes += this.activeRawBytes || this.activeCompressedBytes;
    this.status.droppedChunks++;
    this.status.deliveryState = 'degraded';
    // A missing chunk can invalidate later mutations, even when an older snapshot exists.
    if (affectsCurrentIdentity) {
      this.needsSnapshot = true;
      this.dropPending('queue_limit');
      this.requestFreshSnapshot();
    }
    this.status.reason = reason;
    this.publishStatus();
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
  flushSync(final = false): void {
    if (this.destroyed) return;
    this.appendRecordingBoundaries();
    this.expirePending();
    if (this.activeFlush) {
      this.dropPending('queue_limit');
      return;
    }
    if (this.pendingEvents.length === 0) {
      return;
    }

    let retainedEvents = 0;
    let retainedBytes = 0;
    try {
      const events = this.pendingEvents;
      const rawBytes = this.bufferSize;
      retainedEvents = events.length;
      retainedBytes = rawBytes;
      this.pendingEvents = [];
      this.pendingTimes = [];
      this.bufferSize = 0;
      if (events.length === 0) return;

      const sessionId = this.sessionIdFn ? this.sessionIdFn() : '';
      this.setSessionIdentity(sessionId);
      const segmentId = this.segmentIdFn ? this.segmentIdFn() : 0;
      const replayType = this.replayTypeFn ? this.replayTypeFn() : 'session';
      const droppedEvents = this.reportedDrops();

      if (!sessionId) {
        this.recordSyncDrop(events.length, rawBytes, 'missing_identity');
        return;
      }

      if (boundedServiceName(this.config.serviceName) === null) {
        this.recordSyncDrop(events.length, rawBytes, 'invalid_scope');
        return;
      }

      // A synchronous fallback must not monopolize the host page.
      if (rawBytes > FALLBACK_INPUT_LIMIT || rawBytes + this.totalBytes() > this.config.maxBufferSize) {
        this.recordSyncDrop(events.length, rawBytes, 'queue_limit');
        return;
      }
      const json = JSON.stringify(events);
      const encoded = new TextEncoder().encode(json);
      if (encoded.byteLength > FALLBACK_INPUT_LIMIT) {
        this.recordSyncDrop(events.length, rawBytes, 'queue_limit');
        return;
      }
      const compressed = gzipSync(encoded, { level: 6 });
      if (compressed.byteLength > BEACON_SIZE_LIMIT || compressed.byteLength + this.totalBytes() > this.config.maxBufferSize) {
        this.recordSyncDrop(events.length, rawBytes, 'queue_limit');
        return;
      }

      // Build URL with query parameters (sendBeacon cannot set custom headers)
      const replayUrl = sanitizeReplayUrl(this.urlFn?.() ?? '');
      const replayUserId = '';
      const serviceName = boundedServiceName(this.config.serviceName);
      const url =
        `${this.config.endpoint}/api/replays/${sessionId}/chunks` +
        `?api_key=${encodeURIComponent(this.config.apiKey)}` +
        `&segment_id=${segmentId}` +
        `&original_size=${encoded.length}` +
        `&replay_type=${replayType}` +
        `&replay_url=${encodeURIComponent(replayUrl)}` +
        `&replay_user_id=${encodeURIComponent(replayUserId)}` +
        `&click_count=${this.clickCount}` +
        `&keypress_count=${this.keypressCount}` +
        `&protocol_version=1` +
        `&dropped_events=${droppedEvents}` +
        (final ? `&final_segment_id=${segmentId}` : '') +
        (serviceName ? `&service_name=${encodeURIComponent(serviceName)}` : '');

      // Cast through ArrayBuffer to satisfy TypeScript 5.x Uint8Array<ArrayBufferLike> vs BlobPart
      const blob = new Blob([compressed as unknown as BlobPart], { type: 'application/octet-stream' });

      // Try sendBeacon first (works during page unload)
      if (compressed.byteLength <= BEACON_SIZE_LIMIT && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        let sent = false;
        try { sent = navigator.sendBeacon(url, blob); } catch { /* Use bounded keepalive fallback. */ }
        if (sent) {
          this.status.queuedBeacons++;
          this.status.reason = 'beacon_unknown';
          this.publishStatus();
          return;
        }
      }

      // Fallback: fetch with keepalive (also has ~64KB limit but is the standard approach)
      if (typeof fetch !== 'undefined') {
        const controller = new AbortController();
        const abort = () => controller.abort();
        this.abortController.signal.addEventListener('abort', abort, { once: true });
        let rejectDeadline: (() => void) | null = null;
        const deadline = new Promise<never>((_resolve, reject) => {
          rejectDeadline = () => reject(new Error('Replay keepalive deadline'));
          controller.signal.addEventListener('abort', rejectDeadline, { once: true });
        });
        const timer = setTimeout(abort, this.config.fetchTimeoutMs);
        let fetchRequest: Promise<Response>;
        try { fetchRequest = fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          body: blob,
          keepalive: true,
          signal: controller.signal,
        }); } catch {
          clearTimeout(timer);
          if (rejectDeadline) controller.signal.removeEventListener('abort', rejectDeadline);
          this.abortController.signal.removeEventListener('abort', abort);
          this.recordSyncDrop(events.length, rawBytes, 'retry_exhausted');
          return;
        }
        const request = Promise.race([fetchRequest, deadline]);
        void request.then((response) => {
          if (this.destroyed) return;
          if (response.ok) {
            this.status.acknowledgedChunks++;
            this.status.lastAcknowledgedAt = Date.now();
          } else {
            this.recordSyncDrop(events.length, rawBytes, 'terminal_response');
          }
          this.publishStatus();
        }).catch(() => {
          if (this.destroyed) return;
          this.recordSyncDrop(events.length, rawBytes, 'retry_exhausted');
          this.publishStatus();
        }).finally(() => {
          clearTimeout(timer);
          if (rejectDeadline) controller.signal.removeEventListener('abort', rejectDeadline);
          this.abortController.signal.removeEventListener('abort', abort);
        });
      } else {
        this.recordSyncDrop(events.length, rawBytes, 'retry_exhausted');
      }
    } catch {
      // Never crash the host app on tab close
      this.recordSyncDrop(retainedEvents, retainedBytes, 'compression_failed');
    } finally {
      this.publishStatus();
    }
  }

  private recordSyncDrop(events: number, bytes: number, reason: ReplayStatus['reason']): void {
    this.status.droppedEvents += events;
    this.status.droppedBytes += bytes;
    this.status.droppedChunks++;
    this.status.reason = reason;
    this.status.deliveryState = 'degraded';
    this.needsSnapshot = true;
    this.requestFreshSnapshot();
    this.publishStatus();
  }

  // ---------------------------------------------------------------------------
  // Upload with retry (exponential backoff)
  // ---------------------------------------------------------------------------

  /** Retry one immutable compressed body within count and lifetime limits. */
  private async uploadWithRetry(
    sessionId: string,
    compressed: Uint8Array,
    originalSize: number,
    headers: Record<string, string>,
    generation: number,
  ): Promise<void> {
    const url = `${this.config.endpoint}/api/replays/${sessionId}/chunks`;
    for (let attempt = 0; attempt < this.config.maxRetryAttempts; attempt++) {
      if (this.destroyed || generation !== this.generation) return;
      if (Date.now() - this.activeStartedAt >= this.config.maxRetryAgeMs) break;
      const controller = new AbortController();
      const abort = () => controller.abort();
      this.abortController.signal.addEventListener('abort', abort, { once: true });
      let rejectDeadline: (() => void) | null = null;
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = () => reject(new Error('Replay fetch deadline'));
        controller.signal.addEventListener('abort', rejectDeadline, { once: true });
      });
      const timer = setTimeout(abort, Math.min(this.config.fetchTimeoutMs,
        this.config.maxRetryAgeMs - (Date.now() - this.activeStartedAt)));
      let retryAfter = 0;
      try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('offline');
        const response = await Promise.race([fetch(url, {
          method: 'POST',
          headers: { ...headers, 'X-Original-Size': String(originalSize) },
          body: compressed as unknown as BodyInit,
          signal: controller.signal,
        }), deadline]);
        if (this.destroyed || generation !== this.generation) return;

        if (response.ok) {
          this.status.acknowledgedChunks++;
          this.status.lastAcknowledgedAt = Date.now();
          this.status.reason = 'none';
          this.status.deliveryState = 'idle';
          this.publishStatus();
          return;
        }

        if (response.status !== 408 && response.status !== 429 && response.status < 500) {
          this.dropActive('terminal_response');
          return;
        }
        if (response.status === 429) {
          const value = response.headers?.get?.('Retry-After');
          const seconds = Number(value);
          if (value && Number.isFinite(seconds) && seconds >= 0) retryAfter = seconds * 1000;
          else if (value) {
            const date = Date.parse(value);
            if (Number.isFinite(date)) retryAfter = Math.max(0, date - Date.now());
          }
        }
      } catch {
        if (controller.signal.aborted && !this.abortController.signal.aborted) this.status.reason = 'fetch_timeout';
      } finally {
        clearTimeout(timer);
        if (rejectDeadline) controller.signal.removeEventListener('abort', rejectDeadline);
        this.abortController.signal.removeEventListener('abort', abort);
      }
      if (attempt < this.config.maxRetryAttempts - 1) {
        const remaining = this.config.maxRetryAgeMs - (Date.now() - this.activeStartedAt);
        if (remaining <= 0) break;
        // Never retry sooner than the server's explicit 429 delay.
        if (retryAfter > this.config.maxBackoffMs || retryAfter > remaining) break;
        const backoff = Math.min(this.config.maxBackoffMs,
          this.config.retryBaseDelayMs * 2 ** attempt);
        this.status.retries++;
        this.status.deliveryState = 'retrying';
        this.publishStatus();
        await this.delay(Math.min(this.config.maxBackoffMs, Math.max(backoff, retryAfter), remaining));
      }
    }
    if (!this.destroyed && generation === this.generation) this.dropActive('retry_exhausted');
  }

  /** Capture metadata before compression or retries can cross a session boundary. */
  private uploadHeaders(segmentId: number, final: boolean, droppedEvents: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-API-Key': this.config.apiKey,
      'X-Segment-Id': String(segmentId),
      'X-Replay-Type': this.replayTypeFn?.() ?? 'session',
      'X-Replay-Url': sanitizeReplayUrl(this.urlFn?.() ?? ''),
      'X-Replay-User-Id': '',
      'X-Click-Count': String(this.clickCount),
      'X-Keypress-Count': String(this.keypressCount),
      'X-Replay-Protocol-Version': '1',
      'X-Replay-Dropped-Events': droppedEvents,
    };
    if (final) headers['X-Replay-Final-Segment-Id'] = String(segmentId);
    const serviceName = boundedServiceName(this.config.serviceName);
    if (serviceName) headers['X-Replay-Service-Name'] = serviceName;
    return headers;
  }

  /**
   * Promise-based delay for retry backoff.
   */
  private delay(ms: number): Promise<void> {
    if (this.abortController.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = this.abortController.signal;
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
