import { afterEach, expect, it, vi } from 'vitest';
import { CompressionWorker } from '../src/compression';
import { resolveReplayConfig } from '../src/config';
import { ReplayTransport } from '../src/transport';
import { replayIntegration } from '../src/index';
import { WORKER_SCRIPT } from '../src/worker';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('provides safe aggregate status before install', () => {
  const integration = replayIntegration();
  const status = integration.getStatus();
  expect(status.captureState).toBe('disabled');
  expect(status.queueBytes).toBe(0);
  expect(JSON.stringify(status)).not.toMatch(/apiKey|sessionId|url/i);
});

it('settles a hung worker once and ignores a late reply', async () => {
  vi.useFakeTimers();
  let instance: any;
  vi.stubGlobal('Worker', class {
    onmessage: any;
    constructor() { instance = this; }
    postMessage() {}
    terminate() {}
  });
  const worker = new CompressionWorker();
  const pending = worker.compress([{ type: 5, timestamp: 1, data: {} }], 0, { timeoutMs: 10 });
  const settled = expect(pending).rejects.toThrow(/timeout/);
  const former = instance;
  await vi.advanceTimersByTimeAsync(11);
  await settled;
  former.onmessage({ data: { segmentId: 0, compressed: new Uint8Array([1]), originalSize: 1 } });
  await expect(worker.compress([{ type: 5, timestamp: 2, data: {} }], 1)).resolves.toHaveProperty('compressed');
  worker.destroy();
});

it('reports queued beacon acknowledgement as unknown', () => {
  vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) });
  const transport = new ReplayTransport(resolveReplayConfig({ sessionSampleRate: 1 }, 'key', 'https://api.test'),
    { compress: vi.fn() } as any);
  transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
  transport.stop();
  transport.addEvent({ type: 5, timestamp: Date.now(), data: { tag: 'console-log', payload: { level: 'log' } } });
  transport.flushSync();
  expect(transport.getStatus().queuedBeacons).toBe(1);
  expect(transport.getStatus().acknowledgedChunks).toBe(0);
  expect(transport.getStatus().reason).toBe('beacon_unknown');
  transport.destroy();
});

it('bounds an unanswered fetch and drops its immutable chunk', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })));
  const config = resolveReplayConfig({ sessionSampleRate: 1, fetchTimeoutMs: 10,
    maxRetryAttempts: 1 }, 'key', 'https://api.test');
  const transport = new ReplayTransport(config, { compress: vi.fn(async () => ({
    compressed: new Uint8Array([1]), originalSize: 1,
  })) } as any);
  transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
  transport.stop();
  transport.addEvent({ type: 5, timestamp: Date.now(), data: { tag: 'console-log', payload: { level: 'log' } } });
  const flushing = transport.flush();
  await vi.advanceTimersByTimeAsync(20);
  await flushing;
  expect(transport.getStatus().droppedChunks).toBe(1);
  expect(transport.getStatus().queueBytes).toBe(0);
  transport.destroy();
});

it('settles when fetch ignores AbortSignal', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const config = resolveReplayConfig({ sessionSampleRate: 1, fetchTimeoutMs: 10,
    maxRetryAttempts: 1 }, 'key', 'https://api.test');
  const transport = new ReplayTransport(config, { compress: vi.fn(async () => ({
    compressed: new Uint8Array([1]), originalSize: 1,
  })) } as any);
  transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
  transport.stop();
  transport.addEvent({ type: 5, timestamp: Date.now(), data: { tag: 'console-log', payload: { level: 'log' } } });
  const result = transport.flush().then(() => 'settled');
  await vi.advanceTimersByTimeAsync(20);
  expect(await Promise.race([result, Promise.resolve('hung')])).toBe('settled');
  transport.destroy();
});

it('bounds keepalive acknowledgement when fetch ignores AbortSignal', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const config = resolveReplayConfig({ sessionSampleRate: 1, fetchTimeoutMs: 10 }, 'key', 'https://api.test');
  const transport = new ReplayTransport(config, { compress: vi.fn() } as any);
  transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
  transport.stop();
  transport.addEvent({ type: 5, timestamp: Date.now(), data: { tag: 'console-log', payload: { level: 'log' } } });
  transport.flushSync();
  await vi.advanceTimersByTimeAsync(20);
  expect(transport.getStatus().droppedChunks).toBe(1);
  expect(transport.getStatus().queuedBeacons).toBe(0);
  transport.destroy();
});

