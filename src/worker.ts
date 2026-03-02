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
self.onmessage = function(e) {
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

    writer.write(encoded);
    writer.close();

    function readChunks() {
      reader.read().then(function(result) {
        if (result.done) {
          var totalLen = 0;
          for (var i = 0; i < chunks.length; i++) totalLen += chunks[i].length;
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
        } else {
          chunks.push(result.value);
          readChunks();
        }
      }).catch(function(err) {
        self.postMessage({ error: err.message, segmentId: data.segmentId });
      });
    }
    readChunks();
  } catch(err) {
    self.postMessage({ error: (err && err.message) || 'Unknown compression error', segmentId: e.data.segmentId });
  }
};
`;
