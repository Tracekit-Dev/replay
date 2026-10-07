import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replayIntegration } from '../src/index';
import { CompressionWorker } from '../src/compression';
import { ReplayTransport } from '../src/transport';

const recorder = vi.hoisted(() => ({ starts: 0, stops: 0, failStart: false, emit: null as null | ((event: any, checkout: boolean) => void) }));
vi.mock('../src/recorder', () => ({
  startRecording: vi.fn((_config, emit) => {
    recorder.starts++;
    recorder.emit = emit;
    if (recorder.failStart) return null;
    return () => { recorder.stops++; };
  }),
}));

function client(enabled = true, withSubscription = true, withTag = true) {
  const tags = new Map(withTag ? [['replay_id', 'host-value']] : []);
  const listeners = new Set<(crumb: any) => void>();
  const scope = {
    getUser: () => null,
    getTags: () => Object.fromEntries(tags),
    setTag: (name: string, value: string) => { tags.set(name, value); },
    removeTag: (name: string) => { tags.delete(name); },
    ...(withSubscription ? { subscribeBreadcrumb: (listener: (crumb: any) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    } } : {}),
  };
  const original = vi.fn(() => 'error-id');
  return {
    enabled,
    scope,
    tags,
    listeners,
    original,
    getConfig() { return { apiKey: 'test-key', endpoint: 'https://example.test', enabled: this.enabled }; },
    getScope: () => scope,
    captureException: original as (error: Error) => string,
  };
}

