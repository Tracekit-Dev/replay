import { gunzipSync, gzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayTransport } from '../src/transport';
import type { ResolvedReplayConfig } from '../src/types';

const CANARY = 'tracekit-upload-canary';

function config(): ResolvedReplayConfig {
  return {
    sessionSampleRate: 1,
    errorSampleRate: 0,
    unmask: [],
    idleTimeout: 1_000,
    flushInterval: 30_000,
    maxBufferSize: 1_000_000,
    inlineImages: false,
    blockMedia: true,
    serviceName: `service-${CANARY}`,
    identityUserId: `user-${CANARY}`,
    apiKey: 'key',
    endpoint: 'https://tracekit.test',
  };
}

function worker() {
  return {
    compress: vi.fn(async (events: unknown[]) => {
      const encoded = new TextEncoder().encode(JSON.stringify(events));
      return { compressed: gzipSync(encoded), originalSize: encoded.length };
    }),
  } as any;
}

function event() {
  return {
    type: 5,
    timestamp: 1,
    data: {
      tag: 'network-request',
      payload: {
        url: `https://user:pass@example.test/path?q=${CANARY}#fragment`,
        body: CANARY,
      },
    },
  };
}

describe('Replay privacy upload boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sanitizes decompressed fetch bytes and request metadata', async () => {
    const requests: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push([url, init]);
      return new Response('', { status: 202 });
    }));
    vi.stubGlobal('navigator', { userAgent: `browser-${CANARY}` });

    const transport = new ReplayTransport(config(), worker());
    transport.start(
      () => 'a'.repeat(32),
      () => 0,
      () => 'session',
      () => `https://app.example.test/page?q=${CANARY}#fragment`,
      () => `user-${CANARY}`,
    );
    transport.addEvent(event());
    await transport.flush();

    expect(requests).toHaveLength(1);
    const [url, init] = requests[0];
    expect(url).not.toContain(CANARY);
    expect(JSON.stringify(init.headers)).not.toContain(CANARY);
    const bytes = new Uint8Array(init.body as ArrayBuffer);
    expect(new TextDecoder().decode(gunzipSync(bytes))).not.toContain(CANARY);
    transport.destroy();
  });

  it('sanitizes sendBeacon metadata and bytes', async () => {
    const beacons: Array<[string, Blob]> = [];
    vi.stubGlobal('navigator', {
      sendBeacon: vi.fn((url: string, body: Blob) => {
        beacons.push([url, body]);
        return true;
      }),
      userAgent: `browser-${CANARY}`,
    });

    const transport = new ReplayTransport(config(), worker());
    transport.start(
      () => 'b'.repeat(32),
      () => 1,
      () => 'session',
      () => `https://app.example.test/page?q=${CANARY}#fragment`,
      () => `user-${CANARY}`,
    );
    transport.addEvent(event());
    transport.flushSync();

    expect(beacons).toHaveLength(1);
    const [url, body] = beacons[0];
    expect(url).not.toContain(CANARY);
    expect(url).not.toContain('?q=');
    expect(url).not.toContain('#fragment');
    expect(body.size).toBeGreaterThan(0);
    expect(new TextDecoder().decode(gunzipSync(new Uint8Array(await body.arrayBuffer())))).not.toContain(CANARY);
    transport.destroy();
  });

  it('does not send detached work after stop', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const beaconMock = vi.fn(() => true);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: beaconMock, userAgent: 'test' });
    let resolveCompression!: (value: { compressed: Uint8Array; originalSize: number }) => void;
    const delayedWorker = { compress: vi.fn(() => new Promise((resolve) => { resolveCompression = resolve; })) } as any;
    const transport = new ReplayTransport(config(), delayedWorker);
    transport.start(() => 'c'.repeat(32), () => 0, () => 'session', () => '/', () => '');
    transport.addEvent(event());
    const flushing = transport.flush();
    transport.destroy();
    resolveCompression({ compressed: new Uint8Array([1]), originalSize: 1 });
    await flushing;
    transport.flushSync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconMock).not.toHaveBeenCalled();
  });
});
