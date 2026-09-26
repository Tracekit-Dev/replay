import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../src/buffer';
import { resolveReplayConfig } from '../src/config';
import { ReplayTransport } from '../src/transport';
import { gunzipSync, gzipSync } from 'fflate';

const snapshot = (timestamp: number, text = '') => ({
  type: 2, timestamp,
  data: { node: { type: 0, id: 1, childNodes: [
    { type: 2, id: 2, tagName: 'div', attributes: {}, childNodes: [
      { type: 3, id: 3, textContent: text },
    ] },
  ] } },
});
const mutation = (timestamp: number) => ({
  type: 3, timestamp,
  data: { source: 0, adds: [], texts: [{ id: 3, value: 'safe' }], attributes: [], removes: [] },
});
const byteSize = (event: unknown) => new TextEncoder().encode(JSON.stringify(event)).byteLength;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded error history', () => {
  it('counts serialized UTF-8 bytes and evicts complete snapshot regions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const first = snapshot(Date.now(), '😀😀😀');
    const next = snapshot(Date.now() + 1, 'safe');
    const later = mutation(Date.now() + 2);
    const budget = byteSize(next) + byteSize(later) + 2;
    const ring = new RingBuffer(60_000, { maxBytes: budget, maxEvents: 3 });
    ring.add(first);
    ring.add(mutation(Date.now()));
    ring.add(next);
    ring.add(later);
    expect(ring.byteSize).toBeLessThanOrEqual(budget);
    expect(ring.flush()).toEqual([next, later]);
  });

  it('discards mutations after their snapshot ages out', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const ring = new RingBuffer(1000, { maxBytes: 4096, maxEvents: 10 });
    ring.add(snapshot(Date.now()));
    vi.setSystemTime(Date.now() + 1001);
    ring.add(mutation(Date.now()));
    expect(ring.flush()).toEqual([]);
  });
});

describe('bounded delivery', () => {
  it('rejects nonfinite rates and clamps unsafe queue settings', () => {
    const config = resolveReplayConfig({
      sessionSampleRate: Number.NaN,
      errorSampleRate: Number.POSITIVE_INFINITY,
      maxBufferSize: Number.POSITIVE_INFINITY,
      maxEventCount: -1,
      maxBufferAgeMs: Number.NaN,
      maxChunkCount: 1000,
    }, 'key', 'https://api.test');
    expect(config.sessionSampleRate).toBe(0.1);
    expect(config.errorSampleRate).toBe(0);
    expect(config.maxBufferSize).toBeGreaterThan(0);
    expect(config.maxBufferSize).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(config.maxEventCount).toBeGreaterThan(0);
    expect(config.maxBufferAgeMs).toBeGreaterThan(0);
    expect(config.maxChunkCount).toBeLessThanOrEqual(8);
  });

  it('stops an oversized baseline before compression or upload', async () => {
    const compress = vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 }));
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const config = resolveReplayConfig({ maxBufferSize: 256, maxEventCount: 10 }, 'key', 'https://api.test');
    const transport = new ReplayTransport(config, { compress } as any);
    const failed = vi.fn();
    transport.setFailureCallback(failed);
    transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent(snapshot(Date.now(), 'x'.repeat(1000)));
    await transport.flush();
    expect(transport.getStatus().captureState).toBe('failed');
    expect(transport.getStatus().reason).toBe('snapshot_too_large');
    expect(failed).toHaveBeenCalledOnce();
    expect(compress).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('bounds detached compression and later pending events without orphan upload', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const payloads: unknown[][] = [];
    const compress = vi.fn(async (events: unknown[]) => {
      await gate;
      payloads.push(events);
      const bytes = new TextEncoder().encode(JSON.stringify(events));
      return { compressed: gzipSync(bytes), originalSize: bytes.length };
    });
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const config = resolveReplayConfig({ maxBufferSize: 900, maxEventCount: 5, maxChunkCount: 2 }, 'key', 'https://api.test');
    const transport = new ReplayTransport(config, { compress } as any);
    let segment = 0;
    transport.start(() => 'a'.repeat(32), () => segment++, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent(snapshot(Date.now()));
    const first = transport.flush();
    for (let i = 0; i < 100; i++) transport.addEvent(mutation(Date.now() + i));
    expect(transport.getStatus().queueBytes).toBeLessThanOrEqual(config.maxBufferSize);
    release();
    await first;
    await transport.flush();
    for (const call of fetchMock.mock.calls) {
      const events = JSON.parse(new TextDecoder().decode(gunzipSync(call[1].body)));
      const firstContent = events.find((event: { type: number }) => event.type === 2 || event.type === 3);
      expect(firstContent?.type).not.toBe(3);
    }
    expect(payloads.length).toBeLessThanOrEqual(2);
    transport.destroy();
  });

  it('expires a dependent region and requests one fresh snapshot', async () => {
    vi.useFakeTimers();
    const config = resolveReplayConfig({ maxBufferSize: 2000, maxBufferAgeMs: 10 }, 'key', 'https://api.test');
    const transport = new ReplayTransport(config, { compress: vi.fn() } as any);
    const request = vi.fn();
    transport.setSnapshotRequest(request);
    transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent(snapshot(Date.now()));
    await vi.advanceTimersByTimeAsync(11);
    transport.addEvent(mutation(Date.now()));
    transport.addEvent(mutation(Date.now() + 1));
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    expect(transport.getStatus().queueEvents).toBe(0);
    expect(transport.getStatus().droppedEvents).toBeGreaterThan(0);
    transport.destroy();
  });

  it('rejects dependent mutations after a failed baseline upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 413 })));
    const config = resolveReplayConfig({ maxBufferSize: 2000, maxRetryAttempts: 1 }, 'key', 'https://api.test');
    const transport = new ReplayTransport(config, { compress: vi.fn(async (events: unknown[]) => {
      const encoded = new TextEncoder().encode(JSON.stringify(events));
      return { compressed: gzipSync(encoded), originalSize: encoded.length };
    }) } as any);
    const request = vi.fn();
    transport.setSnapshotRequest(request);
    transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent(snapshot(Date.now()));
    await transport.flush();
    transport.addEvent(mutation(Date.now() + 1));
    await transport.flush();
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    expect(transport.getStatus().queueEvents).toBe(0);
    expect(transport.getStatus().droppedChunks).toBe(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    transport.destroy();
  });
});
