import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replayIntegration } from '../src/index';

const recorder = vi.hoisted(() => ({ starts: 0, stops: 0, emit: null as null | ((event: any, checkout: boolean) => void) }));
vi.mock('../src/recorder', () => ({
  startRecording: vi.fn((_config, emit) => {
    recorder.starts++;
    recorder.emit = emit;
    return () => { recorder.stops++; };
  }),
}));

function client(enabled = true, withSubscription = true) {
  const tags = new Map([['replay_id', 'host-value']]);
  const listeners = new Set<(crumb: any) => void>();
  const scope = {
    getUser: () => null,
    getTags: () => Object.fromEntries(tags),
    setTag: (name: string, value: string) => { tags.set(name, value); },
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

beforeEach(() => { recorder.starts = 0; recorder.stops = 0; recorder.emit = null; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Replay privacy lifecycle', () => {
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
    replay.stop();
    expect(recorder.stops).toBe(1);
    replay.start();
    await vi.waitFor(() => expect(recorder.starts).toBe(2));
    expect(replay.getSessionId()).not.toBe(oldId);
    expect(host.listeners.size).toBe(1);
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
    expect(warning.mock.calls.some(([value]) => String(value).includes('breadcrumb'))).toBe(true);
    replay.teardown?.();
  });
});
