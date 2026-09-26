import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressionWorker } from '../src/compression';
import { ReplayTransport } from '../src/transport';
import { resolveReplayConfig } from '../src/config';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('replay worker and delivery recovery', () => {
  it('settles a hung worker request and ignores a late reply', async () => {
    vi.useFakeTimers();
    const messages: any[] = [];
    let worker: any;
    vi.stubGlobal('Worker', class {
      onmessage: any;
      onerror: any;
      constructor() { worker = this; }
      postMessage(message: any) { messages.push(message); }
      terminate() {}
    });
    const compression = new CompressionWorker({ timeoutMs: 50 });
    const request = compression.compress([{ type: 2 }], 0);
    vi.advanceTimersByTime(51);
    await expect(request).rejects.toThrow('timed out');
    worker.onmessage({ data: { segmentId: messages[0].segmentId, compressed: new Uint8Array([1]), originalSize: 1 } });
    compression.destroy();
  });

  it('aborts a stalled fetch and bounds retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const worker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
    const transport = new ReplayTransport(resolveReplayConfig({ fetchTimeoutMs: 40, retryMaxAgeMs: 100 }, 'key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent({ type: 2, timestamp: 1 });
    const flush = transport.flush();
    await vi.advanceTimersByTimeAsync(200);
    await flush;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.getStatus().droppedChunks + transport.getStatus().unknownChunks).toBe(1);
    transport.destroy();
  });

  it('handles 429 with bounded retry and exposes status subscriptions', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const worker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
    const transport = new ReplayTransport(resolveReplayConfig({ retryMaxAgeMs: 5_000 }, 'key', 'https://example.test'), worker as any);
    const statuses: any[] = [];
    const unsubscribe = transport.subscribeStatus((status) => statuses.push(status));
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent({ type: 2, timestamp: 1 });
    const flush = transport.flush();
    await vi.advanceTimersByTimeAsync(1_100);
    await flush;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transport.getStatus().acknowledgedChunks).toBe(1);
    expect(statuses.some((status) => status.lastReason === 'rate_limited')).toBe(true);
    unsubscribe();
    transport.destroy();
  });

  it('reports queued unknown for accepted beacons without recursive breadcrumbs', () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const worker = { compress: vi.fn() };
    const transport = new ReplayTransport(resolveReplayConfig({}, 'secret-key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => 'https://private.invalid/path?token=secret', () => 'user-secret');
    transport.stop();
    transport.addEvent({ type: 2, timestamp: 1 });
    transport.flushSync();
    expect(transport.getStatus().unknownChunks).toBe(1);
    expect(JSON.stringify(transport.getStatus())).not.toContain('secret');
    expect(JSON.stringify(transport.getStatus())).not.toContain('private.invalid');
    transport.destroy();
  });
});
