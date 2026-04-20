/**
 * TraceKit Replay - Session Manager
 * @package @tracekit/replay
 *
 * Core orchestrator for recording lifecycle. Controls which sessions
 * get full recording vs error-only buffer capture, handles idle
 * timeouts with session renewal, and manages visibility-based
 * pause/resume.
 *
 * Sampling bands:
 *   [0, sessionSampleRate)                    -> mode = 'session' (full recording)
 *   [sessionSampleRate, session+error)        -> mode = 'buffer'  (error capture)
 *   [session+error, 1.0]                      -> mode = 'off'     (no recording)
 */

import type { ResolvedReplayConfig, SessionState, ReplayMode } from './types';
import { RingBuffer } from './buffer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_STORAGE_KEY = '__tracekit_replay_session';
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Generate a 32-character hex session ID.
 * Prefers crypto.randomUUID() where available, falls back to Math.random().
 */
function newSessionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
}

/**
 * Get or create a session ID, persisting in sessionStorage so it survives
 * full page reloads in server-rendered (non-SPA) apps.
 * Returns { sessionId, segmentId, isExisting }
 */
function getOrCreateSession(): { sessionId: string; segmentId: number; isExisting: boolean } {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw);
        const age = Date.now() - (stored.lastActivity || 0);
        if (age < SESSION_MAX_AGE_MS && stored.sessionId) {
          return { sessionId: stored.sessionId, segmentId: stored.segmentId || 0, isExisting: true };
        }
      }
    }
  } catch {
    // sessionStorage may be unavailable (private browsing, etc.)
  }
  return { sessionId: newSessionId(), segmentId: 0, isExisting: false };
}

/**
 * Persist session state to sessionStorage.
 */
function persistSession(state: SessionState): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
        sessionId: state.sessionId,
        segmentId: state.segmentId,
        lastActivity: state.lastActivity,
      }));
    }
  } catch {
    // Ignore storage errors
  }
}

/**
 * Make a sampling decision based on configured rates.
 */
