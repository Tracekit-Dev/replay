/** Privacy-gated Replay integration for @tracekit/browser. */
import type { ReplayConfig, ResolvedReplayConfig, ReplayIntegration } from './types';
import { resolveReplayConfig } from './config';
import { record } from 'rrweb';
import { startRecording } from './recorder';
import { SessionManager } from './session';
import { CompressionWorker } from './compression';
import { ReplayTransport } from './transport';

/** The host owns consent and reinitializes Browser after consent changes. */
export function replayIntegration(config: ReplayConfig = {}): ReplayIntegration {
  let client: any = null;
  let session: SessionManager | null = null;
  let worker: CompressionWorker | null = null;
  let transport: ReplayTransport | null = null;
  let stopRecorder: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let previousCapture: ((error: Error, context?: any) => string) | null = null;
  let captureWrapper: ((error: Error, context?: any) => string) | null = null;
  let generation = 0;
  let manuallyStopped = false;
  let missingBreadcrumbReported = false;
  let recorderFailureReported = false;

  const enabled = () => {
    try { return client?.getConfig()?.enabled !== false; }
    catch { return false; }
  };
  const current = (token: number) => token === generation && !manuallyStopped && !!session && enabled();
  const currentUserId = (): string => {
    try { return client?.getScope()?.getUser()?.id || ''; }
    catch { return ''; }
  };

  const closeRecorder = () => {
    const close = stopRecorder;
    stopRecorder = null;
    try { close?.(); } catch { /* Never crash the host */ }
    transport?.stopRecordingWindow();
  };

  const removeOwnedBridge = () => {
    try { unsubscribe?.(); } catch { /* Never crash the host */ }
    unsubscribe = null;
    if (client && captureWrapper && client.captureException === captureWrapper && previousCapture) {
      client.captureException = previousCapture;
    }
    captureWrapper = null;
    previousCapture = null;
  };

  const discard = () => {
    generation++;
    closeRecorder();
    removeOwnedBridge();
    transport?.destroy();
    worker?.destroy();
    session?.destroy();
    transport = null;
    worker = null;
    session = null;
  };

  const activate = () => {
    if (!client || !enabled() || session) return;
    const token = ++generation;
    try {
      const browserConfig = client.getConfig();
      const replayConfig: ResolvedReplayConfig = {
        ...resolveReplayConfig(config, browserConfig.apiKey, browserConfig.endpoint),
        serviceName: browserConfig.serviceName || '',
      };
      // Allocate synchronously. Browser's initial pageview reads this ID after install().
      const ownedSession = new SessionManager(replayConfig);
      session = ownedSession;
      try {
          worker = new CompressionWorker();
          transport = new ReplayTransport(replayConfig, worker);
          let recordingUserId = currentUserId();
          let rotatingUser = false;

          const beginRecorder = () => {
            if (!current(token) || !ownedSession.isActive() || !ownedSession.isVisible() || ownedSession.getMode() === 'off' || stopRecorder) return;
            if (currentUserId() !== recordingUserId) { boundary(); return; }
            transport?.startRecordingWindow();
            stopRecorder = startRecording(replayConfig, (event, checkout) => {
              if (!current(token) || rotatingUser || session !== ownedSession) return;
              if (currentUserId() !== recordingUserId) { boundary(); return; }
              ownedSession.onEvent(event, checkout);
            });
            if (!stopRecorder) {
              if (!recorderFailureReported) {
                recorderFailureReported = true;
                console.warn('[TraceKit Replay] Recorder startup failed; replay capture is disabled.');
              }
              discard();
            }
          };

          const boundary = () => {
            if (!current(token) || rotatingUser || currentUserId() === recordingUserId) return;
            rotatingUser = true;
            try {
              closeRecorder();
              void transport?.flush().catch(() => {});
              ownedSession.rotateIdentity();
              recordingUserId = currentUserId();
            } finally { rotatingUser = false; }
            beginRecorder();
          };

          ownedSession.setEventCallback((events) => {
            if (!current(token)) return;
            for (const event of events) transport?.addEvent(event);
          });
          ownedSession.setFlushCallback(() => { if (current(token)) void transport?.flush().catch(() => {}); });
          ownedSession.setRestartCallback(() => { if (current(token)) { closeRecorder(); beginRecorder(); } });
          ownedSession.setIdleStopCallback(() => { if (current(token)) closeRecorder(); });
          ownedSession.setPauseCallback(() => {
            if (!current(token)) return;
            closeRecorder();
            transport?.flushSync();
          });
          ownedSession.setResumeCallback(() => { if (current(token)) beginRecorder(); });

          previousCapture = client.captureException;
          const ownedPrevious = previousCapture;
          const ownedClient = client;
          captureWrapper = function (error: Error, context?: any): string {
            if (!current(token) || !ownedPrevious) return ownedPrevious?.call(ownedClient, error, context) ?? '';
            boundary();
            const replayId = ownedSession.getSessionId();
            const scope = ownedClient.getScope();
            const tags = scope.getTags?.() ?? {};
            const hadTag = Object.prototype.hasOwnProperty.call(tags, 'replay_id');
            const priorTag = tags.replay_id ?? '';
            const canRestoreTag = hadTag || typeof scope.removeTag === 'function';
            try {
              if (replayId && canRestoreTag) scope.setTag('replay_id', replayId);
              return ownedPrevious.call(ownedClient, error, context);
            } finally {
              if (replayId && canRestoreTag) {
                if (hadTag) scope.setTag('replay_id', priorTag);
                else scope.removeTag('replay_id');
              }
              if (current(token)) ownedSession.onError();
            }
          };
          client.captureException = captureWrapper;

          const scope = client.getScope();
          if (typeof scope.subscribeBreadcrumb === 'function') {
            unsubscribe = scope.subscribeBreadcrumb((crumb: any) => {
              if (!current(token)) return;
              try {
                if (crumb.type === 'http' || crumb.category?.startsWith('fetch') || crumb.category?.startsWith('xhr')) {
                  record.addCustomEvent('network-request', {
                    method: crumb.data?.method || 'GET', url: crumb.data?.url || crumb.message || '',
                    status: crumb.data?.status_code, duration: crumb.data?.duration,
                    error: crumb.data?.error, traceparent: crumb.data?.traceparent,
                  });
                } else if (crumb.type === 'console' || crumb.category?.startsWith('console.')) {
                  const payload: Record<string, unknown> = { level: crumb.category?.replace('console.', '') || 'log', message: crumb.message || '' };
                  if (crumb.data && Object.keys(crumb.data).length > 0) payload.data = crumb.data;
                  if ((crumb.category === 'console.error' || crumb.category === 'console.warn') && crumb.data?.stack) payload.stack = crumb.data.stack;
                  record.addCustomEvent('console-log', payload);
                }
              } catch { /* Never crash the host */ }
            });
          } else if (!missingBreadcrumbReported) {
            missingBreadcrumbReported = true;
            console.warn('[TraceKit Replay] Breadcrumb capture unavailable: Browser subscription bridge is missing.');
          }

          transport.start(
            () => ownedSession.getFlushSessionId(), () => ownedSession.nextSegmentId(),
            () => ownedSession.getMode(),
            () => typeof window !== 'undefined' ? window.location.href : '',
            () => recordingUserId,
            () => ownedSession.getState().lastActivity + replayConfig.idleTimeout,
          );
          beginRecorder();
        } catch (error) {
          if (token !== generation || session !== ownedSession) return;
          console.warn('[TraceKit Replay] Failed to initialize replay recording:', error);
          discard();
      }
    } catch (error) {
      console.warn('[TraceKit Replay] Failed to initialize replay recording:', error);
      discard();
    }
  };

  const integration: ReplayIntegration = {
    name: 'replay',
    install(browserClient: any): void {
      if (client && client !== browserClient) discard();
      client = browserClient;
      manuallyStopped = false;
      activate();
    },
    start(): void {
      if (!client || !enabled()) return;
      manuallyStopped = false;
      activate();
    },
    stop(): void {
      manuallyStopped = true;
      discard();
    },
    teardown(): void {
      manuallyStopped = true;
      discard();
      client = null;
    },
    flush(): void {
      if (!client || manuallyStopped || !enabled()) return;
      try { void transport?.flush().catch(() => {}); } catch { /* Never crash the host */ }
    },
    getSessionId(): string {
      return !manuallyStopped && enabled() ? session?.getPageviewSessionId() ?? '' : '';
    },
  };
  return integration;
}

export type { ReplayConfig, Integration, ReplayIntegration } from './types';
