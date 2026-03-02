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
 * Manual control: flush() forces an upload, getSessionId() returns the current ID.
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
 * @returns Integration object with flush() and getSessionId() manual control methods
 */
export function replayIntegration(
  config: ReplayConfig = {},
): Integration & { flush(): void; getSessionId(): string } {
  let session: SessionManager | null = null;
  let compressionWorker: CompressionWorker | null = null;
  let transport: ReplayTransport | null = null;
  let stopRecording: (() => void) | null = null;
  let resolvedConfig: ResolvedReplayConfig | null = null;

  const integration: Integration & { flush(): void; getSessionId(): string } = {
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
        // Resolve config with client's apiKey and endpoint
        const clientConfig = client.getConfig();
        resolvedConfig = resolveReplayConfig(config, clientConfig.apiKey, clientConfig.endpoint);

        // Create session manager (makes sampling decision)
        session = new SessionManager(resolvedConfig);

        // If mode is 'off', don't set up recording pipeline
        if (session.getMode() === 'off') {
          return;
        }

        // Create compression worker (Web Worker with main-thread fallback)
        compressionWorker = new CompressionWorker();

        // Create transport (30-second flush interval, retry, sendBeacon fallback)
        transport = new ReplayTransport(resolvedConfig, compressionWorker);

        // Wire session -> transport: events flow from session to transport
        session.setEventCallback((events: any[]) => {
          for (const event of events) {
            transport!.addEvent(event);
          }
        });

        // Wire error notification: hook into captureException to detect errors
        // for ring buffer flush. Also injects replay_id as a tag on the error event
        // so the playback UI can link errors to their replay session.
        // Uses setTag (not setExtra) so replay_id appears as a direct span attribute
        // in OTLP output -- extras would prefix it as "extra.replay_id".
        const originalCaptureException = client.captureException.bind(client);
        client.captureException = function (error: Error, context?: any): string {
          const replayId = session?.getSessionId() ?? '';
          const scope = client.getScope();
          if (replayId) {
            scope.setTag('replay_id', replayId);
          }
          const result = originalCaptureException(error, context);
          if (replayId) {
            scope.setTag('replay_id', '');
          }
          if (session) {
            session.onError();
          }
          return result;
        };

        // Bridge breadcrumbs to rrweb custom events for playback sidebar tabs.
        // Network requests become 'network-request' events, console output becomes
        // 'console-log' events -- both timestamped in the rrweb event stream.
        const scope = client.getScope();
        scope.onBreadcrumb((crumb: any) => {
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
        });

        // Wire idle timeout: flush pending events when session goes idle
        session.setFlushCallback(() => {
          transport?.flush().catch(() => {
            // Never crash on flush errors
          });
        });

        // Wire idle timeout restart: stop recording, start fresh with new snapshot
        session.setRestartCallback(() => {
          if (stopRecording) {
            stopRecording();
          }
          stopRecording = startRecording(resolvedConfig!, (event, isCheckout) => {
            session?.onEvent(event, isCheckout);
          });
        });

        // Wire visibility pause: stop recording and flush sync on tab hide
        session.setPauseCallback(() => {
          if (stopRecording) {
            stopRecording();
            stopRecording = null;
          }
          transport?.flushSync();
        });

        // Wire visibility resume: restart recording on tab show
        session.setResumeCallback(() => {
          stopRecording = startRecording(resolvedConfig!, (event, isCheckout) => {
            session?.onEvent(event, isCheckout);
          });
        });

        // Start transport (30-second flush interval)
        transport.start(
          () => session!.getSessionId(),
          () => session!.nextSegmentId(),
          () => (session!.getMode() === 'buffer' ? 'buffer' : 'session'),
        );

        // Start recording immediately (LOCKED: recording starts on init())
        stopRecording = startRecording(resolvedConfig, (event, isCheckout) => {
          session!.onEvent(event, isCheckout);
        });
      } catch (err) {
        console.warn('[TraceKit Replay] Failed to initialize replay recording:', err);
      }
    },

    /**
     * Teardown: clean up all resources.
     * Called when the BrowserClient is destroyed.
     */
    teardown(): void {
      try {
        if (stopRecording) {
          stopRecording();
          stopRecording = null;
        }
        transport?.destroy();
        compressionWorker?.destroy();
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
