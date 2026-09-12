import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayTransport } from '../src/transport';
import { resolveReplayConfig } from '../src/config';
import { gunzipSync } from 'fflate';

const epoch = 1_800_000_000_000;
let mode = 'session';
let sessionId = 'session-a';
let deadline = epoch + 1_800_000;
let chunks: any[][];
let transport: ReplayTransport;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  mode = 'session'; sessionId = 'session-a'; deadline = epoch + 1_800_000;
  chunks = [];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  const worker = { compress: vi.fn(async (events: any[]) => {
    chunks.push(events);
    return { compressed: new Uint8Array([1]), originalSize: 1 };
  }) };
  transport = new ReplayTransport(resolveReplayConfig({}, 'test-key', 'https://example.test'), worker as any);
  let segment = 0;
  transport.start(() => sessionId, () => segment++, () => mode, () => '', () => '', () => deadline);
  transport.stop(); // Tests control flush calls explicitly.
});
afterEach(() => { transport.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const span = (events: any[]) => Math.max(...events.map(e => e.timestamp)) - Math.min(...events.map(e => e.timestamp));

describe('recorded duration boundaries', () => {
  it('counts a static visible page and contiguous flush windows without gaps', async () => {
    transport.startRecordingWindow();
    transport.addEvent({type: 2, timestamp: epoch});
    vi.setSystemTime(epoch + 30000);
    await transport.flush();
    vi.setSystemTime(epoch + 60000);
    await transport.flush();
    expect(chunks.map(span)).toEqual([30000, 30000]);
    expect(chunks[1][0].timestamp).toBe(chunks[0].at(-1).timestamp);
  });
  it('excludes 800 minutes while hidden', async () => {
    transport.startRecordingWindow();
    transport.addEvent({type: 2, timestamp: epoch});
    vi.setSystemTime(epoch + 10000);
    transport.stopRecordingWindow();
    await transport.flush();
    vi.setSystemTime(epoch + 800 * 60000);
    await transport.flush();
    expect(chunks).toHaveLength(1);
    deadline = Date.now() + 1800000;
    transport.startRecordingWindow();
    transport.addEvent({type: 2, timestamp: Date.now()});
    vi.setSystemTime(Date.now() + 15000);
    transport.stopRecordingWindow();
    await transport.flush();
    expect(chunks.map(span)).toEqual([10000, 15000]);
  });
  it('bounds a suspended clock by the last user activity deadline', async () => {
    transport.startRecordingWindow();
    transport.addEvent({type: 2, timestamp: epoch});
    vi.setSystemTime(epoch + 800 * 60000);
    transport.stopRecordingWindow();
    await transport.flush();
    expect(span(chunks[0])).toBe(1800000);
  });
  it('does not upload error-only recording before an error and only includes retained history', async () => {
    mode = 'buffer';
    transport.startRecordingWindow();
    vi.setSystemTime(epoch + 600000);
    await transport.flush();
    expect(chunks).toHaveLength(0);
    transport.addEvent({type: 2, timestamp: epoch + 540000});
    mode = 'session';
    await transport.flush();
    expect(span(chunks[0])).toBe(60000);
  });
  it('writes the same boundaries in the page-hide beacon', async () => {
    let blob: Blob | undefined;
    vi.stubGlobal('navigator', { sendBeacon: vi.fn((_url, data) => {blob = data; return true;}) });
    transport.startRecordingWindow();
    transport.addEvent({type: 2, timestamp: epoch});
    vi.setSystemTime(epoch + 10000);
    transport.stopRecordingWindow();
    transport.flushSync();
    const events = JSON.parse(new TextDecoder().decode(gunzipSync(new Uint8Array(await blob!.arrayBuffer()))));
    expect(span(events)).toBe(10000);
    expect(events.at(-1).data.tag).toBe('tracekit.recording-boundary');
  });
});
