import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../src/buffer';
import { resolveReplayConfig } from '../src/config';
import { ReplayTransport } from '../src/transport';
import { SessionManager } from '../src/session';
import { replayIntegration } from '../src/index';
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
const recorderBridge = vi.hoisted(() => ({ emit: null as null | ((event: unknown, checkout: boolean) => void) }));
vi.mock('../src/recorder', () => ({ startRecording: vi.fn((_config, emit) => {
  recorderBridge.emit = emit;
  return () => {};
}) }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded error history', () => {
  it('does not report intentional pre-baseline metadata as lost recording data', () => {
    const ring = new RingBuffer(60_000, { maxBytes: 4096 });
    expect(ring.add({ type: 4, timestamp: Date.now(), data: { href: 'https://example.test' } })).toBeNull();
    ring.add(snapshot(Date.now()));
    expect(ring.takeLossReport().droppedEvents).toBe(0);
    expect(ring.flush()[0].type).toBe(2);
  });
  it.each(['events', 'bytes', 'age'])('reports %s baseline loss and clears dependent events', async (limit) => {
    vi.useFakeTimers();
    const first = snapshot(Date.now());
    const later = mutation(Date.now() + 1);
    const ring = new RingBuffer(limit === 'age' ? 10 : 60_000, {
      maxBytes: limit === 'bytes' ? byteSize(first) + byteSize(later) + 1 : 4096,
      maxEvents: limit === 'events' ? 2 : 10,
    });
    ring.add(first);
    ring.add(later);
    if (limit === 'age') await vi.advanceTimersByTimeAsync(11);
    const result = ring.add(mutation(Date.now() + 2));
    expect(result?.reason).toBe('baseline_lost');
    expect(result?.droppedEvents).toBeGreaterThan(0);
    expect(ring.size).toBe(0);
  });

  it.each([
    ['future', 1_000_000_000], ['past', -1_000_000_000],
    ['nonfinite', Number.NaN], ['normal', 1_000],
  ])('uses local arrival age for %s rrweb timestamps', async (_label, timestamp) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const event = snapshot(timestamp);
    const ring = new RingBuffer(10, { maxBytes: 4096, maxEvents: 10 });
    ring.add(event);
    await vi.advanceTimersByTimeAsync(9);
    expect(ring.byteSize).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2);
    const lost = ring.add(mutation(timestamp));
    expect(lost?.reason).toBe('baseline_lost');
    expect(event.timestamp).toBe(timestamp);
    expect(ring.size).toBe(0);
  });

  it('requests one fresh error baseline until a full snapshot arrives', async () => {
    const config = resolveReplayConfig({ sessionSampleRate: 0, errorSampleRate: 1, maxBufferSize: 320 }, 'key', 'https://api.test');
    const manager = new SessionManager(config);
    const restart = vi.fn();
    const dropped = vi.fn();
    manager.setRestartCallback(restart);
    manager.setBufferDropCallback(dropped);
    manager.onEvent(snapshot(Date.now()), false);
    for (let i = 0; i < 20; i++) manager.onEvent(mutation(Date.now() + i), false);
    await Promise.resolve();
    expect(restart).toHaveBeenCalledOnce();
    expect(dropped).toHaveBeenCalled();
    manager.onEvent(snapshot(Date.now() + 100), false);
    for (let i = 0; i < 20; i++) manager.onEvent(mutation(Date.now() + 101 + i), false);
    await Promise.resolve();
    expect(restart).toHaveBeenCalledTimes(2);
    manager.destroy();
  });

  it('requests one baseline after local-age expiry despite a future event timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const manager = new SessionManager(resolveReplayConfig({ sessionSampleRate: 0, errorSampleRate: 1 }, 'key', 'https://api.test'));
    const restart = vi.fn();
    const dropped = vi.fn();
    manager.setRestartCallback(restart);
    manager.setBufferDropCallback(dropped);
    manager.onEvent(snapshot(Date.now() + 1_000_000), false);
    await vi.advanceTimersByTimeAsync(60_001);
    manager.onEvent(mutation(Date.now() + 1_000_000), false);
    manager.onEvent(mutation(Date.now() + 1_000_001), false);
    await Promise.resolve();
    expect(restart).toHaveBeenCalledOnce();
    expect(dropped).toHaveBeenCalled();
    manager.destroy();
  });
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
  it('marks the known idle terminal segment final', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const scope = { getUser: () => null, getTags: () => ({}), setTag: () => {}, removeTag: () => {},
      subscribeBreadcrumb: () => () => {} };
    const client = { getConfig: () => ({ enabled: true, apiKey: 'key', endpoint: 'https://api.test' }),
      getScope: () => scope, captureException: () => 'error' };
    const replay = replayIntegration({ sessionSampleRate: 1, idleTimeout: 1000 });
    replay.install(client);
    recorderBridge.emit?.(snapshot(Date.now()), false);
    await vi.advanceTimersByTimeAsync(1001);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1] as any).headers['X-Replay-Final-Segment-Id']).toBe('0');
    replay.teardown?.();
  });

  it('keeps a visibility pause and lost-close beacon nonfinal', () => {
    const listeners = new Map<string, Set<() => void>>();
    const doc = { visibilityState: 'visible',
      addEventListener(name: string, listener: () => void) {
        const group = listeners.get(name) ?? new Set();
        group.add(listener);
        listeners.set(name, group);
      },
      removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); },
    };
    vi.stubGlobal('document', doc);
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const scope = { getUser: () => null, getTags: () => ({}), setTag: () => {}, removeTag: () => {},
      subscribeBreadcrumb: () => () => {} };
    const client = { getConfig: () => ({ enabled: true, apiKey: 'key', endpoint: 'https://api.test' }),
      getScope: () => scope, captureException: () => 'error' };
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(client);
    recorderBridge.emit?.(snapshot(Date.now()), false);
    doc.visibilityState = 'hidden';
    for (const listener of listeners.get('visibilitychange') ?? []) listener();
    expect(beacon).toHaveBeenCalledOnce();
    const params = new URL(beacon.mock.calls[0][0]).searchParams;
    expect(params.get('protocol_version')).toBe('1');
    expect(params.get('dropped_events')).toBe('0');
    expect(params.has('final_segment_id')).toBe(false);
    replay.teardown?.();
  });

  it('marks a known user-boundary segment final with its original identity', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    let userId = 'first';
    const scope = { getUser: () => ({ id: userId }), getTags: () => ({}), setTag: () => {}, removeTag: () => {},
      subscribeBreadcrumb: () => () => {} };
    const client = { getConfig: () => ({ enabled: true, apiKey: 'key', endpoint: 'https://api.test' }),
      getScope: () => scope, captureException: (_error: Error) => 'error' };
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(client);
    const firstId = replay.getSessionId();
    recorderBridge.emit?.(snapshot(Date.now()), false);
    userId = 'second';
    client.captureException(new Error('synthetic'));
    expect(replay.getSessionId()).not.toBe(firstId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toContain(firstId);
    expect((fetchMock.mock.calls[0][1] as any).headers['X-Replay-Final-Segment-Id']).toBe('0');
    replay.teardown?.();
  });

  it('sends version and zero-drop evidence on periodic fetch without a final marker', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const config = resolveReplayConfig({ sessionSampleRate: 1 }, 'key', 'https://api.test');
    const transport = new ReplayTransport(config, { compress: vi.fn(async (events: unknown[]) => {
      const bytes = new TextEncoder().encode(JSON.stringify(events));
      return { compressed: gzipSync(bytes), originalSize: bytes.length };
    }) } as any);
    transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent(snapshot(Date.now()));
    await transport.flush();
    const options = fetchMock.mock.calls[0][1] as any;
    expect(options.headers['X-Replay-Protocol-Version']).toBe('1');
    expect(options.headers['X-Replay-Dropped-Events']).toBe('0');
    expect(options.headers).not.toHaveProperty('X-Replay-Final-Segment-Id');
    expect(JSON.parse(new TextDecoder().decode(gunzipSync(options.body)))).toHaveLength(1);
    transport.destroy();
  });

  it('freezes drop and final metadata with immutable retry bytes', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = resolveReplayConfig({ sessionSampleRate: 1, maxBufferSize: 900,
      retryBaseDelayMs: 10, maxBackoffMs: 10 }, 'key', 'https://api.test');
    const transport = new ReplayTransport(config, { compress: vi.fn(async (events: unknown[]) => {
      const bytes = new TextEncoder().encode(JSON.stringify(events));
      return { compressed: gzipSync(bytes), originalSize: bytes.length };
    }) } as any);
    transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent(snapshot(Date.now()));
    const flushing = transport.flush(true);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 100; i++) transport.addEvent({ type: 5, timestamp: Date.now() + i,
      data: { tag: 'console-log', payload: { level: 'log' } } });
    expect(transport.getStatus().droppedEvents).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(20);
    await flushing;
    const first = fetchMock.mock.calls[0][1] as any;
    const second = fetchMock.mock.calls[1][1] as any;
    expect(first.headers['X-Replay-Final-Segment-Id']).toBe('0');
    expect(first.headers['X-Replay-Dropped-Events']).toBe('0');
    expect(second.headers).toEqual(first.headers);
    expect(Buffer.from(second.body)).toEqual(Buffer.from(first.body));
    transport.destroy();
  });

  it('reports cumulative drops for each session without carrying older losses forward', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    let identity = 'a'.repeat(32);
    let segment = 0;
    const transport = new ReplayTransport(resolveReplayConfig({ sessionSampleRate: 1 }, 'key', 'https://api.test'),
      { compress: vi.fn(async (events: unknown[]) => {
        const bytes = new TextEncoder().encode(JSON.stringify(events));
        return { compressed: gzipSync(bytes), originalSize: bytes.length };
      }) } as any);
    transport.start(() => identity, () => segment++, () => 'session', () => '', () => '');
    transport.stop();
    transport.recordDroppedEvents(4, 40);
    transport.addEvent(snapshot(Date.now()));
    await transport.flush();
    identity = 'b'.repeat(32);
    segment = 0;
    transport.setSessionIdentity(identity);
    transport.recordDroppedEvents(1, 10);
    transport.addEvent(snapshot(Date.now() + 1));
    await transport.flush();
    expect(fetchMock.mock.calls.map((call) => (call[1] as any).headers['X-Replay-Dropped-Events'])).toEqual(['4', '1']);
    transport.destroy();
  });

  it('does not charge a late old-session failure to the new session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let compressionCall = 0;
    const worker = { compress: vi.fn(async (events: unknown[]) => {
      compressionCall++;
      if (compressionCall === 1) { await gate; throw new Error('synthetic worker failure'); }
      const bytes = new TextEncoder().encode(JSON.stringify(events));
      return { compressed: gzipSync(bytes), originalSize: bytes.length };
    }) };
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    let identity = 'a'.repeat(32);
    const transport = new ReplayTransport(resolveReplayConfig({ sessionSampleRate: 1 }, 'key', 'https://api.test'), worker as any);
    transport.start(() => identity, () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent(snapshot(Date.now()));
    const oldFlush = transport.flush();
    identity = 'b'.repeat(32);
    transport.setSessionIdentity(identity);
    release();
    await oldFlush;
    transport.addEvent(snapshot(Date.now() + 1));
    await transport.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1] as any).headers['X-Replay-Dropped-Events']).toBe('0');
    expect(transport.getStatus().droppedChunks).toBe(1);
    transport.destroy();
  });

  it.each([true, false])('sends version and drops on %s beacon acceptance', async (accepted) => {
    const beacon = vi.fn(() => accepted);
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', fetchMock);
    const transport = new ReplayTransport(resolveReplayConfig({ sessionSampleRate: 1 }, 'key', 'https://api.test'),
      { compress: vi.fn() } as any);
    transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
    transport.stop();
    transport.recordDroppedEvents(7, 70);
    transport.addEvent(snapshot(Date.now()));
    transport.flushSync();
    const [url, blob] = accepted ? beacon.mock.calls[0] : fetchMock.mock.calls[0];
    const params = new URL(url).searchParams;
    expect(params.get('protocol_version')).toBe('1');
    expect(params.get('dropped_events')).toBe('7');
    expect(params.has('final_segment_id')).toBe(false);
    const body = accepted ? blob : (fetchMock.mock.calls[0][1] as any).body;
    expect(JSON.parse(new TextDecoder().decode(gunzipSync(new Uint8Array(await body.arrayBuffer()))))).toHaveLength(1);
    expect(transport.getStatus().acknowledgedChunks).toBe(accepted ? 0 : 1);
    transport.destroy();
  });

  it('settles a synchronous segment callback error and permits a later flush', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new ReplayTransport(resolveReplayConfig({ sessionSampleRate: 1 }, 'key', 'https://api.test'),
      { compress: vi.fn(async (events: unknown[]) => {
        const bytes = new TextEncoder().encode(JSON.stringify(events));
        return { compressed: gzipSync(bytes), originalSize: bytes.length };
      }) } as any);
    const segment = vi.fn().mockImplementationOnce(() => { throw new Error('unsafe'); }).mockReturnValueOnce(1);
    transport.start(() => 'a'.repeat(32), segment, () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent(snapshot(Date.now()));
    await transport.flush();
    expect(transport.getStatus().droppedChunks).toBe(1);
    expect(transport.getStatus().queueChunks).toBe(0);
    transport.addEvent(snapshot(Date.now() + 1));
    await transport.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(segment).toHaveBeenCalledTimes(2);
    transport.destroy();
  });

  it('recovers after SessionManager rotates an unsafe segment counter', async () => {
    const config = resolveReplayConfig({ sessionSampleRate: 1 }, 'key', 'https://api.test');
    const manager = new SessionManager(config);
    const initialId = manager.getFlushSessionId();
    (manager as any).state.segmentId = 0x7fff_ffff;
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new ReplayTransport(config, { compress: vi.fn(async (events: unknown[]) => {
      const bytes = new TextEncoder().encode(JSON.stringify(events));
      return { compressed: gzipSync(bytes), originalSize: bytes.length };
    }) } as any);
    transport.start(() => manager.getFlushSessionId(), () => manager.nextSegmentId(), () => 'session', () => '', () => '');
    transport.stop();
    transport.addEvent(snapshot(Date.now()));
    await transport.flush();
    expect(manager.getFlushSessionId()).not.toBe(initialId);
    expect(transport.getStatus().droppedChunks).toBe(1);
    transport.addEvent(snapshot(Date.now() + 1));
    await transport.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    manager.destroy();
    transport.destroy();
  });
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
