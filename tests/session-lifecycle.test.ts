import { afterEach, describe, expect, it, vi } from 'vitest';
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
  return { sessionSampleRate: 1, errorSampleRate: 0, unmask: [], idleTimeout: 1_000, flushInterval: 30_000, maxBufferSize: 1000, inlineImages: false, blockMedia: true, apiKey: 'key', endpoint: 'http://localhost' };
}

describe('SessionManager lifecycle', () => {
  const doc = new FakeDocument();
  const storage = new Map<string, string>();

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    storage.clear();
    doc.visibilityState = 'visible';
  });

  it('expires after 30 minutes despite rrweb DOM and custom events for 800 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager({ ...config(), idleTimeout: 30 * 60 * 1_000 });
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

  it('renews on trusted input and resumes once after an expired hidden period', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager(config());
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

  it('persists segment allocation and removes all listeners on destroy', () => {
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager(config());
    expect(manager.nextSegmentId()).toBe(0);
    expect(JSON.parse(storage.get('__tracekit_replay_session')!).segmentId).toBe(1);
    expect(doc.count('pointerdown')).toBe(1);
    manager.destroy();
    expect(doc.count('pointerdown')).toBe(0);
  });

  it('preserves off sampling and segment state across reload', () => {
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const first = new SessionManager({ ...config(), sessionSampleRate: 0, errorSampleRate: 0 });
    expect(first.getMode()).toBe('off');
    first.nextSegmentId();
    first.destroy();
    const second = new SessionManager({ ...config(), sessionSampleRate: 1 });
    expect(second.getMode()).toBe('off');
    expect(second.nextSegmentId()).toBe(1);
    second.destroy();
  });

  it('starts inactive when the initial document is hidden', () => {
    doc.visibilityState = 'hidden';
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager(config());
    expect(manager.isActive()).toBe(false);
    manager.destroy();
  });

  it('flushes the old identity before trusted input creates a new session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const manager = new SessionManager(config());
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
});
