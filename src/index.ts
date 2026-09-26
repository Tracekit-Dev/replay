/**
 * TraceKit Replay - Public API
 * @package @tracekit/replay
 *
 * Entry point for the session replay addon.
 * Provides replayIntegration() factory that returns an Integration object
 * compatible with @tracekit/browser's addons system.
 *
 * Usage:
 *   import { init } from '@tracekit/browser';
 *   import { replayIntegration } from '@tracekit/replay';
 *   init({ apiKey: 'key', addons: [replayIntegration()] });
 *
 * The integration wires together:
 *   recorder -> session manager -> compression worker -> transport
 *
 * Recording starts immediately when the integration is installed via init().
 * Manual control: start(), stop(), and flush() control the recording lifecycle.
 */

import type { ReplayConfig, ResolvedReplayConfig, Integration } from './types';
import { resolveReplayConfig } from './config';
import { record } from 'rrweb';
import { startRecording } from './recorder';
import { SessionManager } from './session';
import { CompressionWorker } from './compression';
import { ReplayTransport } from './transport';

/**
 * Create a session replay integration for @tracekit/browser.
 *
 * @param config - Optional replay configuration overrides
 * @returns Integration object with lifecycle, flush(), and getSessionId() methods
 */
export function replayIntegration(
  config: ReplayConfig = {},
): Integration & { start(): void; stop(): void; flush(): void; getSessionId(): string } {
  let session: SessionManager | null = null;
  let compressionWorker: CompressionWorker | null = null;
  let transport: ReplayTransport | null = null;
  let stopRecording: (() => void) | null = null;
  let resolvedConfig: ResolvedReplayConfig | null = null;
  let clientRef: any = null;
  let breadcrumbUnsubscribe: (() => void) | null = null;
  let restoreCaptureException: (() => void) | null = null;
  let manuallyStopped = false;
  let startRecordingPipeline: () => void = () => {};
  let stopRecordingPipeline: () => void = () => {};
  let installBreadcrumbBridge: () => void = () => {};
  const hostRecordingEnabled = (): boolean => clientRef?.getConfig?.().enabled !== false;

  const integration: Integration & { start(): void; stop(): void; flush(): void; getSessionId(): string } = {
    name: 'replay',

    /**
     * Install the replay integration into the BrowserClient.
     * Creates the full recording pipeline and starts recording immediately.
     *
     * ALL code is wrapped in try/catch -- if replay fails to initialize,
     * it MUST NOT break the host app or the core browser SDK.
     */
    install(client: any): void {
      try {
        // Resolve config with the client's credentials and service boundary.
        // The service name is a discriminator, not a new authorization boundary.
        const clientConfig = client.getConfig();
        clientRef = client;
        // The host enabled flag is the existing consent mechanism. Do not
        // create session storage, workers, timers, or subscriptions when it is off.
        if (clientConfig.enabled === false) {
          manuallyStopped = true;
          return;
        }
        manuallyStopped = false;
        const scope = client.getScope();
        let identityUserId = '';
        try { identityUserId = String(scope?.getUser?.()?.id ?? ''); } catch { identityUserId = ''; }
        resolvedConfig = resolveReplayConfig(
          config,
          clientConfig.apiKey,
          clientConfig.endpoint,
          typeof clientConfig.serviceName === 'string' ? clientConfig.serviceName : '',
          identityUserId,
        );

        // Create session manager (makes sampling decision)
        session = new SessionManager(resolvedConfig);
        session.setUserIdentityProvider(() => {
          try { return String(client.getScope()?.getUser?.()?.id ?? ''); } catch { return ''; }
        });

        startRecordingPipeline = () => {
          if (!hostRecordingEnabled() || manuallyStopped || !session || !resolvedConfig || !transport || !session.isActive() || !session.isVisible() || session.getMode() === 'off') return;
          if (stopRecording) return;
          transport!.startRecordingWindow();
          stopRecording = startRecording(resolvedConfig, (event, isCheckout) => {
            session?.onEvent(event, isCheckout);
          });
          if (!stopRecording) transport!.stopRecordingWindow();
        };
        stopRecordingPipeline = () => {
          if (stopRecording) {
            stopRecording();
            stopRecording = null;
          }
          transport?.stopRecordingWindow();
        };

        // Wire session -> transport: events flow from session to transport.
        session.setEventCallback((events: any[]) => {
          for (const event of events) {
            transport?.addEvent(event);
          }
        });

        // Wire error notification: hook into captureException to detect errors
        // for ring buffer flush. Also injects replay_id as a tag on the error event
        // so the playback UI can link errors to their replay session.
        // Uses setTag (not setExtra) so replay_id appears as a direct span attribute
        // in OTLP output -- extras would prefix it as "extra.replay_id".
        const originalCaptureException = client.captureException;
        if (typeof originalCaptureException === 'function') {
          const wrappedCaptureException = function (this: unknown, error: Error, context?: any): string {
            const replayId = session?.getSessionId() ?? '';
            const captureScope = client.getScope();
            const previousReplayTag = replayId ? (() => {
              try {
                const tags = captureScope?.getTags?.() ?? {};
                return {
                  present: Object.prototype.hasOwnProperty.call(tags, 'replay_id'),
                  value: typeof tags.replay_id === 'string' ? tags.replay_id : '',
                };
              } catch {
                return { present: false, value: '' };
              }
            })() : { present: false, value: '' };
            try {
              if (replayId) captureScope.setTag('replay_id', replayId);
              return originalCaptureException.call(this, error, context);
            } finally {
              if (replayId) {
                try {
                  captureScope.setTag('replay_id', previousReplayTag.present ? previousReplayTag.value : '');
                } catch { /* Host scope may be tearing down. */ }
              }
              session?.onError();
            }
          };
          client.captureException = wrappedCaptureException;
          restoreCaptureException = () => {
            // Preserve a wrapper installed by another addon after Replay.
            if (client.captureException === wrappedCaptureException) {
              client.captureException = originalCaptureException;
            }
          };
        }

        // Bridge breadcrumbs to rrweb custom events for playback sidebar tabs.
        // Network requests become 'network-request' events, console output becomes
        // 'console-log' events -- both timestamped in the rrweb event stream.
        const breadcrumbBridge = (crumb: any) => {
          try {
            if (crumb.type === 'http' || crumb.category?.startsWith('fetch') || crumb.category?.startsWith('xhr')) {
              record.addCustomEvent('network-request', {
                method: crumb.data?.method || 'GET',
                url: crumb.data?.url || crumb.message || '',
                status: crumb.data?.status_code,
                duration: crumb.data?.duration,
                error: crumb.data?.error,
                traceparent: crumb.data?.traceparent,
              });
            } else if (crumb.type === 'console' || crumb.category?.startsWith('console.')) {
              // Console tab requires expandable objects and stack traces for errors
              const payload: Record<string, unknown> = {
                level: crumb.category?.replace('console.', '') || 'log',
                message: crumb.message || '',
              };
              // Include structured data from console args (objects, arrays)
              if (crumb.data && Object.keys(crumb.data).length > 0) {
                payload.data = crumb.data;
              }
              // Include stack trace for error-level console entries
              if ((crumb.category === 'console.error' || crumb.category === 'console.warn') && crumb.data?.stack) {
                payload.stack = crumb.data.stack;
              }
              record.addCustomEvent('console-log', payload);
            }
          } catch {
            // Never crash the host app
          }
        };
        installBreadcrumbBridge = () => {
          if (breadcrumbUnsubscribe || typeof scope?.subscribeBreadcrumb !== 'function') {
            if (!breadcrumbUnsubscribe && typeof scope?.subscribeBreadcrumb !== 'function') {
              console.warn('[TraceKit Replay] Breadcrumb capture disabled: owned Browser subscriptions are unavailable.');
            }
            return;
          }
          try {
            breadcrumbUnsubscribe = scope.subscribeBreadcrumb(breadcrumbBridge);
          } catch {
            breadcrumbUnsubscribe = null;
          }
        };
        installBreadcrumbBridge();

        // Wire idle timeout: flush pending events when session goes idle
        session.setFlushCallback(() => {
          transport?.flush().catch(() => {
            // Never crash on flush errors
          });
        });

        // Wire idle timeout restart: stop recording, start fresh with new snapshot
        session.setRestartCallback(() => {
          stopRecordingPipeline();
          startRecordingPipeline();
        });

        session.setIdleStopCallback(() => {
          stopRecordingPipeline();
        });

        // Wire visibility pause: stop recording and flush sync on tab hide
        session.setPauseCallback(() => {
          if (stopRecording) {
            stopRecordingPipeline();
          }
          transport?.flushSync();
        });

        // Wire visibility resume: restart recording on tab show
        session.setResumeCallback(() => {
          startRecordingPipeline();
        });

        const startTransport = () => {
          if (!session || !resolvedConfig || !compressionWorker) return;
          transport = new ReplayTransport(resolvedConfig, compressionWorker);
          transport.start(
            () => session!.getFlushSessionId(),
            () => session!.nextSegmentId(),
            () => session!.getMode(),
            () => typeof window !== 'undefined' ? window.location.href : '',
            () => {
              try {
                return client.getScope().getUser()?.id || '';
              } catch { return ''; }
            },
            () => session!.getState().lastActivity + resolvedConfig!.idleTimeout,
            () => session!.allocateSegment(),
            () => session!.getIdentity(),
          );
        };

        // Create compression worker and transport only after all gates pass.
        compressionWorker = new CompressionWorker();
        startTransport();

        // Start recording immediately (LOCKED: recording starts on init())
        startRecordingPipeline();
      } catch (err) {
        console.warn('[TraceKit Replay] Failed to initialize replay recording:', err);
        integration.teardown?.();
      }
    },

    /** Stop recording, discard pending data, and block automatic resume. */
    stop(): void {
      if (manuallyStopped) return;
      manuallyStopped = true;
      try {
        session?.stop();
        if (breadcrumbUnsubscribe) {
          breadcrumbUnsubscribe();
          breadcrumbUnsubscribe = null;
        }
        stopRecordingPipeline();
        transport?.destroy();
        compressionWorker?.destroy();
        transport = null;
        compressionWorker = null;
      } catch {
        // Replay stop must never crash the host app.
      }
    },

    /** Start recording with a fresh identity after an explicit stop. */
    start(): void {
      try {
        if (!manuallyStopped || !session || !resolvedConfig || !hostRecordingEnabled()) return;
        manuallyStopped = false;
        session.start();
        compressionWorker = new CompressionWorker();
        installBreadcrumbBridge();
        transport = new ReplayTransport(resolvedConfig, compressionWorker);
        transport.start(
          () => session!.getFlushSessionId(), () => session!.nextSegmentId(), () => session!.getMode(),
          () => typeof window !== 'undefined' ? window.location.href : '',
          () => { try { return clientRef.getScope().getUser()?.id || ''; } catch { return ''; } },
          () => session!.getState().lastActivity + resolvedConfig!.idleTimeout,
          () => session!.allocateSegment(), () => session!.getIdentity(),
        );
        startRecordingPipeline();
      } catch {
        manuallyStopped = true;
      }
    },

    /**
     * Teardown: clean up all resources.
     * Called when the BrowserClient is destroyed.
     */
    teardown(): void {
      try {
        manuallyStopped = true;
        session?.stop();
        if (breadcrumbUnsubscribe) breadcrumbUnsubscribe();
        breadcrumbUnsubscribe = null;
        stopRecordingPipeline();
        transport?.destroy();
        compressionWorker?.destroy();
        restoreCaptureException?.();
        restoreCaptureException = null;
        session?.destroy();
        session = null;
        compressionWorker = null;
        transport = null;
        resolvedConfig = null;
      } catch {
        // Ignore teardown errors
      }
    },

    /**
     * Manual flush: force an immediate upload of pending events.
     * Useful for ensuring data is sent before a page transition.
     */
    flush(): void {
      try {
        transport?.flush().catch(() => {
          // Never crash
        });
      } catch {
        // Never crash
      }
    },

    /**
     * Get the current session ID.
     * Returns empty string if replay is not active.
     * Useful for linking errors to replay sessions (Phase 26).
     */
    getSessionId(): string {
      return session?.getSessionId() ?? '';
    },
  };

  return integration;
}

// Re-export types for consumers
export type { ReplayConfig, Integration } from './types';
