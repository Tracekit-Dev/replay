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

import type { ResolvedReplayConfig, SessionState, ReplayIdentity, ReplayMode, ReplaySegmentAllocation } from './types';
import { RingBuffer } from './buffer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_STORAGE_PREFIX = '__tracekit_replay_session_v2';
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_SEGMENT_ID = Number.MAX_SAFE_INTEGER;

type StoredSession = SessionState & {
  ownerToken: string;
  documentToken: string;
  active: boolean;
  revoked?: boolean;
};
const DOCUMENT_TOKEN = randomHex(32);

function randomHex(length: number): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, length).padEnd(length, '0');
  }
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function namespaceDigest(value: string): string {
  // A stable digest keeps raw API keys, endpoints, and service names out of storage.
  // It namespaces client state; it does not grant server authorization.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function normalizedEndpoint(endpoint: string): string {
  try { return new URL(endpoint).origin; } catch { return endpoint.trim(); }
}

/** Return the versioned, credential-free storage key for a replay client. */
export function storageKeyForConfig(config: ResolvedReplayConfig): string {
  const scope = [normalizedEndpoint(config.endpoint), (config.serviceName ?? '').trim(), config.apiKey].join('\u0000');
  return `${SESSION_STORAGE_PREFIX}:${namespaceDigest(scope)}`;
}

/**
 * Generate a 32-character hex session ID.
 * Prefers crypto.randomUUID() where available, falls back to Math.random().
 */
function newSessionId(config: ResolvedReplayConfig): string {
  return `${namespaceDigest(`${normalizedEndpoint(config.endpoint)}\u0000${config.serviceName ?? ''}`).slice(0, 8)}${randomHex(24)}`;
}

/**
 * Get or create a session ID, persisting in sessionStorage so it survives
 * full page reloads in server-rendered (non-SPA) apps.
 * Returns { sessionId, segmentId, isExisting }
 */
function getOrCreateSession(config: ResolvedReplayConfig, ownerToken: string): { sessionId: string; segmentId: number; mode: ReplayMode; isExisting: boolean } {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(storageKeyForConfig(config));
      if (raw) {
        const stored = JSON.parse(raw);
        const segmentId = stored.segmentId;
        const mode = stored.mode;
        const age = Date.now() - Number(stored.lastActivity);
        if ((stored.ownerToken === ownerToken || (stored.documentToken === DOCUMENT_TOKEN && stored.active === false && stored.revoked !== true)) && SESSION_ID_PATTERN.test(stored.sessionId) &&
            Number.isSafeInteger(segmentId) && segmentId >= 0 && segmentId <= MAX_SEGMENT_ID &&
            (mode === 'session' || mode === 'buffer' || mode === 'off') &&
            Number.isFinite(age) && age >= 0 && age < config.idleTimeout) {
          return { sessionId: stored.sessionId, segmentId, mode, isExisting: true };
        }
      }
    }
  } catch {
    // sessionStorage may be unavailable (private browsing, etc.)
  }
  return { sessionId: newSessionId(config), segmentId: 0, mode: decideSamplingMode(config), isExisting: false };
}

/**
 * Persist session state to sessionStorage.
 */
