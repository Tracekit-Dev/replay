import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayTransport } from '../src/transport';
import type { ReplaySegmentAllocation, ResolvedReplayConfig } from '../src/types';

function config(serviceName: string): ResolvedReplayConfig {
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
    serviceName,
    identityUserId: '',
  };
}

function startTransport(serviceName: string): ReplayTransport {
  const worker = { compress: vi.fn(async () => ({ compressed: new Uint8Array([1]), originalSize: 1 })) };
  const transport = new ReplayTransport(config(serviceName), worker as any);
  const allocation: ReplaySegmentAllocation = { sessionId: 'session-id', segmentId: 0, mode: 'session', userId: '' };
  transport.start(
    () => allocation.sessionId,
    () => allocation.segmentId,
    () => allocation.mode,
    () => 'https://app.example.test/checkout',
    () => allocation.userId,
    undefined,
    () => allocation,
    () => allocation,
  );
  return transport;
}

describe('replay transport scope metadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the configured service discriminator with fetch uploads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const transport = startTransport('checkout');
    transport.addEvent({ type: 2, timestamp: Date.now() });

    await transport.flush();

    const [, request] = vi.mocked(fetch).mock.calls[0];
    expect((request.headers as Record<string, string>)['X-Replay-Service-Name']).toBe('checkout');
    transport.destroy();
  });

  it('omits an overlong service discriminator instead of truncating authority', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const transport = startTransport('x'.repeat(256));
    transport.addEvent({ type: 2, timestamp: Date.now() });

    await transport.flush();

    const [, request] = vi.mocked(fetch).mock.calls[0];
    expect((request.headers as Record<string, string>)['X-Replay-Service-Name']).toBeUndefined();
    transport.destroy();
  });
});
