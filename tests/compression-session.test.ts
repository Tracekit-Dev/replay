import { afterEach, expect, it, vi } from 'vitest';
import { CompressionWorker } from '../src/compression';
import { gunzipSync } from 'fflate';

afterEach(() => { vi.unstubAllGlobals(); });
function fakeWorker() {
  const messages: any[] = [];
  let worker: any;
  vi.stubGlobal('Worker', class {
    onmessage: any; onerror: any;
    constructor() { worker = this; }
    postMessage(m: any) { messages.push(m); }
    terminate() {}
  });
  const compression = new CompressionWorker();
  return { compression, messages, worker };
}
it('keeps concurrent segment zero requests separate across renewed sessions', async () => {
  const {compression, messages, worker} = fakeWorker();
  const first = compression.compress([{timestamp: 1}], 0);
  const second = compression.compress([{timestamp: 2}], 0);
  expect(messages[0].segmentId).not.toBe(messages[1].segmentId);
  worker.onmessage({data: {segmentId: messages[1].segmentId, compressed: new Uint8Array([2]), originalSize: 2}});
  worker.onmessage({data: {segmentId: messages[0].segmentId, compressed: new Uint8Array([1]), originalSize: 1}});
  expect((await first).originalSize).toBe(1);
  expect((await second).originalSize).toBe(2);
  compression.destroy();
});
it('finishes pending chunks with fallback compression when the worker fails', async () => {
  const {compression, worker} = fakeWorker();
  const result = compression.compress([{timestamp: 42}], 0);
  worker.onerror();
  expect(JSON.parse(new TextDecoder().decode(gunzipSync((await result).compressed)))).toEqual([{timestamp: 42}]);
  compression.destroy();
});
