import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, storageKeyForConfig } from '../src/session';
import type { ResolvedReplayConfig } from '../src/types';

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
}

function config(serviceName = 'checkout'): ResolvedReplayConfig {
  return {
    sessionSampleRate: 1,
    errorSampleRate: 0,
    unmask: [],
    idleTimeout: 1_000,
    flushInterval: 30_000,
    maxBufferSize: 1_000,
    inlineImages: false,
    blockMedia: true,
    apiKey: 'secret-api-key',
    endpoint: 'https://collector.example.test',
    serviceName,
  };
}

function storageMap() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('replay identity boundaries', () => {
  const document = new FakeDocument();

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses separate namespace keys for separate project discriminators', () => {
    const storage = storageMap();
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storage);

    const checkout = new SessionManager(config('checkout'));
    const billing = new SessionManager(config('billing'));

    expect(checkout.getSessionId()).not.toBe(billing.getSessionId());
    expect(storage.values.keys()).not.toContain('__tracekit_replay_session');
    expect([...storage.values.keys()].some((key) => key.includes('secret-api-key'))).toBe(false);
    checkout.destroy();
    billing.destroy();
  });

  it('does not reuse a copied sessionStorage claim', () => {
    const original = storageMap();
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', original);
    const first = new SessionManager(config());
    const firstId = first.getSessionId();
    const copied = storageMap();
    for (const [key, value] of original.values) copied.values.set(key, value);
    first.destroy();

    vi.stubGlobal('sessionStorage', copied);
    const resumed = new SessionManager(config());
    expect(resumed.getSessionId()).not.toBe(firstId);
    resumed.destroy();
  });

  it('starts fresh for invalid IDs and unsafe segment counters', () => {
    const storage = storageMap();
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storage);
    const key = storageKeyForConfig(config());
    storage.values.set(key, JSON.stringify({
      sessionId: 'not-a-session-id',
      segmentId: Number.MAX_SAFE_INTEGER + 1,
      mode: 'session',
      lastActivity: Date.now(),
      ownerToken: 'copied-owner',
    }));

    const manager = new SessionManager(config());
    expect(manager.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
    expect(manager.nextSegmentId()).toBe(0);
    manager.destroy();
  });

  it('rotates an earlier owner before allocating a writable segment', () => {
    const storage = storageMap();
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storage);
    const first = new SessionManager(config());
    const firstId = first.getSessionId();
    const second = new SessionManager(config());
    const secondId = second.getSessionId();

    expect(secondId).not.toBe(firstId);
    expect(first.nextSegmentId()).toBe(0);
    expect(first.getSessionId()).not.toBe(firstId);
    expect(first.getSessionId()).not.toBe(secondId);
    first.destroy();
    second.destroy();
  });

  it('does not let a suspended owner reclaim a resumed identity', () => {
    const storage = storageMap();
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storage);
    const suspended = new SessionManager(config());
    const suspendedId = suspended.getSessionId();
    suspended.destroy();

    const resumed = new SessionManager(config());
    const resumedId = resumed.getSessionId();
    expect(resumedId).toBe(suspendedId);
    expect(suspended.getSessionId()).not.toBe(resumedId);
    resumed.destroy();
  });

  it('starts fresh when storage is blocked and without BroadcastChannel', () => {
    vi.stubGlobal('document', document);
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });

    const first = new SessionManager(config());
    const second = new SessionManager(config());
    expect(first.getSessionId()).not.toBe(second.getSessionId());
    first.destroy();
    second.destroy();
  });

  it('rotates at a user identity boundary without persisting the user ID', () => {
    const storage = storageMap();
    let userId = 'user-a';
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', storage);
    const manager = new SessionManager(config());
    manager.setUserIdentityProvider(() => userId);
    const firstId = manager.getSessionId();
    userId = 'user-b';

    expect(manager.getSessionId()).not.toBe(firstId);
    expect([...storage.values.values()].join('\n')).not.toContain('user-b');
    manager.destroy();
  });
});
