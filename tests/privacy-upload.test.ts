import { afterEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync, gzipSync } from 'fflate';
import { resolveReplayConfig } from '../src/config';
import { ReplayTransport } from '../src/transport';
import { CompressionWorker } from '../src/compression';
import { replayIntegration } from '../src/index';
import { SessionManager } from '../src/session';
import { sanitizeReplayEvent } from '../src/privacy';

const recorder = vi.hoisted(() => ({ emit: null as null | ((event: any, checkout: boolean) => void) }));
vi.mock('../src/recorder', () => ({ startRecording: vi.fn((_config, emit) => { recorder.emit = emit; return () => {}; }) }));

const decode = (bytes: Uint8Array) => new TextDecoder().decode(gunzipSync(bytes));
const canary = 'synthetic-secret-canary';
const secretEvent = { type: 5, timestamp: 100, data: { tag: 'console-log', payload: { level: 'error', message: canary, data: { nested: { secret: canary } }, stack: canary } } };
const urlEvent = { type: 4, timestamp: 101, data: { href: `https://user:${canary}@site.test/path?token=${canary}#${canary}`, width: 100, height: 100 } };

function transport(replayConfig: Parameters<typeof resolveReplayConfig>[0] = {}) {
  const config = resolveReplayConfig(replayConfig, 'test-key', 'https://api.test');
  const worker = { compress: vi.fn(async (events: any[]) => {
    const encoded = new TextEncoder().encode(JSON.stringify(events));
    return { compressed: gzipSync(encoded), originalSize: encoded.length };
  }) };
  const instance = new ReplayTransport(config, worker as any);
  let segment = 0;
  instance.start(() => 'a'.repeat(32), () => segment++, () => 'session', () => `https://user:${canary}@site.test/page?token=${canary}#${canary}`, () => canary);
  instance.stop();
  return instance;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('serialized privacy upload paths', () => {
  it('drops malformed snapshot and mutation canaries from fetch and retry bytes', async () => {
    vi.stubGlobal('document', { querySelector: () => null, createElement: () => { throw new Error('InvalidCharacterError'); } });
    vi.useFakeTimers();
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return { ok: calls.length === 2, status: calls.length === 2 ? 200 : 500 };
    }));
    const instance = transport({ unmask: ['.public'] });
    const malformed = { type: 2, timestamp: 1, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: 'div>', attributes: { class: 'not-public' }, childNodes: [{ type: 3, id: 3, textContent: canary }] },
    ] } } };
    instance.addEvent(malformed);
    instance.addEvent({ type: 3, timestamp: 2, data: { source: 0, adds: [{ parentId: 2, nextId: null, node: { type: 2, id: 4, tagName: 'div', attributes: { 'bad>attribute': canary }, childNodes: [{ type: 3, id: 5, textContent: canary }] } }], texts: [], attributes: [], removes: [] } });
    instance.addEvent({ type: 2, timestamp: 3, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 10, childNodes: [] } } });
    instance.addEvent(urlEvent);
    const pending = instance.flush();
    await vi.runAllTimersAsync();
    await pending;
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(decode(call.body as Uint8Array)).not.toContain(canary);
    instance.destroy();
    vi.useRealTimers();
  });

  it('drops malformed snapshot and attribute canaries from beacon and keepalive bytes', async () => {
    vi.stubGlobal('document', { querySelector: () => null, createElement: () => { throw new Error('InvalidCharacterError'); } });
    const beacon = vi.fn(() => false);
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', fetchMock);
    const instance = transport({ unmask: ['.public'] });
    instance.addEvent({ type: 2, timestamp: 1, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: 'div>', attributes: { class: 'not-public', 'bad>attribute': canary }, childNodes: [{ type: 3, id: 3, textContent: canary }] },
    ] } } });
    instance.addEvent({ type: 2, timestamp: 3, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 10, childNodes: [] } } });
    instance.addEvent(urlEvent);
    instance.flushSync();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(decode(new Uint8Array(await beacon.mock.calls[0][1].arrayBuffer()))).not.toContain(canary);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decode(new Uint8Array(await fetchMock.mock.calls[0][1].body.arrayBuffer()))).not.toContain(canary);
    instance.destroy();
  });

  it('rejects mutation of every sanitized graph before transport compression', async () => {
    const safe = sanitizeReplayEvent(secretEvent);
    expect(safe).not.toBeNull();
    try { safe.data.payload.message = 'synthetic-mutated-canary'; } catch { /* Frozen graphs may reject writes. */ }
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(init); return { ok: true }; }));
    const instance = transport();
    instance.addEvent(safe);
    await instance.flush();
    expect(calls).toHaveLength(1);
    expect(decode(calls[0].body as Uint8Array)).not.toContain('synthetic-mutated-canary');
    instance.destroy();
  });

  it('sanitizes rrweb output before the session and error ring buffer', () => {
    const onEvent = vi.spyOn(SessionManager.prototype, 'onEvent');
    const scope = { getUser: () => null, getTags: () => ({}), setTag: () => {}, removeTag: () => {}, subscribeBreadcrumb: () => () => {} };
    const host = { getConfig: () => ({ apiKey: 'test-key', endpoint: 'https://api.test', enabled: true }), getScope: () => scope, captureException: () => '' };
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    expect(recorder.emit).not.toBeNull();
    recorder.emit!(secretEvent, false);
    expect(JSON.stringify(onEvent.mock.lastCall?.[0])).not.toContain(canary);
    replay.teardown?.();
  });

  it('removes canaries from fetch and immutable retry bodies and headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 500 };
    }));
    vi.useFakeTimers();
    const instance = transport();
    instance.addEvent(secretEvent);
    instance.addEvent(urlEvent);
    const pending = instance.flush();
    await vi.runAllTimersAsync();
    await pending;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(decode(call.init.body as Uint8Array)).not.toContain(canary);
      expect(JSON.stringify(call.init.headers)).not.toContain(canary);
      expect(call.url).not.toContain(canary);
    }
    expect(calls[0].init.body).toEqual(calls[1].init.body);
    instance.destroy();
    vi.useRealTimers();
  });

  it('removes canaries from beacon body, URL, and keepalive fallback', async () => {
    const beacon = vi.fn(() => false);
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('navigator', { sendBeacon: beacon, userAgent: canary });
    vi.stubGlobal('fetch', fetchMock);
    const instance = transport();
    instance.addEvent(secretEvent);
    instance.addEvent(urlEvent);
    instance.flushSync();
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0];
    expect(url).not.toContain(canary);
    expect(decode(new Uint8Array(await body.arrayBuffer()))).not.toContain(canary);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [fallbackUrl, fallbackInit] = fetchMock.mock.calls[0];
    expect(fallbackUrl).not.toContain(canary);
    expect(decode(new Uint8Array(await fallbackInit.body.arrayBuffer()))).not.toContain(canary);
    instance.destroy();
  });

  it('revokes a Blob URL when Worker construction is blocked', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked'); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = new CompressionWorker();
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:synthetic');
    worker.destroy();
  });
});
