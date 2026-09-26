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

const STORAGE_PREFIX = '__tracekit_replay_session_v2_';
// PostgreSQL replay_chunks.segment_id is a signed INTEGER.
const MAX_SEGMENT_ID = 0x7fff_fffe;
const ID_PATTERN = /^[0-9a-f]{32}$/;

function verifiedReload(): boolean {
  if (typeof performance === 'undefined' || typeof location === 'undefined') return false;
  try {
    const entries = performance.getEntriesByType('navigation');
    if (entries.length !== 1) return false;
    const entry = entries[0] as PerformanceNavigationTiming;
    return entry.type === 'reload' && new URL(entry.name).href === new URL(location.href).href;
  } catch { return false; }
}

function sharedCounter(raw: string | null): { next: number; expiresAt: number } | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const item = value as { next?: unknown; expiresAt?: unknown };
    if (!Number.isSafeInteger(item.next) || (item.next as number) < 0 || (item.next as number) > MAX_SEGMENT_ID + 1) return null;
    if (!Number.isFinite(item.expiresAt) || (item.expiresAt as number) <= 0) return null;
    return { next: item.next as number, expiresAt: item.expiresAt as number };
  } catch { return null; }
}

function counterValue(next: number, idleTimeout: number): string {
  return JSON.stringify({ next, expiresAt: Date.now() + idleTimeout });
}

function cleanExpiredCounters(namespace: string): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(`${namespace}_`) && ID_PATTERN.test(key.slice(namespace.length + 1))) keys.push(key);
    }
    for (const key of keys) {
      const current = sharedCounter(localStorage.getItem(key));
      if (!current || current.expiresAt <= Date.now()) localStorage.removeItem(key);
    }
  } catch { /* Storage can be blocked; never depend on cleanup for identity safety. */ }
}

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

function validStored(value: unknown, config: ResolvedReplayConfig): value is SessionState {
  if (!value || typeof value !== 'object') return false;
  const item = value as SessionState;
  const age = Date.now() - item.lastActivity;
  return typeof item.sessionId === 'string' && ID_PATTERN.test(item.sessionId) && Number.isSafeInteger(item.segmentId) &&
    item.segmentId >= 0 && item.segmentId <= MAX_SEGMENT_ID &&
    (item.mode === 'session' || item.mode === 'buffer' || item.mode === 'off') &&
    Number.isFinite(item.lastActivity) && Number.isFinite(age) && age >= 0 && age < config.idleTimeout;
}

