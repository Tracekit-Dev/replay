// Run after Browser and Replay builds. PLAYWRIGHT_MODULE can name an external installation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const replayBundle = await readFile(new URL(process.env.REPLAY_BUNDLE || '../dist/index.global.js', import.meta.url));
const browserBundle = await readFile(new URL(process.env.BROWSER_BUNDLE || '../../browser/dist/index.global.js', import.meta.url));
const full = process.argv.includes('--full');
const engines = full ? ['chromium', 'firefox', 'webkit'] : ['chromium'];
const uploads = [];
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/replays/')) {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts);
    uploads.push({ url: req.url, headers: req.headers, bytes: body,
      events: JSON.parse(gunzipSync(body).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  } else if (req.url === '/browser.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(browserBundle);
  } else if (req.url === '/replay.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(replayBundle);
  } else if (req.url.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  } else {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><button id="action">Use page</button><input id="private" value="private-form-canary" type="password"><div id="counter"></div><script src="/browser.js"></script><script src="/replay.js"></script>');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const outcomes = [];
try {
  for (const name of engines) {
    let browser;
    try { browser = await playwright[name].launch(name === 'chromium' ? { channel: 'chrome', headless: true } : { headless: true }); }
    catch (error) { outcomes.push({ engine: name, state: 'unavailable', reason: String(error.message).slice(0, 300) }); continue; }
    try {
      const page = await browser.newPage();
      const before = uploads.length;
      await page.goto(`${origin}/?token=url-query-canary#fragment-canary`);
      await page.evaluate(() => {
        window.replay = TraceKitReplay.replayIntegration({ sessionSampleRate: 1, idleTimeout: 1000, flushInterval: 100 });
        TraceKit.init({ apiKey: 'synthetic-project-key', endpoint: location.origin,
          serviceName: 'replay-fixture', addons: [window.replay] });
        let tick = 0;
        window.mutations = setInterval(() => { document.querySelector('#counter').textContent = String(++tick); }, 10);
      });
      const firstID = await page.evaluate(() => window.replay.getSessionId());
      assert.ok(firstID, `${name}: real Browser client must start Replay`);
      const backgroundTab = await browser.newPage();
      await backgroundTab.goto(origin);
      await backgroundTab.bringToFront();
      const actuallyHidden = await page.evaluate(() => document.visibilityState === 'hidden');
      await backgroundTab.close();
      await page.bringToFront();
      await page.waitForTimeout(1400);
      assert.equal(await page.evaluate(() => window.replay.getSessionId()), '', `${name}: idle session ends`);
      assert.ok(uploads.length > before, `${name}: actual recorder uploads`);
      const afterIdle = uploads.length;
      await page.waitForTimeout(250);
      assert.equal(uploads.length, afterIdle, `${name}: background mutations do not restart capture`);
      await page.click('#action');
      const nextID = await page.evaluate(() => window.replay.getSessionId());
      assert.ok(nextID && nextID !== firstID, `${name}: trusted input starts a new identity`);
      await page.evaluate(() => {
        clearInterval(window.mutations);
        window.replay.teardown();
        window.replay = TraceKitReplay.replayIntegration({ sessionSampleRate: 1, idleTimeout: 800 * 60 * 1000, flushInterval: 100 });
        TraceKit.init({ apiKey: 'synthetic-project-key', endpoint: location.origin,
          serviceName: 'replay-800-minute-fixture', addons: [window.replay] });
      });
      const longIdleID = await page.evaluate(() => window.replay.getSessionId());
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.replay.getSessionId()), longIdleID, `${name}: 800-minute idle budget does not expire immediately`);
      await page.evaluate(() => { clearInterval(window.mutations); window.replay.teardown(); });
      const afterTeardown = uploads.length;
      await page.click('#action');
      await page.waitForTimeout(150);
      assert.equal(uploads.length, afterTeardown, `${name}: teardown stops capture`);
      await page.evaluate(() => {
        sessionStorage.removeItem('__rq0503_pagehide');
        addEventListener('pagehide', () => sessionStorage.setItem('__rq0503_pagehide', 'yes'), { once: true });
        addEventListener('pageshow', (event) => { window.__rq0503_bfcache = event.persisted; });
      });
      await page.goto(`${origin}/next`);
      const pagehide = await page.evaluate(() => sessionStorage.getItem('__rq0503_pagehide') === 'yes');
      await page.goBack();
      const backForwardCache = await page.evaluate(() => window.__rq0503_bfcache === true);
      const storageContext = await browser.newContext();
      await storageContext.addInitScript(() => {
        for (const name of ['localStorage', 'sessionStorage']) {
          Object.defineProperty(window, name, { get() { throw new DOMException('Blocked', 'SecurityError'); } });
        }
      });
      const blockedPage = await storageContext.newPage();
      await blockedPage.goto(origin);
      const blockedStorage = await blockedPage.evaluate(() => {
        const addon = TraceKitReplay.replayIntegration({ sessionSampleRate: 1, flushInterval: 100 });
        TraceKit.init({ apiKey: 'synthetic-project-key', endpoint: location.origin, addons: [addon] });
        const id = addon.getSessionId();
        addon.teardown();
        return Boolean(id);
      });
      await storageContext.close();
      for (const upload of uploads.slice(before)) {
        const serialized = JSON.stringify(upload.events);
        assert.doesNotMatch(serialized, /private-form-canary|url-query-canary|fragment-canary/);
        assert.doesNotMatch(upload.url, /private-form-canary|url-query-canary|fragment-canary/);
        const boundaries = upload.events.filter((event) => event.data?.tag === 'tracekit.recording-boundary');
        assert.equal(boundaries.length, 2);
        assert.ok(boundaries[1].timestamp - boundaries[0].timestamp <= 1000);
      }
      outcomes.push({ engine: name, version: browser.version(), state: 'pass', uploads: uploads.length - before,
        backgroundTab: actuallyHidden, pagehide, backForwardCache, blockedStorage });
      await page.close();
    } finally { await browser.close(); }
  }
} finally { await new Promise((resolve) => server.close(resolve)); }
console.log(JSON.stringify({ outcomes, inspectedTransports: uploads.length }));
if (outcomes.some((outcome) => outcome.state !== 'pass' || full &&
  (!outcome.backgroundTab || !outcome.pagehide || !outcome.backForwardCache || !outcome.blockedStorage))) process.exitCode = 2;
