import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../src/buffer';
import { resolveReplayConfig } from '../src/config';
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
});