it('recovers from offline state within the retry budget', async () => {
  vi.useFakeTimers();
  const network = { onLine: false };
  vi.stubGlobal('navigator', network);
  const fetchMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  const config = resolveReplayConfig({ sessionSampleRate: 1, maxRetryAttempts: 2,
    retryBaseDelayMs: 10, maxBackoffMs: 10 }, 'key', 'https://api.test');
  const transport = new ReplayTransport(config, { compress: vi.fn(async () => ({
    compressed: new Uint8Array([1]), originalSize: 1,
  })) } as any);
  transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
  transport.stop();
  transport.addEvent({ type: 5, timestamp: Date.now(), data: { tag: 'console-log', payload: { level: 'log' } } });
  const flushing = transport.flush();
  await vi.advanceTimersByTimeAsync(1);
  network.onLine = true;
  await vi.advanceTimersByTimeAsync(20);
  await flushing;
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(transport.getStatus().retries).toBe(1);
  expect(transport.getStatus().acknowledgedChunks).toBe(1);
  transport.destroy();
});

it('caps Retry-After by retry age', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => ({ ok: false, status: 429,
    headers: { get: () => '1000' } }));
  vi.stubGlobal('fetch', fetchMock);
  const config = resolveReplayConfig({ sessionSampleRate: 1, maxRetryAttempts: 3,
    maxRetryAgeMs: 100, retryBaseDelayMs: 10 }, 'key', 'https://api.test');
  const transport = new ReplayTransport(config, { compress: vi.fn(async () => ({
    compressed: new Uint8Array([1]), originalSize: 1,
  })) } as any);
  transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
  transport.stop();
  transport.addEvent({ type: 5, timestamp: Date.now(), data: { tag: 'console-log', payload: { level: 'log' } } });
  const flushing = transport.flush();
  await vi.advanceTimersByTimeAsync(150);
  await flushing;
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(transport.getStatus().droppedChunks).toBe(1);
  transport.destroy();
});

it('does not retry before a 429 Retry-After beyond the backoff ceiling', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => ({ ok: false, status: 429,
    headers: { get: () => '0.05' } }));
  vi.stubGlobal('fetch', fetchMock);
  const config = resolveReplayConfig({ sessionSampleRate: 1, maxRetryAttempts: 2,
    maxRetryAgeMs: 100, retryBaseDelayMs: 1, maxBackoffMs: 10 }, 'key', 'https://api.test');
  const transport = new ReplayTransport(config, { compress: vi.fn(async () => ({
    compressed: new Uint8Array([1]), originalSize: 1,
  })) } as any);
  transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
  transport.stop();
  transport.addEvent({ type: 5, timestamp: Date.now(), data: { tag: 'console-log', payload: { level: 'log' } } });
  const flushing = transport.flush();
  await vi.advanceTimersByTimeAsync(60);
  await flushing;
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(transport.getStatus().droppedChunks).toBe(1);
  transport.destroy();
});

it.each(['write', 'read'])('posts one error after a worker %s failure', async (failure) => {
  const self = { postMessage: vi.fn(), onmessage: null as any };
  const FakeStream = class {
    writable = { getWriter: () => ({
      write: () => failure === 'write' ? Promise.reject(new Error('failed')) : Promise.resolve(),
      close: () => Promise.resolve(),
    }) };
    readable = { getReader: () => ({
      read: () => failure === 'read' ? Promise.reject(new Error('failed')) : Promise.resolve({ done: true }),
    }) };
  };
  new Function('self', 'CompressionStream', WORKER_SCRIPT)(self, FakeStream);
  await self.onmessage({ data: { segmentId: 4, events: [{ type: 5 }] } });
  expect(self.postMessage).toHaveBeenCalledOnce();
  expect(self.postMessage.mock.calls[0][0]).toMatchObject({ segmentId: 4, error: 'failed' });
});

it('bounds direct worker concurrency while preserving two callers', async () => {
  vi.stubGlobal('Worker', class { onmessage: any; onerror: any; postMessage() {} terminate() {} });
  const worker = new CompressionWorker();
  const first = worker.compress([{ type: 5 }], 0);
  const second = worker.compress([{ type: 5 }], 1);
  await expect(worker.compress([{ type: 5 }], 2)).rejects.toThrow(/queue full/);
  const settled = Promise.allSettled([first, second]);
  worker.destroy();
  expect((await settled).map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
});