function persistSession(state: SessionState, config: ResolvedReplayConfig, ownerToken: string, active = true, revoked = false): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const serialized = JSON.stringify({
        sessionId: state.sessionId,
        segmentId: state.segmentId,
        mode: state.mode,
        lastActivity: state.lastActivity,
        ownerToken,
        documentToken: DOCUMENT_TOKEN,
        active,
        revoked,
      });
      sessionStorage.setItem(storageKeyForConfig(config), serialized);
      // Older direct consumers may still inspect this key. Replay never reads it.
      // Resolved production configs always include serviceName, so this path is compatibility-only.
      if (config.serviceName === undefined) sessionStorage.setItem('__tracekit_replay_session', serialized);
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
  private userIdentityProvider: (() => string) | null = null;
  private identityUserId: string;
  private rotatingUserId: string | null = null;
  private readonly ownerToken = randomHex(32);
  private rotating = false;
  private activityHandlers: Array<[string, (event: Event) => void]> = [];
  private active = true;
  private manuallyStopped = false;
  private privacyRevoked = false;

  // Idle timeout handle
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Visibility change handler (stored for cleanup)
  private visibilityHandler: (() => void) | null = null;

  constructor(config: ResolvedReplayConfig) {
    this.config = config;
    this.ringBuffer = new RingBuffer(60_000);

    this.identityUserId = config.identityUserId ?? '';
    const existing = getOrCreateSession(config, this.ownerToken);
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
    persistSession(this.state, this.config, this.ownerToken);
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
    this.ensureIdentitySafety();
    if (this.manuallyStopped || !this.active || !this.isVisible()) return;
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
    this.ensureIdentitySafety();
    if (this.manuallyStopped) return;
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
      persistSession(this.state, this.config, this.ownerToken);
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

  /** Set a transient user boundary provider. User IDs never enter storage. */
  setUserIdentityProvider(provider: () => string): void {
    this.userIdentityProvider = provider;
    this.identityUserId = this.readUserIdentity();
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Current session ID */
  getSessionId(): string {
    this.ensureIdentitySafety();
    if (!this.manuallyStopped && this.active && Date.now() - this.state.lastActivity >= this.config.idleTimeout) {
      this.handleIdleTimeout();
    }
    return !this.manuallyStopped && this.active && this.state.mode !== 'off' ? this.state.sessionId : '';
  }

  /** Return the retained identity needed while flushing an inactive session. */
  getFlushSessionId(): string { return this.state.sessionId; }

  /** Return the identity that owns events currently entering transport. */
  getIdentity(): ReplayIdentity {
    this.ensureIdentitySafety();
    return {
      sessionId: this.state.sessionId,
      mode: this.state.mode,
      userId: this.rotatingUserId ?? this.identityUserId,
    };
  }

  isActive(): boolean { return this.active; }
  isVisible(): boolean { return typeof document === 'undefined' || document.visibilityState === 'visible'; }

  /** Current recording mode */
  getMode(): ReplayMode {
    return this.state.mode;
  }

  /** Return and increment segment counter */
  nextSegmentId(): number {
    this.ensureIdentitySafety();
    if (this.state.segmentId >= MAX_SEGMENT_ID) this.rotateIdentity();
    const next = this.state.segmentId++;
    persistSession(this.state, this.config, this.ownerToken);
    return next;
  }

  /** Allocate the session and segment identity as one synchronous ownership claim. */
  allocateSegment(): ReplaySegmentAllocation {
    this.ensureIdentitySafety();
    if (this.state.segmentId >= MAX_SEGMENT_ID) this.rotateIdentity();
    const allocation: ReplaySegmentAllocation = {
      sessionId: this.state.sessionId,
      segmentId: this.state.segmentId,
      mode: this.state.mode,
      userId: this.rotatingUserId ?? this.identityUserId,
    };
    this.state.segmentId += 1;
    persistSession(this.state, this.config, this.ownerToken);
    return allocation;
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
    persistSession(this.state, this.config, this.ownerToken, false);
  }

  private renewFromVisibleActivity(): boolean {
    this.ensureIdentitySafety();
    if (this.manuallyStopped) return false;
    if (!this.isVisible()) return false;
    const now = Date.now();
    if (this.active && now - this.state.lastActivity >= this.config.idleTimeout) {
      this.handleIdleTimeout();
    }
    if (this.active && now - this.state.lastActivity < this.config.idleTimeout) {
      this.state.lastActivity = now;
      persistSession(this.state, this.config, this.ownerToken);
      this.resetIdleTimer();
      return false;
    }

    this.state = { sessionId: newSessionId(this.config), mode: decideSamplingMode(this.config), startedAt: now, lastActivity: now, segmentId: 0 };
    this.active = true;
    this.ringBuffer.clear();
    persistSession(this.state, this.config, this.ownerToken);
    this.resetIdleTimer();
    if (this.state.mode !== 'off' && this.restartCallback) {
      try { this.restartCallback(); } catch { /* Never crash the host app */ }
    }
    return true;
  }

  private readUserIdentity(): string {
    try { return String(this.userIdentityProvider?.() ?? ''); } catch { return ''; }
  }

  private ensureIdentitySafety(): void {
    if (this.rotating || this.manuallyStopped) return;
    if (!this.active) return;
    const userIdentity = this.readUserIdentity();
    if (userIdentity !== this.identityUserId) {
      this.rotatingUserId = this.identityUserId;
      this.identityUserId = userIdentity;
      this.rotateIdentity();
      return;
    }

    try {
      if (typeof sessionStorage === 'undefined') return;
      const raw = sessionStorage.getItem(storageKeyForConfig(this.config));
      if (!raw) {
        this.rotateIdentity();
        return;
      }
      const stored = JSON.parse(raw) as Partial<StoredSession>;
      if (stored.ownerToken !== this.ownerToken || stored.documentToken !== DOCUMENT_TOKEN || stored.active !== true || !SESSION_ID_PATTERN.test(String(stored.sessionId ?? '')) ||
          !Number.isSafeInteger(stored.segmentId) || Number(stored.segmentId) < 0 || Number(stored.segmentId) > MAX_SEGMENT_ID) {
        this.rotateIdentity();
      }
    } catch {
      // Blocked storage cannot prove a competing owner. The random in-memory identity remains isolated.
    }
  }

  private rotateIdentity(): void {
    if (this.rotating) return;
    this.rotating = true;
    try {
      if (this.idleStopCallback) {
        try { this.idleStopCallback(); } catch { /* Never crash the host app */ }
      }
      if (this.flushCallback) {
        try { this.flushCallback(); } catch { /* Never crash the host app */ }
      }
      const now = Date.now();
      this.state = {
        sessionId: newSessionId(this.config),
        mode: decideSamplingMode(this.config),
        startedAt: now,
        lastActivity: now,
        segmentId: 0,
      };
      this.active = this.isVisible();
      this.ringBuffer.clear();
      persistSession(this.state, this.config, this.ownerToken);
      if (this.active) this.resetIdleTimer();

      // The old user marker applies only to the synchronous flush above.
      // Clear it before the restarted recorder can emit new events.
      this.rotatingUserId = null;

      if (this.active && this.state.mode !== 'off' && this.restartCallback) {
        try { this.restartCallback(); } catch { /* Never crash the host app */ }
      }
    } finally {
      this.rotatingUserId = null;
      this.rotating = false;
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

  private removeLifecycleListeners(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (typeof document !== 'undefined') {
      for (const [name, handler] of this.activityHandlers) {
        document.removeEventListener(name, handler, { capture: true });
      }
    }
    this.activityHandlers = [];
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

  /** Stop recording and remove lifecycle observers without destroying the manager. */
  stop(): void {
    this.manuallyStopped = true;
    this.privacyRevoked = true;
    this.active = false;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.removeLifecycleListeners();
    this.ringBuffer.clear();
    persistSession(this.state, this.config, this.ownerToken, false, true);
  }

  /** Start a stopped manager with a fresh identity and lifecycle observers. */
  start(): void {
    if (!this.manuallyStopped) return;
    this.manuallyStopped = false;
    this.privacyRevoked = false;
    const now = Date.now();
    this.state = {
      sessionId: newSessionId(this.config),
      mode: decideSamplingMode(this.config),
      startedAt: now,
      lastActivity: now,
      segmentId: 0,
    };
    this.active = this.isVisible();
    this.ringBuffer.clear();
    persistSession(this.state, this.config, this.ownerToken, this.active, false);
    this.setupVisibilityListener();
    this.setupActivityListeners();
    if (this.active) this.resetIdleTimer();
  }

  /**
   * Tear down the session manager: clear timers, remove listeners, clear buffer.
   */
  destroy(): void {
    this.manuallyStopped = true;
    this.active = false;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.removeLifecycleListeners();

    this.ringBuffer.clear();
    persistSession(this.state, this.config, this.ownerToken, false, this.privacyRevoked);

    this.eventCallback = null;
    this.flushCallback = null;
    this.restartCallback = null;
    this.pauseCallback = null;
    this.resumeCallback = null;
    this.idleStopCallback = null;
    this.userIdentityProvider = null;
  }
}
