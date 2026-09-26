/**
 * TraceKit Replay - Type Definitions
 * @package @tracekit/replay
 */

// ============================================================================
// Integration Interface
// ============================================================================

/**
 * Integration interface for addon packages.
 * Uses `any` for client parameter to avoid circular dependency with @tracekit/browser.
 */
export interface Integration {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  install(client: any): void;
  teardown?(): void;
}

/** Manual controls available on the Replay addon instance. */
export interface ReplayIntegration extends Integration {
  start(): void;
  stop(): void;
  flush(): void;
  getSessionId(): string;
  getStatus(): ReplayStatus;
  subscribeStatus(listener: (status: ReplayStatus) => void): () => void;
}

/** Aggregate diagnostics only. Never add URLs, identities, or recorded content. */
export interface ReplayStatus {
  captureState: 'recording' | 'buffering' | 'paused' | 'stopped' | 'disabled' | 'sampled_out' | 'failed';
  deliveryState: 'idle' | 'pending' | 'retrying' | 'degraded';
  reason: 'none' | 'snapshot_too_large' | 'queue_limit' | 'compression_failed' | 'compression_timeout' |
    'fetch_timeout' | 'retry_exhausted' | 'terminal_response' | 'beacon_unknown' | 'invalid_scope' |
    'missing_identity' | 'privacy_stop';
  queueBytes: number;
  queueEvents: number;
  queueChunks: number;
  acceptedEvents: number;
  acknowledgedChunks: number;
  queuedBeacons: number;
  retries: number;
  droppedEvents: number;
  droppedBytes: number;
  droppedChunks: number;
  lastAcknowledgedAt: number | null;
  compressionMode: 'worker' | 'fallback' | 'unknown';
}

// ============================================================================
// Replay Configuration
// ============================================================================

/** Developer-facing config (passed to replayIntegration()) */
export interface ReplayConfig {
  /** Session sample rate 0.0-1.0 (default: 0.1) */
  sessionSampleRate?: number;

  /** Error sample rate 0.0-1.0 (default: 0.0) */
  errorSampleRate?: number;

  /** CSS selectors to unmask (in addition to data-tracekit-unmask attribute) */
  unmask?: string[];

  /** Elements to block, in addition to data-tracekit-block and the media default. */
  block?: string[];

  /** Elements whose text stays masked, even inside an unmask target. */
  mask?: string[];

  /** Idle timeout in ms before session ends (default: 1800000 = 30 min) */
  idleTimeout?: number;

  /** Flush interval in ms (default: 30000 = 30s) */
  flushInterval?: number;

  /** Max buffer size in bytes (default: 24117248 = 23MB) */
  maxBufferSize?: number;

  /** Max retained rrweb events across pending delivery work (default: 10000). */
  maxEventCount?: number;

  /** Max pending event age in milliseconds (default: 120000). */
  maxBufferAgeMs?: number;

  /** Max retained delivery chunks (default: 4). */
  maxChunkCount?: number;

  /** Compression deadline in milliseconds (default: 5000). */
  compressionTimeoutMs?: number;

  /** Fetch deadline in milliseconds (default: 10000). */
  fetchTimeoutMs?: number;

  /** Maximum fetch attempts for one immutable chunk (default: 3). */
  maxRetryAttempts?: number;

  /** Maximum retry lifetime in milliseconds (default: 30000). */
  maxRetryAgeMs?: number;

  /** Initial retry delay in milliseconds (default: 1000). */
  retryBaseDelayMs?: number;

  /** Maximum retry delay in milliseconds (default: 8000). */
  maxBackoffMs?: number;

  /**
   * Inline images as base64 data URIs in the recording.
   * When true, images are captured and available during replay.
   * Increases payload size. (default: false)
   */
  inlineImages?: boolean;

  /**
   * Block media elements (img, video, canvas, svg, iframe) from recording.
   * When true, these elements are replaced with placeholders.
   * Set to false to capture media element structure (combine with inlineImages
   * to also capture image content). (default: true)
   */
  blockMedia?: boolean;
}

/** Fully resolved config with all defaults applied */
export interface ResolvedReplayConfig {
  sessionSampleRate: number;
  errorSampleRate: number;
  unmask: string[];
  block: string[];
  mask: string[];
  idleTimeout: number;
  flushInterval: number;
  maxBufferSize: number;
  maxEventCount: number;
  maxBufferAgeMs: number;
  maxChunkCount: number;
  compressionTimeoutMs: number;
  fetchTimeoutMs: number;
  maxRetryAttempts: number;
  maxRetryAgeMs: number;
  retryBaseDelayMs: number;
  maxBackoffMs: number;
  inlineImages: boolean;
  blockMedia: boolean;
  /** Inherited from BrowserClient */
  apiKey: string;
  /** Inherited from BrowserClient */
  endpoint: string;
  /** BrowserClient service name. It does not affect the fresh document identity. */
  serviceName?: string;
}

// ============================================================================
// Session State
// ============================================================================

/** Recording mode for the current session */
export type ReplayMode = 'session' | 'buffer' | 'off';

/** Session state tracking */
export interface SessionState {
  sessionId: string;
  mode: ReplayMode;
  startedAt: number;
  lastActivity: number;
  segmentId: number;
}

// ============================================================================
// Chunk / Transport Types
// ============================================================================

/** Chunk metadata for transport */
export interface ReplayChunk {
  sessionId: string;
  segmentId: number;
  compressed: Uint8Array;
  originalSize: number;
}
