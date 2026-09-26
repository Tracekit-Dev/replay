import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session';
import { replayIntegration } from '../src/index';
import type { ResolvedReplayConfig } from '../src/types';

const recorderCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/recorder', () => ({
  startRecording: vi.fn(() => { recorderCalls.count++; return () => {}; }),
}));

const config = (serviceName = 'alpha', apiKey = 'public-key'): ResolvedReplayConfig => ({
  sessionSampleRate: 1, errorSampleRate: 0, unmask: [], idleTimeout: 1_800_000,
  flushInterval: 30_000, maxBufferSize: 1000, inlineImages: false, blockMedia: true,
  endpoint: 'https://example.test', apiKey, serviceName,
});

function storage(values = new Map<string, string>()) {
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

class FakeLocks {
  held = new Set<string>();
  async request(name: string, _options: { ifAvailable: boolean }, callback: (lock: object | null) => Promise<void>) {
    const available = !this.held.has(name);
    if (available) this.held.add(name);
    try { await callback(available ? {} : null); }
    finally { if (available) this.held.delete(name); }
  }
}

async function createManager(resolved = config()) {
  const manager = new SessionManager(resolved);
  await manager.ready();
  return manager;
}

describe('Replay session identity', () => {
  beforeEach(() => vi.stubGlobal('localStorage', storage()));
  afterEach(() => vi.unstubAllGlobals());

  it('namespaces persisted state by endpoint, service, and key digest without storing raw keys', async () => {
    const shared = storage();
    vi.stubGlobal('sessionStorage', shared);
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    const alpha = await createManager(config('alpha', 'secret-alpha'));
    const beta = await createManager(config('beta', 'secret-alpha'));
    const rotated = await createManager(config('alpha', 'secret-beta'));
    expect(new Set([alpha.getSessionId(), beta.getSessionId(), rotated.getSessionId()]).size).toBe(3);
    expect(shared.values.size).toBe(3);
    for (const key of shared.values.keys()) {
      expect(key).not.toContain('secret-alpha');
      expect(key).not.toContain('secret-beta');
    }
    alpha.destroy(); beta.destroy(); rotated.destroy();
  });

  it('does not import the old global storage entry', async () => {
    const shared = storage(new Map([['__tracekit_replay_session', JSON.stringify({ sessionId: 'a'.repeat(32), segmentId: 7, mode: 'session', lastActivity: Date.now() })]]));
    vi.stubGlobal('sessionStorage', shared);
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    const manager = await createManager();
    expect(manager.getSessionId()).not.toBe('a'.repeat(32));
    expect(manager.nextSegmentId()).toBe(0);
    manager.destroy();
  });

  it.each([
    { sessionId: '../unsafe', segmentId: 1 },
    { sessionId: 'a'.repeat(32), segmentId: Number.MAX_SAFE_INTEGER },
    { sessionId: 'a'.repeat(32), segmentId: -1 },
    { sessionId: 'a'.repeat(32), segmentId: 1.5 },
  ])('starts fresh for invalid persisted identity %#', async (invalid) => {
    const shared = storage();
    vi.stubGlobal('sessionStorage', shared);
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    const first = await createManager();
    const key = [...shared.values.keys()][0];
    first.destroy();
    shared.values.set(key, JSON.stringify({ ...invalid, mode: 'session', lastActivity: Date.now() }));
    const second = await createManager();
    expect(second.getSessionId()).not.toBe(invalid.sessionId);
    expect(second.nextSegmentId()).toBe(0);
    second.destroy();
  });

  it('starts fresh for copied storage when an owner is suspended', async () => {
    const original = storage();
    const locks = new FakeLocks();
    vi.stubGlobal('navigator', { locks });
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('sessionStorage', original);
    const first = await createManager();
    first.nextSegmentId();
    const copied = storage(new Map(original.values));
    vi.stubGlobal('sessionStorage', copied);
    const clone = await createManager();
    expect(clone.getSessionId()).not.toBe(first.getSessionId());
    expect(clone.nextSegmentId()).toBe(0);
    clone.destroy(); first.destroy();
  });

  it('keeps simultaneous copied claims distinct', async () => {
    const shared = storage();
    const locks = new FakeLocks();
    vi.stubGlobal('navigator', { locks });
    vi.stubGlobal('sessionStorage', shared);
    const original = await createManager();
    original.destroy();
    const [one, two] = await Promise.all([createManager(), createManager()]);
    expect(one.getSessionId()).not.toBe(two.getSessionId());
    one.destroy(); two.destroy();
  });

  it('rejects a delayed copy after the first owner releases a newer counter', async () => {
    const originalStorage = storage();
    const sharedCounter = storage();
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    vi.stubGlobal('localStorage', sharedCounter);
    vi.stubGlobal('sessionStorage', originalStorage);
    const first = await createManager();
    const firstId = first.getSessionId();
    const delayedCopy = storage(new Map(originalStorage.values));
    expect(first.nextSegmentId()).toBe(0);
    first.destroy();
    vi.stubGlobal('sessionStorage', delayedCopy);
    const clone = await createManager();
    const cloneId = clone.getSessionId();
    const cloneSegment = clone.nextSegmentId();
    expect(cloneId !== firstId || cloneSegment > 0).toBe(true);
    clone.destroy();
  });

  it('uses fresh document identity when storage is blocked or ownership proof is absent', async () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    vi.stubGlobal('sessionStorage', blocked);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('BroadcastChannel', undefined);
    const one = await createManager();
    const two = await createManager();
    expect(one.getSessionId()).not.toBe(two.getSessionId());
    expect(one.nextSegmentId()).toBe(0);
    expect(two.nextSegmentId()).toBe(0);
    one.destroy(); two.destroy();
  });

  it('restores a valid counter only after the previous owner releases its lock', async () => {
    const shared = storage();
    vi.stubGlobal('sessionStorage', shared);
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    const first = await createManager();
    const id = first.getSessionId();
    first.nextSegmentId();
    first.destroy();
    const reload = await createManager();
    expect(reload.getSessionId()).toBe(id);
    expect(reload.nextSegmentId()).toBe(1);
    reload.destroy();
  });

  it('does not allocate a segment before ownership settles', async () => {
    vi.stubGlobal('sessionStorage', storage());
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    const manager = new SessionManager(config());
    expect(() => manager.nextSegmentId()).toThrow('Replay identity is not ready');
    await manager.ready();
    expect(manager.nextSegmentId()).toBe(0);
    manager.destroy();
  });

  it('rotates instead of emitting an unsafe next counter', async () => {
    const shared = storage();
    const sharedCounter = storage();
    vi.stubGlobal('sessionStorage', shared);
    vi.stubGlobal('localStorage', sharedCounter);
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    const first = await createManager();
    const key = [...shared.values.keys()][0];
    first.destroy();
    const previous = JSON.parse(shared.values.get(key)!);
    shared.values.set(key, JSON.stringify({ ...previous, segmentId: 0x7fff_fffe }));
    sharedCounter.values.set(`${key}_${previous.sessionId}`, String(0x7fff_fffe));
    const manager = await createManager();
    const oldId = manager.getSessionId();
    expect(manager.nextSegmentId()).toBe(0x7fff_fffe);
    expect(() => manager.nextSegmentId()).toThrow('Replay segment counter is unsafe');
    expect(manager.getSessionId()).not.toBe(oldId);
    manager.destroy();
  });

  it('rotates recording identity when the BrowserClient user changes', async () => {
    vi.stubGlobal('sessionStorage', storage());
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    let userId = 'first';
    const scope = { getUser: () => ({ id: userId }), setTag: vi.fn(), onBreadcrumb: vi.fn() };
    const client = {
      getConfig: () => ({ apiKey: 'public-key', endpoint: 'https://example.test', serviceName: 'alpha' }),
      getScope: () => scope,
      captureException: vi.fn(() => 'event-id'),
    };
    const integration = replayIntegration({ sessionSampleRate: 1 });
    const previousRecorderCalls = recorderCalls.count;
    integration.install(client);
    await vi.waitFor(() => expect(recorderCalls.count).toBeGreaterThan(previousRecorderCalls));
    const firstId = integration.getSessionId();
    userId = 'second';
    client.captureException(new Error('synthetic'));
    expect(integration.getSessionId()).not.toBe(firstId);
    expect(recorderCalls.count).toBeGreaterThanOrEqual(2);
    integration.teardown?.();
  });

  it('keeps the initial automatic pageview linked to the identity that records', async () => {
    vi.stubGlobal('sessionStorage', storage());
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    const scope = { getUser: () => null, setTag: vi.fn(), onBreadcrumb: vi.fn() };
    const client = {
      getConfig: () => ({ apiKey: 'public-key', endpoint: 'https://example.test', serviceName: 'alpha' }),
      getScope: () => scope,
      captureException: vi.fn(() => 'event-id'),
    };
    const integration = replayIntegration({ sessionSampleRate: 1 });
    const previousRecorderCalls = recorderCalls.count;
    integration.install(client);
    // BrowserClient calls this synchronously after addon.install().
    const initialPageviewReplayId = integration.getSessionId();
    expect(initialPageviewReplayId).toMatch(/^[0-9a-f]{32}$/);
    await vi.waitFor(() => expect(recorderCalls.count).toBeGreaterThan(previousRecorderCalls));
    expect(integration.getSessionId()).toBe(initialPageviewReplayId);
    integration.teardown?.();
  });
});
