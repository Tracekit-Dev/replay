import { afterEach, describe, expect, it, vi } from 'vitest';
import { record } from 'rrweb';
import { replayIntegration } from '../src/index';
import { SessionManager } from '../src/session';
import { ReplayTransport } from '../src/transport';
import type { ResolvedReplayConfig } from '../src/types';

vi.mock('rrweb', () => ({ record: vi.fn(() => vi.fn()) }));

class FakeDocument {
  visibilityState: 'visible' | 'hidden' = 'visible';
  private listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(name: string, handler: (event: Event) => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(handler);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, handler: (event: Event) => void): void {
    this.listeners.get(name)?.delete(handler);
  }

  dispatch(name: string, event = new Event(name)): void {
    this.listeners.get(name)?.forEach((handler) => handler(event));
  }
}

function config(): ResolvedReplayConfig {
  return {
    sessionSampleRate: 1,
    errorSampleRate: 0,
    unmask: [],
    idleTimeout: 1_000,
    flushInterval: 30_000,
    maxBufferSize: 1_000,
    inlineImages: false,
    blockMedia: true,
    serviceName: 'checkout',
    identityUserId: '',
    apiKey: 'key',
    endpoint: 'http://localhost',
  };
}

function storageMap() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('Replay privacy lifecycle', () => {
  const document = new FakeDocument();

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.visibilityState = 'visible';
  });

  it('stops callbacks and automatic resume, then starts a fresh identity explicitly', () => {
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storageMap());
    const manager = new SessionManager(config());
    const firstId = manager.getSessionId();
    const emitted: unknown[] = [];
    let restarts = 0;
    manager.setEventCallback((events) => emitted.push(...events));
    manager.setRestartCallback(() => { restarts++; });

    manager.stop();
    document.dispatch('pointerdown', new Event('pointerdown'));
    document.dispatch('visibilitychange');
    manager.onEvent({ type: 2, timestamp: Date.now() }, false);
    manager.onError();

    expect(manager.getSessionId()).toBe('');
    expect(emitted).toEqual([]);
    expect(restarts).toBe(0);

    manager.start();
    expect(manager.getSessionId()).not.toBe(firstId);
    manager.destroy();
  });

  it('does not reuse a privacy-revoked identity after a new manager installs', () => {
    const storage = storageMap();
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storage);
    const first = new SessionManager(config());
    const firstId = first.getSessionId();
    first.stop();
    first.destroy();

    const second = new SessionManager(config());
    expect(second.getSessionId()).not.toBe(firstId);
    second.destroy();
  });

  it('keeps an idle session inactive when its ID is queried again', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storageMap());
    const manager = new SessionManager(config());

    vi.advanceTimersByTime(1_001);
    expect(manager.getSessionId()).toBe('');
    expect(manager.getSessionId()).toBe('');
    manager.destroy();
  });

  it('creates no Replay resources when the host SDK is disabled', () => {
    const storage = storageMap();
    const worker = vi.fn();
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('Worker', worker);
    const replay = replayIntegration({ sessionSampleRate: 1 });
    const scope = {
      getUser: () => null,
      subscribeBreadcrumb: vi.fn(),
      setTag: vi.fn(),
    };

    replay.install({
      getConfig: () => ({ enabled: false, apiKey: 'key', endpoint: 'http://localhost', serviceName: 'checkout' }),
      getScope: () => scope,
      captureException: vi.fn(),
    });

    replay.start();
    replay.flush();
    expect(replay.getSessionId()).toBe('');
    expect(worker).not.toHaveBeenCalled();
    expect(storage.values).toHaveLength(0);
    expect(scope.subscribeBreadcrumb).not.toHaveBeenCalled();
  });

  it('keeps one recorder per active lifecycle and restores the host wrapper', () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storageMap());
    const originalCaptureException = vi.fn(() => 'event-id');
    const scope = {
      getUser: () => null,
      subscribeBreadcrumb: vi.fn(() => vi.fn()),
      setTag: vi.fn(),
    };
    const client = {
      getConfig: () => ({ enabled: true, apiKey: 'key', endpoint: 'http://localhost', serviceName: 'checkout' }),
      getScope: () => scope,
      captureException: originalCaptureException,
    };
    const replay = replayIntegration({ sessionSampleRate: 1, idleTimeout: 10_000, flushInterval: 10_000 });

    replay.install(client);
    const firstId = replay.getSessionId();
    expect(record).toHaveBeenCalledTimes(1);
    const wrappedCaptureException = client.captureException;

    replay.stop();
    document.dispatch('pointerdown', new Event('pointerdown'));
    expect(replay.getSessionId()).toBe('');
    expect(record).toHaveBeenCalledTimes(1);

    replay.start();
    expect(replay.getSessionId()).not.toBe(firstId);
    expect(record).toHaveBeenCalledTimes(2);
    expect(client.captureException).toBe(wrappedCaptureException);

    replay.teardown();
    expect(client.captureException).toBe(originalCaptureException);
  });

  it('restores an existing host replay tag after captureException', () => {
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storageMap());
    const originalCaptureException = vi.fn(() => 'event-id');
    const scope = {
      getUser: () => null,
      getTags: () => ({ replay_id: 'host-replay-id' }),
      subscribeBreadcrumb: vi.fn(() => vi.fn()),
      setTag: vi.fn(),
    };
    const client = {
      getConfig: () => ({ enabled: true, apiKey: 'key', endpoint: 'http://localhost', serviceName: 'checkout' }),
      getScope: () => scope,
      captureException: originalCaptureException,
    };
    const replay = replayIntegration({ sessionSampleRate: 1 });

    replay.install(client);
    client.captureException(new Error('test'));

    expect(scope.setTag).toHaveBeenCalledWith('replay_id', 'host-replay-id');
    replay.teardown();
  });

  it('reinitializes one addon instance with one stopped old recorder and one new recorder', () => {
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storageMap());
    vi.mocked(record).mockClear();
    const scope = {
      getUser: () => null,
      subscribeBreadcrumb: vi.fn(() => vi.fn()),
      setTag: vi.fn(),
    };
    const client = {
      getConfig: () => ({ enabled: true, apiKey: 'key', endpoint: 'http://localhost', serviceName: 'checkout' }),
      getScope: () => scope,
      captureException: vi.fn(() => 'event-id'),
    };
    const replay = replayIntegration({ sessionSampleRate: 1 });

    replay.install(client);
    const firstStop = vi.mocked(record).mock.results[0]?.value as ReturnType<typeof vi.fn>;
    replay.teardown();
    expect(firstStop).toHaveBeenCalledTimes(1);

    replay.install(client);
    const secondStop = vi.mocked(record).mock.results[1]?.value as ReturnType<typeof vi.fn>;
    expect(vi.mocked(record)).toHaveBeenCalledTimes(2);
    expect(secondStop).not.toBe(firstStop);
    expect(secondStop).not.toHaveBeenCalled();
    replay.teardown();
    expect(secondStop).toHaveBeenCalledTimes(1);
  });

  it('blocks a late compression result after transport destruction', async () => {
    vi.useFakeTimers();
    const compressionResult: { resolve?: (value: { compressed: Uint8Array; originalSize: number }) => void } = {};
    const worker = {
      compress: vi.fn(() => new Promise<{ compressed: Uint8Array; originalSize: number }>((resolve) => {
        compressionResult.resolve = resolve;
      })),
    };
    const transport = new ReplayTransport(config(), worker as any);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    transport.start(() => 'session-id', () => 0, () => 'session', () => '', () => '');
    transport.addEvent({ type: 2, timestamp: Date.now() });
    const flush = transport.flush();
    transport.destroy();
    compressionResult.resolve?.({ compressed: new Uint8Array([1]), originalSize: 1 });

    await flush;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cancels delayed retry waits after transport destruction', async () => {
    vi.useFakeTimers();
    const worker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
    const transport = new ReplayTransport(config(), worker as any);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchSpy);
    transport.start(() => 'session-id', () => 0, () => 'session', () => '', () => '');
    transport.addEvent({ type: 2, timestamp: Date.now() });
    const flush = transport.flush();
    await Promise.resolve();
    await Promise.resolve();
    transport.destroy();

    await flush;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts an active upload when transport destruction occurs', async () => {
    const worker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
    const transport = new ReplayTransport(config(), worker as any);
    let aborted = false;
    const fetchSpy = vi.fn((_url: string, request: RequestInit) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    }));
    vi.stubGlobal('fetch', fetchSpy);
    transport.start(() => 'session-id', () => 0, () => 'session', () => '', () => '');
    transport.addEvent({ type: 2, timestamp: Date.now() });
    const flush = transport.flush();
    await Promise.resolve();
    await Promise.resolve();
    transport.destroy();

    await flush;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(aborted).toBe(true);
  });
});
