// Run after npm run build. Set PLAYWRIGHT_MODULE when Playwright is supplied externally.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const bundle = await readFile(new URL('../dist/index.global.js', import.meta.url));
const uploads = [];
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/replays/')) {
    const buffers = [];
    for await (const data of req) buffers.push(data);
    uploads.push({url: req.url, events: JSON.parse(gunzipSync(Buffer.concat(buffers)).toString())});
    res.end('{}');
  } else if (req.url === '/replay.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.end(bundle);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><button id="action">Use page</button><div id="counter"></div><script src="/replay.js"></script>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(origin);
  await page.evaluate(() => {
    const scope = {setTag() {}, onBreadcrumb() {}, getUser() {return null;}};
    window.installReplay = (options = {}) => {
      window.replay = TraceKitReplay.replayIntegration({sessionSampleRate: 1, idleTimeout: 1000, flushInterval: 100, ...options});
      window.replay.install({getConfig: () => ({apiKey: 'test-only-key', endpoint: location.origin}), getScope: () => scope, captureException() {return 'error';}});
    };
    window.installReplay();
    let tick = 0;
    window.mutations = setInterval(() => {document.querySelector('#counter').textContent = String(++tick);}, 10);
  });
  const firstID = await page.evaluate(() => window.replay.getSessionId());
  assert.ok(firstID);
  await page.waitForTimeout(1400);
  assert.equal(await page.evaluate(() => window.replay.getSessionId()), '');
  assert.ok(uploads.length > 0, 'real recorder uploads the first session');
  const countAfterIdle = uploads.length;
  await page.waitForTimeout(250);
  assert.equal(uploads.length, countAfterIdle, 'background mutations cannot restart uploads');
  await page.click('#action');
  const nextID = await page.evaluate(() => window.replay.getSessionId());
  assert.ok(nextID && nextID !== firstID, 'trusted input starts a new session');
  await page.waitForTimeout(150);
  await page.evaluate(() => window.replay.teardown());
  await page.waitForTimeout(100);
  const countAfterDestroy = uploads.length;
  await page.click('#action');
  await page.waitForTimeout(450);
  assert.equal(uploads.length, countAfterDestroy, 'teardown removes real capture listeners and stops recorder');
  const measured = uploads.map(({events}) => {
    const bounds = events.filter(e => e.data?.tag === 'tracekit.recording-boundary');
    assert.equal(bounds.length, 2);
    return bounds[1].timestamp - bounds[0].timestamp;
  });
  assert.ok(measured.every(ms => ms >= 0 && ms <= 1000));
  await page.evaluate(() => {
    clearInterval(window.mutations);
    sessionStorage.clear();
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    window.installReplay();
  });
  await page.waitForTimeout(450);
  assert.equal(uploads.length, countAfterDestroy, 'initial hidden install does not record');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(150);
  assert.ok(uploads.length > countAfterDestroy, 'visible return starts recording');
  await page.evaluate(() => window.replay.teardown());
  console.log('PASS: Chromium recorder, background mutation expiry, trusted input renewal, real listener cleanup, hidden install, bounded chunk durations');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
