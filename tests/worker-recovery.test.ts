import { afterEach, expect, it, vi } from 'vitest';
import { CompressionWorker } from '../src/compression';
import { resolveReplayConfig } from '../src/config';
import { ReplayTransport } from '../src/transport';
import { replayIntegration } from '../src/index';

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
