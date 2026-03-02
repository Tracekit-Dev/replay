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

  /** Idle timeout in ms before session ends (default: 1800000 = 30 min) */
  idleTimeout?: number;

  /** Flush interval in ms (default: 30000 = 30s) */
  flushInterval?: number;

  /** Max buffer size in bytes (default: 10485760 = 10MB) */
  maxBufferSize?: number;
}

/** Fully resolved config with all defaults applied */
export interface ResolvedReplayConfig {
  sessionSampleRate: number;
  errorSampleRate: number;
  unmask: string[];
  idleTimeout: number;
  flushInterval: number;
  maxBufferSize: number;
  /** Inherited from BrowserClient */
  apiKey: string;
  /** Inherited from BrowserClient */
  endpoint: string;
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
