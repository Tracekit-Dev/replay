import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../src/buffer';
import { resolveReplayConfig } from '../src/config';
import { SessionManager } from '../src/session';
import { ReplayTransport } from '../src/transport';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bounded replay queues', () => {
  it('rejects nonfinite sample rates and resolves finite bounds', () => {
    const config = resolveReplayConfig({
      sessionSampleRate: Number.NaN,
      errorSampleRate: Number.POSITIVE_INFINITY,
      maxBufferSize: 128,
      maxBufferEvents: 4,
      maxBufferAgeMs: 500,
      maxChunkEvents: 3,
      maxChunkBytes: 256,
    }, 'key', 'https://example.test');

    expect(config.sessionSampleRate).toBe(0);
    expect(config.errorSampleRate).toBe(0);
    expect(config.maxBufferSize).toBe(128);
    expect(config.maxBufferEvents).toBe(4);
    expect(config.maxBufferAgeMs).toBe(500);
    expect(config.maxChunkEvents).toBe(3);
    expect(config.maxChunkBytes).toBe(256);
  });

  it('counts UTF-8 bytes and keeps a complete snapshot region', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const ring = new RingBuffer({ maxAgeMs: 10_000, maxBytes: 160, maxEvents: 5 });
    ring.add({ type: 2, timestamp: 1_000, data: { text: 'baseline' } });
    ring.add({ type: 3, timestamp: 1_001, data: { text: '😀'.repeat(20) } });
    ring.add({ type: 3, timestamp: 1_002, data: { text: 'mutation' } });

    const events = ring.flush();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe(2);
    expect(ring.stats.bytes).toBeLessThanOrEqual(160);
    expect(ring.stats.events).toBeLessThanOrEqual(5);
    expect(ring.stats.dropped).toBeGreaterThan(0);
  });

  it('marks an oversized baseline instead of retaining orphan mutations', () => {
    const ring = new RingBuffer({ maxAgeMs: 10_000, maxBytes: 32, maxEvents: 4 });
    ring.add({ type: 2, timestamp: 1, data: { text: 'x'.repeat(100) } });
    ring.add({ type: 3, timestamp: 2, data: { text: 'orphan' } });

    expect(ring.flush()).toEqual([]);
    expect(ring.stats.reason).toBe('snapshot_too_large');
  });

  it('bounds pending Unicode events and reports drops without recording content', () => {
    const worker = { compress: vi.fn(async (events: any[]) => ({ compressed: new Uint8Array([1]), originalSize: JSON.stringify(events).length })) };
    const transport = new ReplayTransport(resolveReplayConfig({ maxBufferSize: 80, maxBufferEvents: 3 }, 'key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();

    transport.addEvent({ type: 2, timestamp: 1, data: { text: '😀'.repeat(30) } });
    transport.addEvent({ type: 3, timestamp: 2, data: { text: 'small' } });
    const status = transport.getStatus();
    expect(status.pendingBytes).toBeLessThanOrEqual(80);
    expect(status.pendingEvents).toBeLessThanOrEqual(3);
    expect(status.droppedEvents).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain('😀');
    transport.destroy();
  });

  it('keeps a flood bounded while preserving a terminal drop count', () => {
    const worker = { compress: vi.fn(async (events: any[]) => ({ compressed: new Uint8Array([1]), originalSize: events.length })) };
    const transport = new ReplayTransport(resolveReplayConfig({ maxBufferSize: 512, maxBufferEvents: 8 }, 'key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent({ type: 2, timestamp: Date.now() });
    for (let index = 0; index < 1_000; index++) {
      transport.addEvent({ type: 3, timestamp: Date.now(), data: { index, text: 'flood' } });
    }
    const status = transport.getStatus();
    expect(status.pendingEvents).toBeLessThanOrEqual(8);
    expect(status.pendingBytes).toBeLessThanOrEqual(512);
    expect(status.droppedEvents).toBeGreaterThan(0);
    transport.destroy();
  });

  it('never uploads mutations after the baseline is evicted', async () => {
    const uploaded: any[][] = [];
    const worker = { compress: vi.fn(async (events: any[]) => {
      uploaded.push(events);
      return { compressed: new Uint8Array([1]), originalSize: 1 };
    }) };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 202 })));
    const transport = new ReplayTransport(resolveReplayConfig({ maxBufferEvents: 3 }, 'key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();
    const now = Date.now();
    transport.addEvent({ type: 2, timestamp: now });
    transport.addEvent({ type: 3, timestamp: now + 1 });
    transport.addEvent({ type: 3, timestamp: now + 2 });
    transport.addEvent({ type: 3, timestamp: now + 3 });
    await transport.flush();
    expect(uploaded).toHaveLength(0);
    expect(transport.getStatus().droppedEvents).toBeGreaterThan(0);
    transport.destroy();
  });

  it('never uploads a buffer-mode region without a snapshot', async () => {
    const uploaded: any[][] = [];
    let mode = 'buffer';
    const worker = { compress: vi.fn(async (events: any[]) => {
      uploaded.push(events);
      return { compressed: new Uint8Array([1]), originalSize: 1 };
    }) };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 202 })));
    const transport = new ReplayTransport(resolveReplayConfig({ maxBufferEvents: 2 }, 'buffer-only', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => mode, () => '', () => '');
    transport.stop();
    const now = Date.now();
    transport.addEvent({ type: 2, timestamp: now });
    transport.addEvent({ type: 3, timestamp: now + 1 });
    transport.addEvent({ type: 3, timestamp: now + 2 });
    await transport.flush();
    mode = 'session';
    expect(uploaded).toHaveLength(0);
    transport.destroy();
  });

  it('drops initial buffer-mode mutations until a snapshot arrives', async () => {
    let mode = 'buffer';
    const worker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
    const transport = new ReplayTransport(resolveReplayConfig({}, 'buffer-initial', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => mode, () => '', () => '');
    transport.stop();
    transport.addEvent({ type: 3, timestamp: Date.now() });
    await transport.flush();
    expect(worker.compress).not.toHaveBeenCalled();
    mode = 'session';
    transport.destroy();
  });

  it('stops an oversized baseline region until a fresh snapshot arrives', () => {
    const worker = { compress: vi.fn() };
    const transport = new ReplayTransport(resolveReplayConfig({ maxBufferSize: 128 }, 'key', 'https://example.test'), worker as any);
    transport.start(() => 'session', () => 0, () => 'session', () => '', () => '');
    transport.stop();
    const now = Date.now();
    transport.addEvent({ type: 2, timestamp: now, data: { text: 'x'.repeat(1_000) } });
    expect(transport.getStatus().lastReason).toBe('snapshot_too_large');
    transport.addEvent({ type: 3, timestamp: now + 1, data: { text: 'orphan' } });
    expect(transport.getStatus().pendingEvents).toBe(0);
    expect(transport.getStatus().lastReason).toBe('snapshot_too_large');
    transport.destroy();
  });

  it('applies resolved bounds to error-mode capture', () => {
    const manager = new SessionManager(resolveReplayConfig({ sessionSampleRate: 0, errorSampleRate: 1, maxBufferEvents: 2, maxBufferSize: 128 }, 'key', 'https://example.test'));
    let captured: any[] = [];
    manager.setEventCallback((events) => { captured = events; });
    const now = Date.now();
    manager.onEvent({ type: 2, timestamp: now }, true);
    manager.onEvent({ type: 3, timestamp: now + 1 }, false);
    manager.onEvent({ type: 3, timestamp: now + 2 }, false);
    manager.onError();
    expect(captured.length).toBeLessThanOrEqual(2);
    expect(captured[0]?.type).toBe(2);
    expect(captured.reduce((total, event) => total + new TextEncoder().encode(JSON.stringify(event)).byteLength, 0)).toBeLessThanOrEqual(128);
    manager.destroy();
  });

  it('keeps error mode stopped after repeated oversized baselines', () => {
    const manager = new SessionManager(resolveReplayConfig({ sessionSampleRate: 0, errorSampleRate: 1, maxBufferSize: 128 }, 'oversized', 'https://example.test'));
    const captured: any[][] = [];
    manager.setEventCallback((events) => { captured.push(events); });
    manager.setRestartCallback(() => {});
    expect(manager.getMode()).toBe('buffer');
    const now = Date.now();
    manager.onEvent({ type: 2, timestamp: now, data: { text: 'x'.repeat(1_000) } }, true);
    manager.onError();
    manager.onEvent({ type: 2, timestamp: now + 1, data: { text: 'y'.repeat(1_000) } }, true);
    manager.onError();
    manager.onEvent({ type: 3, timestamp: now + 2, data: { text: 'orphan' } }, false);
    manager.onError();
    expect(manager.getMode()).toBe('buffer');
    expect(captured).toHaveLength(0);
    manager.destroy();
  });

  it('keeps error-mode age limits per session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const manager = new SessionManager(resolveReplayConfig({ sessionSampleRate: 0, errorSampleRate: 1, maxBufferAgeMs: 10 }, 'key', 'https://example.test'));
    const captured: any[][] = [];
    manager.setEventCallback((events) => { captured.push(events); });
    manager.onEvent({ type: 2, timestamp: 0 }, true);
    vi.advanceTimersByTime(100);
    manager.onError();
    expect(captured).toHaveLength(0);
    manager.destroy();
    vi.useRealTimers();
  });

  it('keeps bounds isolated across concurrent sessions', () => {
    const smallConfig = resolveReplayConfig({ sessionSampleRate: 0, errorSampleRate: 1, maxBufferEvents: 2 }, 'small', 'https://example.test');
    const largeConfig = resolveReplayConfig({ sessionSampleRate: 0, errorSampleRate: 1, maxBufferEvents: 100 }, 'large', 'https://example.test');
    const small = new SessionManager(smallConfig);
    const large = new SessionManager(largeConfig);
    const smallCaptured: any[][] = [];
    const largeCaptured: any[][] = [];
    small.setEventCallback((events) => { smallCaptured.push(events); });
    large.setEventCallback((events) => { largeCaptured.push(events); });
    const now = Date.now();
    for (const manager of [small, large]) {
      manager.onEvent({ type: 2, timestamp: now }, true);
      manager.onEvent({ type: 3, timestamp: now + 1 }, false);
      manager.onEvent({ type: 3, timestamp: now + 2 }, false);
      manager.onError();
    }
    expect(smallCaptured[0]?.length).toBeLessThanOrEqual(2);
    expect(largeCaptured[0]?.length).toBe(3);
    small.destroy();
    large.destroy();
  });
});