beforeEach(() => { recorder.starts = 0; recorder.stops = 0; recorder.failStart = false; recorder.emit = null; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Replay privacy lifecycle', () => {
  it('releases an identity failure before allocating resources and retries after crypto returns', async () => {
    vi.useFakeTimers();
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);
    const fetchMock = vi.fn();
    const beacon = vi.fn(() => true);
    const storageRead = vi.fn();
    vi.stubGlobal('sessionStorage', { getItem: storageRead });
    vi.stubGlobal('localStorage', { getItem: storageRead });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const blobUrl = vi.spyOn(URL, 'createObjectURL');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const OriginalAbortController = globalThis.AbortController;
    let controllers = 0;
    vi.stubGlobal('AbortController', class extends OriginalAbortController {
      constructor() { super(); controllers++; }
    });
    const host = client();
    const replay = replayIntegration({ sessionSampleRate: 1, flushInterval: 5 });
    replay.install(host);
    expect(replay.getSessionId()).toBe('');
    expect(recorder.starts).toBe(0);
    expect(blobUrl).not.toHaveBeenCalled();
    expect(controllers).toBe(0);
    expect(interval).not.toHaveBeenCalled();
    expect(host.listeners.size).toBe(0);
    expect(host.captureException).toBe(host.original);
    expect(vi.getTimerCount()).toBe(0);
    expect(storageRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    replay.flush();
    expect(replay.getSessionId()).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();

    vi.stubGlobal('crypto', originalCrypto);
    replay.start();
    expect(replay.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
    expect(recorder.starts).toBe(1);
    expect(host.listeners.size).toBe(1);
    replay.teardown?.();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.listeners.size).toBe(0);
    expect(host.captureException).toBe(host.original);
  });

  it('keeps a valid hidden session eligible for visibility resume', () => {
    const listeners = new Map<string, Set<() => void>>();
    const doc = {
      visibilityState: 'hidden',
      addEventListener(name: string, listener: () => void) {
        const group = listeners.get(name) ?? new Set();
        group.add(listener);
        listeners.set(name, group);
      },
      removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); },
    };
    vi.stubGlobal('document', doc);
    const host = client();
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    expect(recorder.starts).toBe(0);
    expect(replay.getSessionId()).toBe('');
    expect(host.listeners.size).toBe(1);
    doc.visibilityState = 'visible';
    for (const listener of listeners.get('visibilitychange') ?? []) listener();
    expect(recorder.starts).toBe(1);
    expect(replay.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
    replay.teardown?.();
  });

  it('reports idle after capture expires', async () => {
    vi.useFakeTimers();
    const host = client();
    const replay = replayIntegration({ sessionSampleRate: 1, idleTimeout: 1_000, flushInterval: 30_000 });
    replay.install(host);
    expect(replay.getStatus().captureState).toBe('recording');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(replay.getSessionId()).toBe('');
    expect(replay.getStatus().captureState).toBe('idle');
    replay.teardown?.();
  });

  it('keeps a sampled-out identity without starting a recorder', () => {
    const host = client();
    const replay = replayIntegration({ sessionSampleRate: 0, errorSampleRate: 0 });
    replay.install(host);
    expect(replay.getSessionId()).toBe('');
    expect(recorder.starts).toBe(0);
    expect(host.listeners.size).toBe(1);
    replay.teardown?.();
    expect(host.listeners.size).toBe(0);
  });

  it('discards every resource when rrweb returns no recorder and permits a clean explicit start', async () => {
    vi.useFakeTimers();
    recorder.failStart = true;
    const fetchMock = vi.fn();
    const beacon = vi.fn(() => true);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const workerDestroy = vi.spyOn(CompressionWorker.prototype, 'destroy');
    const transportDestroy = vi.spyOn(ReplayTransport.prototype, 'destroy');
    const host = client();
    const replay = replayIntegration({ sessionSampleRate: 1, flushInterval: 5 });
    replay.install(host);
    // Browser reads this value synchronously for the first automatic pageview.
    expect(replay.getSessionId()).toBe('');
    await Promise.resolve();
    expect(recorder.starts).toBe(1);
    expect(replay.getSessionId()).toBe('');
    expect(host.listeners.size).toBe(0);
    expect(host.captureException).toBe(host.original);
    expect(workerDestroy).toHaveBeenCalledTimes(1);
    expect(transportDestroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    replay.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();

    recorder.failStart = false;
    replay.start();
    await Promise.resolve();
    expect(recorder.starts).toBe(2);
    expect(replay.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
    expect(host.listeners.size).toBe(1);
    replay.teardown?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not allocate resources on disabled install or denied start', async () => {
    const host = client(false);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    await Promise.resolve();
    expect(replay.getSessionId()).toBe('');
    expect(recorder.starts).toBe(0);
    expect(host.listeners.size).toBe(0);
    expect(timer).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    replay.start();
    expect(recorder.starts).toBe(0);
    replay.teardown?.();
  });

  it('stops synchronously, rejects late events, and starts with a fresh identity', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const host = client();
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    await vi.waitFor(() => expect(recorder.starts).toBe(1));
    const oldId = replay.getSessionId();
    const lateEmit = recorder.emit!;
    replay.stop();
    expect(recorder.stops).toBe(1);
    expect(host.listeners.size).toBe(0);
    expect(replay.getSessionId()).toBe('');
    lateEmit({ type: 2, timestamp: Date.now() }, false);
    replay.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    replay.stop();
    expect(recorder.stops).toBe(1);
    replay.start();
    await vi.waitFor(() => expect(recorder.starts).toBe(2));
    expect(replay.getSessionId()).not.toBe(oldId);
    expect(host.listeners.size).toBe(1);
    replay.teardown?.();
  });

  it('keeps the first automatic pageview linked to a successful synchronous recorder', () => {
    const host = client();
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    expect(recorder.starts).toBe(1);
    expect(replay.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
    replay.teardown?.();
  });

  it('stops a recorder immediately after install', () => {
    const host = client();
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    replay.stop();
    expect(recorder.starts).toBe(1);
    expect(recorder.stops).toBe(1);
    expect(host.listeners.size).toBe(0);
    expect(replay.getSessionId()).toBe('');
    replay.teardown?.();
  });

  it('respects enablement changes and restores only its own wrapper and tag', async () => {
    const host = client();
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    await vi.waitFor(() => expect(recorder.starts).toBe(1));
    const replayWrapper = host.captureException;
    expect(replayWrapper).not.toBe(host.original);
    host.original.mockImplementationOnce(() => { throw new Error('host failed'); });
    expect(() => host.captureException(new Error('test'))).toThrow('host failed');
    expect(host.tags.get('replay_id')).toBe('host-value');
    host.enabled = false;
    replay.stop();
    replay.start();
    expect(recorder.starts).toBe(1);
    host.captureException = ((error: Error) => replayWrapper(error)) as typeof host.captureException;
    const laterWrapper = host.captureException;
    replay.teardown?.();
    expect(host.captureException).toBe(laterWrapper);
  });

  it('keeps old Browser bundles usable without an unowned breadcrumb listener', async () => {
    const host = client(true, false);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    await vi.waitFor(() => expect(recorder.starts).toBe(1));
    expect(warning.mock.calls.some(([value]) => String(value).toLowerCase().includes('breadcrumb'))).toBe(true);
    replay.teardown?.();
  });

  it('restores an absent replay tag after error capture', async () => {
    const host = client(true, true, false);
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    await vi.waitFor(() => expect(recorder.starts).toBe(1));
    host.captureException(new Error('synthetic'));
    expect(host.tags.has('replay_id')).toBe(false);
    replay.teardown?.();
  });

  it('does not add an unremovable replay tag on an older Browser scope', async () => {
    const host = client(true, false, false);
    delete (host.scope as { removeTag?: (name: string) => void }).removeTag;
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    await vi.waitFor(() => expect(recorder.starts).toBe(1));
    host.captureException(new Error('synthetic'));
    expect(host.tags.has('replay_id')).toBe(false);
    replay.teardown?.();
  });

  it('reinitializes without retaining a second recorder or changing the host error method', async () => {
    const firstHost = client();
    const first = replayIntegration({ sessionSampleRate: 1 });
    first.install(firstHost);
    await vi.waitFor(() => expect(recorder.starts).toBe(1));
    const oldId = first.getSessionId();
    first.teardown?.();
    expect(firstHost.captureException).toBe(firstHost.original);
    const secondHost = client();
    const second = replayIntegration({ sessionSampleRate: 1 });
    second.install(secondHost);
    await vi.waitFor(() => expect(recorder.starts).toBe(2));
    expect(recorder.stops).toBe(1);
    expect(second.getSessionId()).not.toBe(oldId);
    second.teardown?.();
  });

  it('cleans a partially installed bridge when subscription fails', async () => {
    const host = client();
    const original = host.captureException;
    host.scope.subscribeBreadcrumb = () => { throw new Error('subscription failed'); };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replay = replayIntegration({ sessionSampleRate: 1 });
    replay.install(host);
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(host.captureException).toBe(original);
    expect(replay.getSessionId()).toBe('');
    replay.teardown?.();
  });
});
