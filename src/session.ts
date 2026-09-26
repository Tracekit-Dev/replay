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

// PostgreSQL replay_chunks.segment_id is a signed INTEGER.
const MAX_SEGMENT_ID = 0x7fff_fffe;

/**
 * Generate a 32-character hex session ID.
 * A cryptographic source is required because IDs are server object identities.
 */
function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').toLowerCase();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return '';
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
  private destroyed = false;

  // Idle timeout handle
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Visibility change handler (stored for cleanup)
  private visibilityHandler: (() => void) | null = null;

  constructor(config: ResolvedReplayConfig) {
    this.config = config;
    this.ringBuffer = new RingBuffer(60_000);

    const now = Date.now();

    this.state = {
      sessionId: newSessionId(),
      mode: decideSamplingMode(config),
      startedAt: now,
      lastActivity: now,
      segmentId: 0,
    };

    this.active = Boolean(this.state.sessionId) && this.isVisible();
    if (this.active) this.resetIdleTimer();
    this.setupVisibilityListener();
    this.setupActivityListeners();
  }

  /** Identity is ready synchronously. Keep this method for Integration callers. */
  ready(): Promise<void> { return Promise.resolve(); }

  /** The first automatic pageview uses the document's recording identity. */
  getPageviewSessionId(): string { return this.getSessionId(); }

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
    if (this.active && Date.now() - this.state.lastActivity >= this.config.idleTimeout) {
      this.handleIdleTimeout();
      return;
    }
    if (this.active && this.isVisible() && this.state.mode === 'buffer') {
      let events = this.ringBuffer.flush();
      // A delayed error can leave no usable baseline after stale eviction.
      // Start a fresh snapshot while still in buffer mode, then flush it.
      if (!events.some((event) => event?.type === 2)) {
        this.ringBuffer.clear();
        if (this.restartCallback) {
          try { this.restartCallback(); } catch { /* Never crash the host app */ }
        }
        events = this.ringBuffer.flush();
      }
      if (events.length > 0 && this.eventCallback) {
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

  /** Set callback called before an idle-session flush. */
  setIdleStopCallback(cb: () => void): void {
    this.idleStopCallback = cb;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Current session ID */
  getSessionId(): string {
    if (this.active && Date.now() - this.state.lastActivity >= this.config.idleTimeout) {
      this.handleIdleTimeout();
    }
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
    if (this.destroyed) throw new Error('Replay identity is not ready');
    if (!this.state.sessionId || !Number.isSafeInteger(this.state.segmentId) || this.state.segmentId < 0 || this.state.segmentId > MAX_SEGMENT_ID) {
      this.rotateIdentity();
      queueMicrotask(() => { if (!this.destroyed) this.restartCallback?.(); });
      throw new Error('Replay segment counter is unsafe');
    }
    const next = this.state.segmentId;
    this.state.segmentId++;
    return next;
  }

  /** A new identity cannot reuse the previous document's segment sequence. */
  rotateIdentity(): void {
    const now = Date.now();
    this.state = { sessionId: newSessionId(), mode: decideSamplingMode(this.config), startedAt: now, lastActivity: now, segmentId: 0 };
    this.active = Boolean(this.state.sessionId) && this.isVisible();
    this.ringBuffer.clear();
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
      this.resetIdleTimer();
      return false;
    }

    this.rotateIdentity();
    if (this.active) this.resetIdleTimer();
    if (this.active && this.state.mode !== 'off' && this.restartCallback) {
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
    this.destroyed = true;
    this.active = false;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (typeof document !== 'undefined') {
      for (const [name, handler] of this.activityHandlers) document.removeEventListener(name, handler, { capture: true });
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
