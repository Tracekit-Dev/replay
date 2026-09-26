import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayTransport } from '../src/transport';
import { resolveReplayConfig } from '../src/config';

function makeTransport(compress: (events: any[], segment: number) => Promise<{ compressed: Uint8Array; originalSize: number }>) {
  const transport = new ReplayTransport(resolveReplayConfig({}, 'test-key', 'https://example.test'), { compress } as any);
  transport.start(() => 'a'.repeat(32), () => 0, () => 'session', () => '', () => '');
  transport.stop();
  transport.addEvent({ type: 2, timestamp: Date.now() });
  return transport;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('privacy cancellation of detached uploads', () => {
  it('drops compression results that arrive after destroy', async () => {
    let resolveCompression!: (result: { compressed: Uint8Array; originalSize: number }) => void;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const transport = makeTransport(() => new Promise((resolve) => { resolveCompression = resolve; }));
    const flush = transport.flush();
    transport.destroy();
    resolveCompression({ compressed: new Uint8Array([1]), originalSize: 1 });
    await flush;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts an active fetch and does not retry after destroy', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = makeTransport(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 }));
    const flush = transport.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0][1].signal;
    transport.destroy();
    expect(signal?.aborted).toBe(true);
    await vi.runAllTimersAsync();
    await flush;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels retry delays when destroyed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const transport = makeTransport(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 }));
    const flush = transport.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    transport.destroy();
    await vi.runAllTimersAsync();
    await flush;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
