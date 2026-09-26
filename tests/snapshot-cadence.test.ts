import { describe, expect, it, vi } from 'vitest';
import { gunzipSync, gzipSync } from 'fflate';
import { ReplayTransport } from '../src/transport';
import { resolveReplayConfig } from '../src/config';

const snapshot = (timestamp: number) => ({
  type: 2, timestamp,
  data: { node: { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'main', attributes: {}, childNodes: [] }] } },
});
const mutation = (timestamp: number) => ({
  type: 3, timestamp,
  data: { source: 0, adds: [], removes: [], texts: [], attributes: [] },
});

function fixture() {
  const fetchMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  const worker = { compress: vi.fn(async (events: unknown[]) => {
    const bytes = new TextEncoder().encode(JSON.stringify(events));
    return { compressed: gzipSync(bytes), originalSize: bytes.byteLength };
  }), getMode: () => 'worker' };
  const transport = new ReplayTransport(resolveReplayConfig({ sessionSampleRate: 1 }, 'key', 'https://api.test'), worker as any);
  let identity = 'a'.repeat(32);
  let segment = 0;
  transport.start(() => identity, () => segment++, () => 'session', () => '', () => '');
  transport.stop();
  return { transport, fetchMock, setIdentity: (value: string) => { identity = value; segment = 0; transport.setSessionIdentity(value); } };
}

function uploadedEvents(fetchMock: ReturnType<typeof vi.fn>): any[][] {
  return fetchMock.mock.calls.map(([, options]) => JSON.parse(new TextDecoder().decode(gunzipSync(options.body))));
}

describe('actual FullSnapshot cadence', () => {
  it('requests a real snapshot after the third nonfinal detached chunk and blocks dependent mutations', async () => {
    const { transport, fetchMock } = fixture();
    const request = vi.fn(() => transport.addEvent(snapshot(5)));
    transport.setSnapshotRequest(request);
    transport.addEvent(snapshot(1));
    await transport.flush();
    transport.addEvent(mutation(2));
    await transport.flush();
    expect(request).not.toHaveBeenCalled();
    transport.addEvent(mutation(3));
    const third = transport.flush();
    transport.addEvent(mutation(4));
    await third;
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    transport.addEvent(mutation(6));
    await transport.flush();
    const bodies = uploadedEvents(fetchMock);
    expect(bodies).toHaveLength(4);
    expect(bodies[3].map((event: any) => event.timestamp)).toEqual([5, 6]);
    expect(bodies.flat().some((event: any) => event.timestamp === 4)).toBe(false);
    transport.destroy();
    vi.unstubAllGlobals();
  });

  it('resets cadence on identity rotation and never requests after a final chunk', async () => {
    const { transport, setIdentity } = fixture();
    const request = vi.fn(() => transport.addEvent(snapshot(10)));
    transport.setSnapshotRequest(request);
    transport.addEvent(snapshot(1));
    await transport.flush();
    transport.addEvent(mutation(2));
    await transport.flush(true);
    expect(request).not.toHaveBeenCalled();
    setIdentity('b'.repeat(32));
    transport.addEvent(snapshot(3));
    await transport.flush();
    transport.addEvent(mutation(4));
    await transport.flush();
    expect(request).not.toHaveBeenCalled();
    transport.addEvent(mutation(5));
    await transport.flush();
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    transport.destroy();
    vi.unstubAllGlobals();
  });
});
