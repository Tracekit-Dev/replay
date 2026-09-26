/**
 * TraceKit Replay - Web Worker Compression Script
 * @package @tracekit/replay
 *
 * Inline Web Worker script string using native CompressionStream API.
 * No external dependencies inside the worker -- CompressionStream is
 * baseline available in workers since 2023.
 *
 * If CompressionStream is unavailable, the worker posts an error back
 * and the main thread (CompressionWorker) falls back to fflate gzipSync.
 *
 * Message protocol:
 *   IN:  { events: any[], segmentId: number }
 *   OUT: { compressed: Uint8Array, segmentId: number, originalSize: number }
 *   ERR: { error: string, segmentId: number }
 */

export const WORKER_SCRIPT = `
self.onmessage = async function(e) {
  try {
    var data = e.data;
    var json = JSON.stringify(data.events);
    var encoded = new TextEncoder().encode(json);

    if (typeof CompressionStream === 'undefined') {
      self.postMessage({ error: 'CompressionStream not available', segmentId: data.segmentId });
      return;
    }

    var cs = new CompressionStream('gzip');
    var writer = cs.writable.getWriter();
    var reader = cs.readable.getReader();
    var chunks = [];
    var totalLen = 0;
    var writing = (async function() {
      await writer.write(encoded);
      await writer.close();
    })();
    var reading = (async function() {
      while (true) {
        var result = await reader.read();
        if (result.done) break;
        totalLen += result.value.length;
        if (totalLen > encoded.length + 65536) throw new Error('Compressed output exceeds bound');
        chunks.push(result.value);
      }
    })();
    await Promise.all([writing, reading]);
    var compressed = new Uint8Array(totalLen);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      compressed.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    self.postMessage(
      { compressed: compressed, segmentId: data.segmentId, originalSize: encoded.length },
      [compressed.buffer]
    );
  } catch(err) {
    self.postMessage({ error: (err && err.message) || 'Unknown compression error', segmentId: e.data.segmentId });
  }
};
`;
