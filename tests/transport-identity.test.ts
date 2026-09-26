import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayTransport } from '../src/transport';
import { SessionManager } from '../src/session';
import type { ResolvedReplayConfig } from '../src/types';

class FakeDocument {
  visibilityState: 'visible' | 'hidden' = 'visible';
  addEventListener(): void {}
  removeEventListener(): void {}
}

function config(): ResolvedReplayConfig {
  return {
    sessionSampleRate: 1,
    errorSampleRate: 0,
    unmask: [],
    idleTimeout: 30_000,
    flushInterval: 30_000,
    maxBufferSize: 10_000,
    inlineImages: false,
    blockMedia: true,
    apiKey: 'secret-api-key',
    endpoint: 'https://collector.example.test',
    serviceName: 'checkout',
    identityUserId: '',
  };
}

function storageMap() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function transport(manager: SessionManager) {
  const compressionWorker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
  const instance = new ReplayTransport(config(), compressionWorker as any);
  let segment = 0;
  instance.start(
    () => manager.getSessionId(),
    () => segment++,
    () => manager.getMode(),
    () => '',
    () => '',
    () => Date.now() + 30_000,
    () => manager.allocateSegment(),
    () => manager.getIdentity(),
  );
  return instance;
}

describe('transport identity attribution', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('discards pending events when a competing claim changes the allocation', async () => {
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('sessionStorage', storageMap());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const first = new SessionManager(config());
    const replay = transport(first);
    first.setFlushCallback(() => { void replay.flush(); });
    replay.addEvent({ type: 3, timestamp: Date.now() });
    const competing = new SessionManager(config());

    await replay.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetch).not.toHaveBeenCalled();
    replay.destroy();
    first.destroy();
    competing.destroy();
  });

  it('discards old-user events when the user boundary changes', async () => {
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('sessionStorage', storageMap());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    let userId = 'user-a';
    const manager = new SessionManager(config());
    manager.setUserIdentityProvider(() => userId);
    const replay = transport(manager);
    manager.setFlushCallback(() => { void replay.flush(); });
    const oldIdentity = manager.getIdentity();
    replay.addEvent({ type: 3, timestamp: Date.now() });
    userId = 'user-b';
    manager.getSessionId();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await replay.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain(`/api/replays/${oldIdentity.sessionId}/chunks`);
    expect((request.headers as Record<string, string>)['X-Segment-Id']).toBe('0');
    expect((request.headers as Record<string, string>)['X-Replay-User-Id']).toBe('user-a');
    replay.destroy();
    manager.destroy();
  });

  it('freezes the allocated session, segment, and user values for upload', async () => {
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('sessionStorage', storageMap());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    let userId = 'user-a';
    const manager = new SessionManager(config());
    manager.setUserIdentityProvider(() => userId);
    const replay = transport(manager);
    const identity = manager.getIdentity();
    replay.addEvent({ type: 3, timestamp: Date.now() });
    userId = 'user-b';

    await replay.flush();

    expect(fetch).not.toHaveBeenCalled();
    // A user change after buffering discards the pending event.
    userId = 'user-a';
    manager.getSessionId();
    replay.addEvent({ type: 3, timestamp: Date.now() });
    await replay.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain(`/api/replays/${manager.getSessionId()}/chunks`);
    expect((request.headers as Record<string, string>)['X-Segment-Id']).toBe('0');
    expect((request.headers as Record<string, string>)['X-Replay-User-Id']).toBe('user-a');
    expect(identity.sessionId).not.toBe(manager.getSessionId());
    replay.destroy();
    manager.destroy();
  });

  it('uploads old buffered data and the synchronous restarted snapshot separately', async () => {
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('sessionStorage', storageMap());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    let userId = 'user-a';
    const manager = new SessionManager(config());
    manager.setUserIdentityProvider(() => userId);
    const replay = transport(manager);
    manager.setFlushCallback(() => { void replay.flush(); });
    const oldIdentity = manager.getIdentity();
    replay.addEvent({ type: 3, timestamp: Date.now() });
    manager.setRestartCallback(() => {
      replay.addEvent({ type: 2, timestamp: Date.now() });
    });

    userId = 'user-b';
    const newSessionId = manager.getSessionId();
    await replay.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetch).toHaveBeenCalledTimes(2);
    const uploads = vi.mocked(fetch).mock.calls.map(([url, request]) => ({
      url,
      sessionId: String(url).split('/api/replays/')[1].split('/chunks')[0],
      segmentId: (request.headers as Record<string, string>)['X-Segment-Id'],
      userId: (request.headers as Record<string, string>)['X-Replay-User-Id'],
    }));
    expect(uploads).toContainEqual({ url: expect.stringContaining(oldIdentity.sessionId), sessionId: oldIdentity.sessionId, segmentId: '0', userId: 'user-a' });
    expect(uploads).toContainEqual({ url: expect.stringContaining(newSessionId), sessionId: newSessionId, segmentId: '0', userId: 'user-b' });
    expect(newSessionId).not.toBe(oldIdentity.sessionId);
    replay.destroy();
    manager.destroy();
  });
});
