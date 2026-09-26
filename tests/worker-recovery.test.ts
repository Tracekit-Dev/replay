import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressionWorker } from '../src/compression';
import { replayIntegration } from '../src/index';
import { ReplayTransport } from '../src/transport';
import { resolveReplayConfig } from '../src/config';

vi.mock('rrweb', () => ({ record: vi.fn(() => vi.fn()), addCustomEvent: vi.fn() }));

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
    transport.addEvent({ type: 2, timestamp: Date.now() });
    const flush = transport.flush();
    await vi.advanceTimersByTimeAsync(200);
    await flush;
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
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
    transport.addEvent({ type: 2, timestamp: Date.now() });
    const flush = transport.flush();
    await vi.advanceTimersByTimeAsync(1_100);
    await flush;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transport.getStatus().acknowledgedChunks).toBe(1);
    expect(statuses.some((status) => status.lastReason === 'rate_limited')).toBe(true);
    unsubscribe();
    transport.destroy();
  });

  it('recovers from one offline failure within the retry window', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const worker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
    const transport = new ReplayTransport(resolveReplayConfig({ retryMaxAgeMs: 5_000 }, 'key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent({ type: 2, timestamp: Date.now() });
    const flush = transport.flush();
    await vi.advanceTimersByTimeAsync(1_100);
    await flush;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transport.getStatus().acknowledgedChunks).toBe(1);
    transport.destroy();
  });

  it('reports queued unknown for accepted beacons without recursive breadcrumbs', () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const worker = { compress: vi.fn() };
    const transport = new ReplayTransport(resolveReplayConfig({}, 'secret-key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => 'https://private.invalid/path?token=secret', () => 'user-secret');
    transport.stop();
    transport.addEvent({ type: 2, timestamp: Date.now() });
    transport.flushSync();
    expect(transport.getStatus().unknownChunks).toBe(1);
    expect(JSON.stringify(transport.getStatus())).not.toContain('secret');
    expect(JSON.stringify(transport.getStatus())).not.toContain('private.invalid');
    transport.destroy();
  });

  it('settles a hung fetch without AbortController', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('AbortController', undefined);
    const worker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
    const transport = new ReplayTransport(resolveReplayConfig({ fetchTimeoutMs: 20, retryMaxAgeMs: 20 }, 'key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent({ type: 2, timestamp: Date.now() });
    const flush = transport.flush();
    await vi.advanceTimersByTimeAsync(100);
    await expect(flush).resolves.toBeUndefined();
    expect(transport.getStatus().droppedChunks).toBe(1);
    transport.destroy();
  });

  it('treats HTTP 409 as a terminal conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 409 })));
    const worker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
    const transport = new ReplayTransport(resolveReplayConfig({ retryMaxAgeMs: 100 }, 'key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent({ type: 2, timestamp: Date.now() });
    await transport.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(transport.getStatus().lastReason).toBe('http_409');
    transport.destroy();
  });

  it('exposes separate capture and delivery states', () => {
    const worker = { compress: vi.fn() };
    const transport = new ReplayTransport(resolveReplayConfig({}, 'key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    expect(transport.getStatus().captureState).toBe('recording');
    expect(transport.getStatus().deliveryState).toBe('idle');
    transport.stopRecordingWindow();
    expect(transport.getStatus().captureState).toBe('suspended');
    transport.destroy();
  });

  it('throttles flood status notifications while preserving aggregate drops', async () => {
    const worker = { compress: vi.fn() };
    const transport = new ReplayTransport(resolveReplayConfig({ maxBufferSize: 128, maxBufferEvents: 2 }, 'key', 'https://example.test'), worker as any);
    const statuses: any[] = [];
    transport.subscribeStatus((status) => statuses.push(status));
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent({ type: 2, timestamp: Date.now() });
    for (let index = 0; index < 1_000; index++) transport.addEvent({ type: 3, timestamp: Date.now(), data: { index } });
    await Promise.resolve();
    expect(statuses.length).toBeLessThan(30);
    expect(transport.getStatus().droppedEvents).toBeGreaterThan(900);
    transport.destroy();
  });

  it('keeps status subscriptions across manual restart', () => {
    const integration = replayIntegration({ sessionSampleRate: 1 });
    const client = {
      getConfig: () => ({ apiKey: 'key', endpoint: 'https://example.test', enabled: true }),
      getScope: () => ({ getUser: () => ({ id: '' }), subscribeBreadcrumb: () => () => {}, }),
      captureException: (error: Error) => error.message,
    };
    integration.install(client);
    const statuses: any[] = [];
    integration.subscribeStatus((status) => statuses.push(status));
    integration.stop();
    integration.start();
    expect(statuses.some((status) => status.captureState === 'recording')).toBe(true);
    integration.teardown?.();
  });
});
