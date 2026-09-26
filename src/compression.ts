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
  timer: ReturnType<typeof setTimeout>;
  maxInputBytes: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INPUT_LIMIT = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 15_000;
const MAX_INPUT_LIMIT = 24 * 1024 * 1024;

function bounded(value: number | undefined, fallback: number, ceiling: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), ceiling) : fallback;
}

export class CompressionWorker {
  private worker: Worker | null = null;
  private pendingCallbacks = new Map<number, PendingCompression>();
  private useMainThread = false;
  private nextRequestId = 0;
  private destroyed = false;

  constructor() {
    this.initWorker();
  }

  getMode(): 'worker' | 'fallback' { return this.worker && !this.useMainThread ? 'worker' : 'fallback'; }

  /**
   * Create an inline Blob URL worker from WORKER_SCRIPT.
   * If worker creation fails (e.g. CSP), flag permanent main-thread fallback.
   */
  private initWorker(): void {
    let url: string | null = null;
    try {
      const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
      url = URL.createObjectURL(blob);
      this.worker = new Worker(url);

      this.worker.onmessage = (e: MessageEvent) => {
        const { compressed, segmentId, originalSize, error } = e.data;
        const pending = this.pendingCallbacks.get(segmentId);
        if (!pending) return;
        this.pendingCallbacks.delete(segmentId);
        clearTimeout(pending.timer);

        if (error) {
          // Worker reported an error (e.g. CompressionStream not available)
          // Fall back to main-thread compression for this and future calls
          console.warn('[TraceKit Replay] Worker compression failed. Using bounded fallback.');
          this.useMainThread = true;
          this.compressMainThread(pending.events, Math.min(pending.maxInputBytes, DEFAULT_INPUT_LIMIT)).then(pending.resolve).catch(pending.reject);
          return;
        }
        if (!(compressed instanceof Uint8Array) || compressed.byteLength > pending.maxInputBytes ||
            !Number.isSafeInteger(originalSize) || originalSize > pending.maxInputBytes) {
          pending.reject(new Error('Replay worker output exceeds its bound'));
        } else pending.resolve({ compressed, originalSize });
      };

      this.worker.onerror = () => {
        console.warn(
          '[TraceKit Replay] Web Worker failed to initialize. Using main-thread compression.',
        );
        this.useMainThread = true;
        this.worker?.terminate();
        this.worker = null;
        for (const pending of this.pendingCallbacks.values()) {
          clearTimeout(pending.timer);
          this.compressMainThread(pending.events, Math.min(pending.maxInputBytes, DEFAULT_INPUT_LIMIT)).then(pending.resolve).catch(pending.reject);
        }
        this.pendingCallbacks.clear();
      };
    } catch {
      // CSP or other restriction prevents worker creation
      console.warn(
        '[TraceKit Replay] Cannot create Web Worker (CSP?). Using main-thread compression.',
      );
      this.useMainThread = true;
    } finally {
      if (url !== null) URL.revokeObjectURL(url);
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
    _segmentId: number,
    options: { timeoutMs?: number; maxInputBytes?: number } = {},
  ): Promise<{ compressed: Uint8Array; originalSize: number }> {
    if (this.destroyed) throw new Error('Replay compression worker destroyed');
    const maxInputBytes = bounded(options.maxInputBytes, DEFAULT_INPUT_LIMIT, MAX_INPUT_LIMIT);
    const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const encodedSize = new TextEncoder().encode(JSON.stringify(events)).byteLength;
    if (encodedSize > maxInputBytes) throw new Error('Replay compression input exceeds its bound');
    if (this.useMainThread || !this.worker) {
      return this.compressMainThread(events, Math.min(maxInputBytes, DEFAULT_INPUT_LIMIT));
    }

    // Transport uses one job. Keep two direct worker callers compatible.
    if (this.pendingCallbacks.size >= 2) throw new Error('Replay compression queue full');

    return new Promise((resolve, reject) => {
      // Session segment numbers restart at zero; worker requests never reuse them.
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => {
        const pending = this.pendingCallbacks.get(requestId);
        if (!pending) return;
        this.pendingCallbacks.delete(requestId);
        pending.reject(new Error('Replay compression timeout'));
        this.worker?.terminate();
        this.worker = null;
        this.useMainThread = true;
      }, timeoutMs);
      const entry: PendingCompression = { resolve, reject, events, timer, maxInputBytes };
      this.pendingCallbacks.set(requestId, entry);
      try {
        this.worker!.postMessage({ events, segmentId: requestId });
      } catch {
        this.pendingCallbacks.delete(requestId);
        clearTimeout(timer);
        this.useMainThread = true;
        this.compressMainThread(events, Math.min(maxInputBytes, DEFAULT_INPUT_LIMIT)).then(resolve).catch(reject);
      }
    });
  }

  /**
   * Main-thread fallback using fflate gzipSync.
   * Used when Web Worker is unavailable (CSP) or CompressionStream is missing.
   */
  private async compressMainThread(
    events: any[],
    maxInputBytes: number,
  ): Promise<{ compressed: Uint8Array; originalSize: number }> {
    const json = JSON.stringify(events);
    const encoded = new TextEncoder().encode(json);
    if (encoded.byteLength > maxInputBytes) throw new Error('Replay fallback input exceeds its bound');
    const compressed = gzipSync(encoded, { level: 6 });
    if (compressed.byteLength > maxInputBytes) throw new Error('Replay fallback output exceeds its bound');
    return { compressed, originalSize: encoded.length };
  }

  /**
   * Terminate the worker and clean up pending callbacks.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const pending of this.pendingCallbacks.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Replay compression worker destroyed'));
    }
    this.pendingCallbacks.clear();
  }
}
