import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session';
import type { ResolvedReplayConfig } from '../src/types';

class FakeDocument {
  visibilityState: 'visible' | 'hidden' = 'visible';
  private listeners = new Map<string, Set<{ handler: (event: Event) => void; capture: boolean }>>();
  addEventListener(name: string, handler: (event: Event) => void, options?: { capture?: boolean }): void {
    const set = this.listeners.get(name) ?? new Set();
    set.add({ handler, capture: options?.capture === true });
    this.listeners.set(name, set);
  }
  removeEventListener(name: string, handler: (event: Event) => void, options?: { capture?: boolean }): void {
    const capture = options?.capture === true;
    this.listeners.get(name)?.forEach((entry) => { if (entry.handler === handler && entry.capture === capture) this.listeners.get(name)?.delete(entry); });
  }
  dispatch(name: string, event: Event = new Event(name)): void { this.listeners.get(name)?.forEach((entry) => entry.handler(event)); }
  count(name: string): number { return this.listeners.get(name)?.size ?? 0; }
}

function config(): ResolvedReplayConfig {
  return { sessionSampleRate: 1, errorSampleRate: 0, unmask: [], idleTimeout: 1_000, flushInterval: 30_000, maxBufferSize: 1000, inlineImages: false, blockMedia: true, apiKey: 'key', endpoint: 'http://localhost', serviceName: 'test' };
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

describe('SessionManager lifecycle', () => {
  const doc = new FakeDocument();
  const storage = new Map<string, string>();
  const sharedCounters = new Map<string, string>();

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      get length() { return sharedCounters.size; },
      key: (index: number) => [...sharedCounters.keys()][index] ?? null,
      getItem: (key: string) => sharedCounters.get(key) ?? null,
      setItem: (key: string, value: string) => sharedCounters.set(key, value),
      removeItem: (key: string) => sharedCounters.delete(key),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    storage.clear();
    sharedCounters.clear();
    doc.visibilityState = 'visible';
  });

  const useLocks = () => vi.stubGlobal('navigator', { locks: new FakeLocks() });

  it('reports oversized error-buffer baseline with zero retained bytes', () => {
    vi.stubGlobal('document', doc);
    const manager = new SessionManager({ ...config(), sessionSampleRate: 0, errorSampleRate: 1, maxBufferSize: 256 });
    const failed = vi.fn();
    manager.setQueueFailureCallback(failed);
    manager.onEvent({ type: 2, timestamp: Date.now(), data: { node: { type: 0, id: 1, childNodes: [], text: 'x'.repeat(1000) } } }, false);
    expect(failed).toHaveBeenCalledOnce();
    expect(manager.getRetainedBytes()).toBe(0);
    expect(manager.getRetainedEventCount()).toBe(0);
    manager.destroy();
  });

  it('expires after 30 minutes despite rrweb DOM and custom events for 800 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager({ ...config(), idleTimeout: 30 * 60 * 1_000 });
    await manager.ready();
    let restarts = 0;
    manager.setRestartCallback(() => { restarts++; });
    for (let minute = 0; minute < 800; minute++) {
      doc.dispatch('mousemove');
      doc.dispatch('scroll');
      doc.dispatch('custom');
      vi.advanceTimersByTime(60 * 1_000);
    }
    expect(manager.isActive()).toBe(false);
    expect(restarts).toBe(0);
    manager.destroy();
  });

  it('renews on trusted input and resumes once after an expired hidden period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager(config());
    await manager.ready();
    let starts = 0;
    let resumes = 0;
    manager.setRestartCallback(() => { starts++; });
    manager.setResumeCallback(() => { resumes++; });
    vi.setSystemTime(500);
    const input = new Event('pointerdown');
    Object.defineProperty(input, 'isTrusted', { value: true });
    doc.dispatch('pointerdown', input);
    expect(manager.getState().lastActivity).toBe(500);
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    vi.setSystemTime(2_000);
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    expect(starts).toBe(1);
    expect(resumes).toBe(0);
    manager.destroy();
  });

  it('allocates in memory and removes all listeners on destroy', async () => {
    useLocks();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager(config());
    await manager.ready();
    expect(manager.nextSegmentId()).toBe(0);
    expect(manager.getState().segmentId).toBe(1);
    expect(storage.size).toBe(0);
    expect(sharedCounters.size).toBe(0);
    expect(doc.count('pointerdown')).toBe(1);
    manager.destroy();
    expect(doc.count('pointerdown')).toBe(0);
  });

  it('starts fresh sampling and a zero counter across reload', async () => {
    useLocks();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const first = new SessionManager({ ...config(), sessionSampleRate: 0, errorSampleRate: 0 });
    await first.ready();
    expect(first.getMode()).toBe('off');
    first.nextSegmentId();
    const oldId = first.getState().sessionId;
    first.destroy();
    vi.stubGlobal('location', { href: 'http://localhost/replay' });
    vi.stubGlobal('performance', { getEntriesByType: (name: string) => name === 'navigation' ? [{ type: 'reload', name: 'http://localhost/replay' }] : [] });
    const second = new SessionManager({ ...config(), sessionSampleRate: 1 });
    await second.ready();
    expect(second.getMode()).toBe('session');
    expect(second.getState().sessionId).not.toBe(oldId);
    expect(second.nextSegmentId()).toBe(0);
    second.destroy();
  });

  it('starts inactive when the initial document is hidden', async () => {
    doc.visibilityState = 'hidden';
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager(config());
    await manager.ready();
    expect(manager.isActive()).toBe(false);
    manager.destroy();
  });

  it('flushes the old identity before trusted input creates a new session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager(config());
    await manager.ready();
    const oldId = manager.getFlushSessionId();
    let flushed = '';
    manager.setFlushCallback(() => { flushed = manager.getFlushSessionId(); });
    vi.setSystemTime(2_000);
    expect(manager.getSessionId()).toBe('');
    const input = new Event('pointerdown');
    Object.defineProperty(input, 'isTrusted', { value: true });
    doc.dispatch('pointerdown', input);
    expect(flushed).toBe(oldId);
    expect(manager.getSessionId()).not.toBe(oldId);
    manager.destroy();
  });

  it('creates a fresh baseline when a delayed buffer error has no retained events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager({ ...config(), sessionSampleRate: 0, errorSampleRate: 1, idleTimeout: 120_000 });
    await manager.ready();
    const emitted: any[] = [];
    let restarts = 0;
    manager.setEventCallback((events) => emitted.push(...events));
    manager.setRestartCallback(() => {
      restarts++;
      manager.onEvent({ type: 2, timestamp: Date.now() }, false);
    });
    manager.onEvent({ type: 3, timestamp: 0 }, false);
    vi.setSystemTime(61_000);
    manager.onError();
    expect(restarts).toBe(1);
    expect(emitted.some((event) => event.type === 2)).toBe(true);
    expect(manager.getMode()).toBe('session');
    manager.destroy();
  });
});
