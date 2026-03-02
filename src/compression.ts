/**
 * TraceKit Replay - Compression Worker
 * @package @tracekit/replay
 *
 * Compresses rrweb events via an inline Blob URL Web Worker using
 * native CompressionStream (gzip). On worker failure (CSP restriction,
 * CompressionStream unavailable), falls back to fflate gzipSync on the
 * main thread with a console warning.
 *
 * Zero-copy transfer: compressed Uint8Array buffer is transferred from
 * the worker via Transferable to avoid cloning overhead.
 */

import { gzipSync } from 'fflate';
import { WORKER_SCRIPT } from './worker';

interface PendingCompression {
  resolve: (data: { compressed: Uint8Array; originalSize: number }) => void;
  reject: (err: Error) => void;
  events: any[];
}

export class CompressionWorker {
  private worker: Worker | null = null;
  private pendingCallbacks = new Map<number, PendingCompression>();
  private useMainThread = false;

  constructor() {
    this.initWorker();
  }

  /**
   * Create an inline Blob URL worker from WORKER_SCRIPT.
   * If worker creation fails (e.g. CSP), flag permanent main-thread fallback.
   */
  private initWorker(): void {
    try {
      const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this.worker = new Worker(url);
      URL.revokeObjectURL(url); // URL can be revoked after worker creation

      this.worker.onmessage = (e: MessageEvent) => {
        const { compressed, segmentId, originalSize, error } = e.data;
        const pending = this.pendingCallbacks.get(segmentId);
        if (!pending) return;
        this.pendingCallbacks.delete(segmentId);

        if (error) {
          // Worker reported an error (e.g. CompressionStream not available)
          // Fall back to main-thread compression for this and future calls
          console.warn(
            '[TraceKit Replay] Worker compression failed, falling back to main thread:',
            error,
          );
          this.useMainThread = true;
          this.compressMainThread(pending.events).then(pending.resolve).catch(pending.reject);
          return;
        }

        pending.resolve({ compressed, originalSize });
      };

      this.worker.onerror = () => {
        console.warn(
          '[TraceKit Replay] Web Worker failed to initialize. Using main-thread compression.',
        );
        this.useMainThread = true;
        this.worker = null;
      };
    } catch {
      // CSP or other restriction prevents worker creation
      console.warn(
        '[TraceKit Replay] Cannot create Web Worker (CSP?). Using main-thread compression.',
      );
      this.useMainThread = true;
    }
  }

  /**
   * Compress an array of rrweb events.
   * Routes to Web Worker when available, otherwise uses main-thread fflate.
   *
   * @param events - Array of rrweb events to compress
   * @param segmentId - Unique segment ID for correlating worker responses
   * @returns Compressed data with original (uncompressed) size
   */
  async compress(
    events: any[],
    segmentId: number,
  ): Promise<{ compressed: Uint8Array; originalSize: number }> {
    if (this.useMainThread || !this.worker) {
      return this.compressMainThread(events);
    }

    return new Promise((resolve, reject) => {
      const entry: PendingCompression = { resolve, reject, events };
      this.pendingCallbacks.set(segmentId, entry);
      this.worker!.postMessage({ events, segmentId });
    });
  }

  /**
   * Main-thread fallback using fflate gzipSync.
   * Used when Web Worker is unavailable (CSP) or CompressionStream is missing.
   */
  private async compressMainThread(
    events: any[],
  ): Promise<{ compressed: Uint8Array; originalSize: number }> {
    const json = JSON.stringify(events);
    const encoded = new TextEncoder().encode(json);
    const compressed = gzipSync(encoded, { level: 6 });
    return { compressed, originalSize: encoded.length };
  }

  /**
   * Terminate the worker and clean up pending callbacks.
   */
  destroy(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingCallbacks.clear();
  }
}
