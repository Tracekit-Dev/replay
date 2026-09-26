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
    replay.addEvent({ type: 3, timestamp: Date.now() });
    const competing = new SessionManager(config());

    await replay.flush();

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
    replay.addEvent({ type: 3, timestamp: Date.now() });
    userId = 'user-b';
    manager.getSessionId();

    await replay.flush();

    expect(fetch).not.toHaveBeenCalled();
    replay.destroy();
    manager.destroy();
  });
});
