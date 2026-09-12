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
function getOrCreateSession(config: ResolvedReplayConfig): { sessionId: string; segmentId: number; mode: ReplayMode; isExisting: boolean } {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw);
        const segmentId = stored.segmentId;
        const mode = stored.mode;
        const age = Date.now() - Number(stored.lastActivity);
        if (stored.sessionId && typeof stored.sessionId === 'string' &&
            Number.isInteger(segmentId) && segmentId >= 0 &&
            (mode === 'session' || mode === 'buffer' || mode === 'off') &&
            Number.isFinite(age) && age >= 0 && age < config.idleTimeout) {
          return { sessionId: stored.sessionId, segmentId, mode, isExisting: true };
        }
      }
    }
  } catch {
    // sessionStorage may be unavailable (private browsing, etc.)
  }
  return { sessionId: newSessionId(), segmentId: 0, mode: decideSamplingMode(config), isExisting: false };
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
        mode: state.mode,
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
  private idleStopCallback: (() => void) | null = null;
  private activityHandlers: Array<[string, (event: Event) => void]> = [];
  private active = true;

  // Idle timeout handle
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Visibility change handler (stored for cleanup)
  private visibilityHandler: (() => void) | null = null;

  constructor(config: ResolvedReplayConfig) {
    this.config = config;
    this.ringBuffer = new RingBuffer(60_000);

    const existing = getOrCreateSession(config);
    const mode = existing.mode;
    const now = Date.now();

    this.state = {
      sessionId: existing.sessionId,
      mode,
      startedAt: now,
      lastActivity: now,
      segmentId: existing.segmentId,
    };

    this.active = this.isVisible();
    persistSession(this.state);
    if (this.active) this.resetIdleTimer();
    this.setupVisibilityListener();
    this.setupActivityListeners();
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
    if (!this.active || !this.isVisible()) return;
    if (Date.now() - this.state.lastActivity >= this.config.idleTimeout) {
      this.handleIdleTimeout();
      return;
    }

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
    if (this.active && this.isVisible() && this.state.mode === 'buffer' && this.ringBuffer.size > 0) {
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
      persistSession(this.state);
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

  /** Set callback called before an idle-session flush. */
  setIdleStopCallback(cb: () => void): void {
    this.idleStopCallback = cb;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Current session ID */
  getSessionId(): string {
    return this.active && this.state.mode !== 'off' ? this.state.sessionId : '';
  }

  /** Return the retained identity needed while flushing an inactive session. */
  getFlushSessionId(): string { return this.state.sessionId; }

  isActive(): boolean { return this.active; }
  isVisible(): boolean { return typeof document === 'undefined' || document.visibilityState === 'visible'; }

  /** Current recording mode */
  getMode(): ReplayMode {
    return this.state.mode;
  }

  /** Return and increment segment counter */
  nextSegmentId(): number {
    const next = this.state.segmentId++;
    persistSession(this.state);
    return next;
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
    if (!this.active || Date.now() - this.state.lastActivity < this.config.idleTimeout) {
      if (this.active) this.resetIdleTimer();
      return;
    }

    this.idleTimer = null;
    // Stop the recorder before flushing the retained old identity.
    if (this.idleStopCallback) {
      try { this.idleStopCallback(); } catch { /* Never crash the host app */ }
    }
    if (this.flushCallback) {
      try {
        this.flushCallback();
      } catch {
        // Never crash the host app
      }
    }

    this.active = false;
    this.ringBuffer.clear();
  }

  private renewFromVisibleActivity(): boolean {
    if (!this.isVisible()) return false;
    const now = Date.now();
    if (this.active && now - this.state.lastActivity >= this.config.idleTimeout) {
      this.handleIdleTimeout();
    }
    if (this.active && now - this.state.lastActivity < this.config.idleTimeout) {
      this.state.lastActivity = now;
      persistSession(this.state);
      this.resetIdleTimer();
      return false;
    }

    this.state = { sessionId: newSessionId(), mode: decideSamplingMode(this.config), startedAt: now, lastActivity: now, segmentId: 0 };
    this.active = true;
    this.ringBuffer.clear();
    persistSession(this.state);
    this.resetIdleTimer();
    if (this.state.mode !== 'off' && this.restartCallback) {
      try { this.restartCallback(); } catch { /* Never crash the host app */ }
    }
    return true;
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
        this.ringBuffer.clear();
      } else if (document.visibilityState === 'visible') {
        const startedNewSession = this.renewFromVisibleActivity();
        if (!startedNewSession && this.active && this.state.mode !== 'off' && this.resumeCallback) {
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

  private setupActivityListeners(): void {
    if (typeof document === 'undefined') return;
    const names = ['pointerdown', 'pointerup', 'keydown', 'touchstart', 'touchend', 'wheel', 'click', 'input', 'change', 'submit'];
    for (const name of names) {
      const handler = (event: Event) => {
        if ((event as Event & { isTrusted?: boolean }).isTrusted === false) return;
        this.renewFromVisibleActivity();
      };
      document.addEventListener(name, handler, { capture: true, passive: true });
      this.activityHandlers.push([name, handler]);
    }
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

    if (typeof document !== 'undefined') {
      for (const [name, handler] of this.activityHandlers) document.removeEventListener(name, handler);
    }
    this.activityHandlers = [];

    this.ringBuffer.clear();

    this.eventCallback = null;
    this.flushCallback = null;
    this.restartCallback = null;
    this.pauseCallback = null;
    this.resumeCallback = null;
    this.idleStopCallback = null;
  }
}