function decideSamplingMode(config: ResolvedReplayConfig): ReplayMode {
  const rand = Math.random();
  if (rand < config.sessionSampleRate) {
    return 'session';
  }
  if (rand < config.sessionSampleRate + config.errorSampleRate) {
    return 'buffer';
  }
  return 'off';
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private state: SessionState;
  private config: ResolvedReplayConfig;
  private ringBuffer: RingBuffer;

  // Callbacks wired by integration layer
  private eventCallback: ((events: any[]) => void) | null = null;
  private flushCallback: (() => void) | null = null;
  private restartCallback: (() => void) | null = null;
  private pauseCallback: (() => void) | null = null;
  private resumeCallback: (() => void) | null = null;

  // Idle timeout handle
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Visibility change handler (stored for cleanup)
  private visibilityHandler: (() => void) | null = null;

  constructor(config: ResolvedReplayConfig) {
    this.config = config;
    this.ringBuffer = new RingBuffer(60_000);

    const existing = getOrCreateSession();
    const mode = existing.isExisting ? 'session' : decideSamplingMode(config);
    const now = Date.now();

    this.state = {
      sessionId: existing.sessionId,
      mode,
      startedAt: now,
      lastActivity: now,
      segmentId: existing.segmentId,
    };

    persistSession(this.state);
    this.resetIdleTimer();
    this.setupVisibilityListener();
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  /**
   * Process an incoming rrweb event.
   * - session mode: forward immediately via eventCallback
   * - buffer mode: add to ring buffer for error-triggered flush
   * - off mode: discard
   */
  onEvent(event: any, _isCheckout: boolean): void {
    this.state.lastActivity = Date.now();
    persistSession(this.state);
    this.resetIdleTimer();

    if (this.state.mode === 'session') {
      if (this.eventCallback) {
        try {
          this.eventCallback([event]);
        } catch {
          // Never crash the host app
        }
      }
    } else if (this.state.mode === 'buffer') {
      this.ringBuffer.add(event);
    }
    // mode === 'off': discard
  }

  /**
   * Handle an error event. For buffer-mode sessions:
   * 1. Flush all buffered events via eventCallback
   * 2. Switch to session mode (continue recording after error)
   *
   * Per LOCKED decision: error buffer operates ONLY for non-sampled
   * sessions in buffer mode.
   */
  onError(): void {
    if (this.state.mode === 'buffer' && this.ringBuffer.size > 0) {
      const events = this.ringBuffer.flush();
      if (this.eventCallback) {
        try {
          this.eventCallback(events);
        } catch {
          // Never crash the host app
        }
      }
      // Switch to full recording mode
      this.state.mode = 'session';
    }
    // session mode or off mode: no-op
  }

  // -------------------------------------------------------------------------
  // Callback setters
  // -------------------------------------------------------------------------

  /** Set callback that receives events for compression/upload */
  setEventCallback(cb: (events: any[]) => void): void {
    this.eventCallback = cb;
  }

  /** Set callback called on idle timeout to flush pending events */
  setFlushCallback(cb: () => void): void {
    this.flushCallback = cb;
  }

  /** Set callback called on idle timeout to restart recording with new snapshot */
  setRestartCallback(cb: () => void): void {
    this.restartCallback = cb;
  }

  /** Set callback called when tab goes hidden to pause recording */
  setPauseCallback(cb: () => void): void {
    this.pauseCallback = cb;
  }

  /** Set callback called when tab becomes visible to resume recording */
  setResumeCallback(cb: () => void): void {
    this.resumeCallback = cb;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Current session ID */
  getSessionId(): string {
    return this.state.sessionId;
  }

  /** Current recording mode */
  getMode(): ReplayMode {
    return this.state.mode;
  }

  /** Return and increment segment counter */
  nextSegmentId(): number {
    return this.state.segmentId++;
  }

  /** Get full session state */
  getState(): SessionState {
    return { ...this.state };
  }

  /**
   * Flush events from the ring buffer (buffer mode).
   * Session mode events are forwarded immediately, so returns [].
   */
  flush(): any[] {
    if (this.state.mode === 'buffer') {
      return this.ringBuffer.flush();
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Idle timeout
  // -------------------------------------------------------------------------

  /**
   * Reset the idle timeout. Called on every event and at construction.
   * When the timeout fires:
   * 1. Flush pending events for the old session
   * 2. Generate new session ID + reset state
   * 3. Make new sampling decision
   * 4. Trigger a new full snapshot via restartCallback
   */
  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.handleIdleTimeout();
    }, this.config.idleTimeout);
  }

  private handleIdleTimeout(): void {
    // 1. Flush pending events for old session
    if (this.flushCallback) {
      try {
        this.flushCallback();
      } catch {
        // Never crash the host app
      }
    }

    // 2. Generate new session ID and reset state
    const mode = decideSamplingMode(this.config);
    const now = Date.now();

    this.state = {
      sessionId: newSessionId(),
      mode,
      startedAt: now,
      lastActivity: now,
      segmentId: 0,
    };

    persistSession(this.state);

    // 3. Clear the ring buffer for the new session
    this.ringBuffer.clear();

    // 4. Trigger new full snapshot
    if (this.restartCallback) {
      try {
        this.restartCallback();
      } catch {
        // Never crash the host app
      }
    }
  }

  // -------------------------------------------------------------------------
  // Visibility handling
  // -------------------------------------------------------------------------

  /**
   * Pause recording when tab goes hidden, resume when visible.
   * Per LOCKED decision: recording pauses on hidden, resumes on visible.
   */
  private setupVisibilityListener(): void {
    if (typeof document === 'undefined') {
      return;
    }

    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        // Pause: flush pending events and stop recording
        if (this.pauseCallback) {
          try {
            this.pauseCallback();
          } catch {
            // Never crash the host app
          }
        }
      } else if (document.visibilityState === 'visible') {
        // Resume: restart recording with new full snapshot
        this.state.lastActivity = Date.now();
        this.resetIdleTimer();
        if (this.resumeCallback) {
          try {
            this.resumeCallback();
          } catch {
            // Never crash the host app
          }
        }
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Tear down the session manager: clear timers, remove listeners, clear buffer.
   */
  destroy(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    this.ringBuffer.clear();

    this.eventCallback = null;
    this.flushCallback = null;
    this.restartCallback = null;
    this.pauseCallback = null;
    this.resumeCallback = null;
  }
}