async function storageNamespace(config: ResolvedReplayConfig): Promise<string | null> {
  if (!config.apiKey || !config.serviceName || typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const endpoint = new URL(config.endpoint).href;
    const input = new TextEncoder().encode(JSON.stringify([endpoint, config.serviceName, config.apiKey]));
    const digest = await crypto.subtle.digest('SHA-256', input);
    return STORAGE_PREFIX + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
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
  private readyPromise: Promise<void>;
  private identityReady = false;
  private keepFreshForPageview = false;
  private storageKey: string | null = null;
  private releaseClaim: (() => void) | null = null;

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

    this.active = false;
    this.readyPromise = this.initializeIdentity();
  }

  /** Recording and segment allocation must wait for this ownership decision. */
  ready(): Promise<void> { return this.readyPromise; }

  /** Give an initial pageview a fresh ID without allowing an unsafe later restore. */
  getPageviewSessionId(): string {
    if (this.identityReady) return this.getSessionId();
    if (!this.state.sessionId || this.state.mode === 'off' || !this.isVisible()) return '';
    this.keepFreshForPageview = true;
    return this.state.sessionId;
  }

  private async initializeIdentity(): Promise<void> {
    const key = await storageNamespace(this.config);
    if (this.destroyed) return;
    if (key && typeof localStorage !== 'undefined') cleanExpiredCounters(key);
    if (!this.keepFreshForPageview && key && typeof sessionStorage !== 'undefined' && typeof navigator !== 'undefined' && navigator.locks) {
      try {
        const raw = sessionStorage.getItem(key);
        const stored: unknown = raw ? JSON.parse(raw) : null;
        if (verifiedReload() && validStored(stored, this.config) && await this.claim(key, stored.sessionId)) {
          const current = sharedCounter(localStorage.getItem(`${key}_${stored.sessionId}`));
          if (current?.next === stored.segmentId && current.expiresAt > Date.now()) {
            this.state = { ...stored, startedAt: Date.now(), lastActivity: Date.now() };
            this.storageKey = key;
          } else {
            this.releaseClaim?.();
            this.releaseClaim = null;
          }
        }
      } catch {
        this.releaseClaim?.();
        this.releaseClaim = null;
      }
      if (!this.storageKey && this.state.sessionId && await this.claim(key, this.state.sessionId)) {
        try {
          const counterKey = `${key}_${this.state.sessionId}`;
          if (localStorage.getItem(counterKey) === null) {
            const initial = counterValue(0, this.config.idleTimeout);
            localStorage.setItem(counterKey, initial);
            if (localStorage.getItem(counterKey) === initial) this.storageKey = key;
          }
        } catch { /* No shared counter means no reload continuity. */ }
        if (!this.storageKey) {
          this.releaseClaim?.();
          this.releaseClaim = null;
        }
      }
    }
    if (this.destroyed) return;
    this.identityReady = true;
    this.active = Boolean(this.state.sessionId) && this.isVisible();
    this.persistSession();
    if (this.active) this.resetIdleTimer();
    this.setupVisibilityListener();
    this.setupActivityListeners();
  }

  private async claim(key: string, id: string): Promise<boolean> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) return false;
    let resolveClaim!: (value: boolean) => void;
    let release!: () => void;
    let settled = false;
    let expired = false;
    const claimed = new Promise<boolean>((resolve) => { resolveClaim = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockName = `${key}_${id}`;
    const timeout = setTimeout(() => { expired = true; release(); resolveClaim(false); }, 1_000);
    try {
      void locks.request(lockName, { ifAvailable: true }, async (lock) => {
        if (!lock || this.destroyed || expired) { settled = true; resolveClaim(false); return; }
        settled = true;
        this.releaseClaim = release;
        resolveClaim(true);
        await held;
      }).catch(() => { if (!settled) resolveClaim(false); });
      return await claimed;
    } catch { return false; }
    finally { clearTimeout(timeout); }
  }

  private persistSession(): void {
    if (!this.storageKey || !this.releaseClaim || this.destroyed) return;
    try {
      const counterKey = `${this.storageKey}_${this.state.sessionId}`;
      const current = sharedCounter(localStorage.getItem(counterKey));
      if (current?.next !== this.state.segmentId || current.expiresAt <= Date.now()) return;
      localStorage.setItem(counterKey, counterValue(this.state.segmentId, this.config.idleTimeout));
      sessionStorage.setItem(this.storageKey, JSON.stringify({
        sessionId: this.state.sessionId, segmentId: this.state.segmentId,
        mode: this.state.mode, lastActivity: this.state.lastActivity,
      }));
    } catch { /* Future reloads will use fresh document IDs. */ }
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
      this.persistSession();
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
    if (!this.identityReady || this.destroyed) throw new Error('Replay identity is not ready');
    if (!this.state.sessionId || this.state.segmentId > MAX_SEGMENT_ID) {
      this.rotateIdentity();
      queueMicrotask(() => { if (!this.destroyed) this.restartCallback?.(); });
      throw new Error('Replay segment counter is unsafe');
    }
    const next = this.state.segmentId;
    if (this.storageKey) {
      try {
        const counterKey = `${this.storageKey}_${this.state.sessionId}`;
        const current = sharedCounter(localStorage.getItem(counterKey));
        if (current?.next !== next || current.expiresAt <= Date.now()) throw new Error('stale counter');
        localStorage.setItem(counterKey, counterValue(next + 1, this.config.idleTimeout));
        if (sharedCounter(localStorage.getItem(counterKey))?.next !== next + 1) throw new Error('counter write failed');
      } catch {
        this.rotateIdentity();
        queueMicrotask(() => { if (!this.destroyed) this.restartCallback?.(); });
        throw new Error('Replay segment counter freshness is unproven');
      }
    }
    this.state.segmentId++;
    this.persistSession();
    return next;
  }

  /** A new identity cannot reuse the previous document's segment sequence. */
  rotateIdentity(): void {
    if (this.storageKey) {
      try { sessionStorage.setItem(this.storageKey, ''); } catch { /* No persistent identity remains usable. */ }
      const counterKey = `${this.storageKey}_${this.state.sessionId}`;
      try { localStorage.removeItem(counterKey); }
      catch { try { localStorage.setItem(counterKey, 'invalid'); } catch { /* A later restore still requires lineage proof. */ } }
    }
    this.releaseClaim?.();
    this.releaseClaim = null;
    this.storageKey = null;
    const now = Date.now();
    this.state = { sessionId: newSessionId(), mode: decideSamplingMode(this.config), startedAt: now, lastActivity: now, segmentId: 0 };
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
      this.persistSession();
      this.resetIdleTimer();
      return false;
    }

    this.rotateIdentity();
    this.active = true;
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
    this.destroyed = true;
    this.releaseClaim?.();
    this.releaseClaim = null;
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
