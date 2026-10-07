// Real Browser and Replay bundles against synthetic local data. No account data enters this fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
const imported = await import(modulePath);
const playwright = imported.chromium ? imported : imported.default;
const replayBundle = await readFile(process.env.REPLAY_BUNDLE || new URL('../dist/index.global.js', import.meta.url));
const browserBundle = await readFile(process.env.BROWSER_BUNDLE || new URL('../../browser/dist/index.global.js', import.meta.url));
const full = process.argv.includes('--full');
const engines = full ? ['chromium', 'firefox', 'webkit'] : ['chromium'];
const uploads = [];
const errors = [];
const fixtureRevision = 'delivery-a-browser-v2';
const html = `<!doctype html><html><body>
<button id="action">Use page</button><input id="private" value="private-form-canary" type="password">
<input id="interaction"><a href="/safe?token=attribute-canary#fragment-canary">Synthetic link</a>
<div id="counter"></div><output id="status"></output>
<button onclick="replay.stop()">Stop capture</button><button onclick="replay.start()">Start capture</button>
<button onclick="replay.flush()">Flush capture</button><a href="/away">Navigate away</a>
<pre id="evidence"></pre>
<script src="/browser.js"></script><script src="/replay.js"></script><script>
window.lifecycleEvents = [];
addEventListener('pagehide', event => {
  lifecycleEvents.push({ type: 'pagehide', persisted: event.persisted });
  sessionStorage.setItem('fixture-pagehide', JSON.stringify({ persisted: event.persisted }));
});
addEventListener('pageshow', event => lifecycleEvents.push({ type: 'pageshow', persisted: event.persisted }));
document.addEventListener('visibilitychange', () => lifecycleEvents.push({ type: 'visibilitychange', state: document.visibilityState }));
window.boot = (mode = 'lifecycle') => {
  window.replay = TraceKitReplay.replayIntegration({ sessionSampleRate: 1, idleTimeout: 2000, flushInterval: 60000 });
  TraceKit.init({ apiKey: 'synthetic-project-key', endpoint: location.origin + '/' + mode,
    serviceName: 'replay-fixture', addons: [window.replay] });
  document.querySelector('#status').textContent = replay.getSessionId();
  console.log({ password: 'console-object-canary', message: 'console-message-canary' });
  document.querySelector('#counter').setAttribute('data-secret', 'attribute-canary');
  document.querySelector('#counter').textContent = 'private-text-canary';
};
if (location.pathname === '/native') {
  boot('native');
  setInterval(async () => {
    const status = await fetch('/fixture-status').then(response => response.json());
    document.querySelector('#evidence').textContent = JSON.stringify({ sessionId: replay.getSessionId(),
      capture: replay.getStatus().captureState, events: lifecycleEvents, ...status }, null, 2);
  }, 250);
}
</script></body></html>`;
const server = createServer(async (req, res) => {
  if (req.url.includes('/api/replays/')) {
    const parts = [];
    for await (const part of req) parts.push(part);
    try {
      const body = Buffer.concat(parts);
      const events = JSON.parse(gunzipSync(body).toString('utf8'));
      const mode = req.url.split('/')[1];
      uploads.push({ mode, url: req.url, headers: req.headers, bytes: body.length, events });
      const attempt = uploads.filter((upload) => upload.mode === mode).length;
      res.writeHead(mode.endsWith('retry') && attempt === 1 ? 503 : 200, { 'content-type': 'application/json' }).end('{}');
    } catch (error) {
      errors.push(error.message);
      res.writeHead(400).end();
    }
  } else if (req.url === '/fixture-status') {
    const native = uploads.filter(upload => upload.mode === 'native');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      uploads: native.length, privacyCanariesAbsent: !/private-form-canary|url-query-canary|fragment-canary|attribute-canary|console-object-canary|console-message-canary|private-text-canary/.test(JSON.stringify(native)),
      uploadedBytes: native.reduce((sum, upload) => sum + upload.bytes, 0) }));
  } else if (req.url === '/browser.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(browserBundle);
  else if (req.url === '/replay.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(replayBundle);
  else if (req.url.includes('/api/')) res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  else res.writeHead(200, { 'content-type': 'text/html' }).end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ fixtureRevision, url: origin + '/native', source: 'real Browser and Replay bundles; synthetic data only' }));
  await new Promise((resolve) => process.once('SIGTERM', resolve));
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(25);
  }
}
const outcomes = [];
async function realPage(context, engine) {
  const page = await context.newPage();
  if (engine === 'chromium') {
    const cdp = await context.newCDPSession(page);
    // Playwright otherwise forces every document focused, even in a genuine background tab.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  }
  return page;
}
try {
  for (const engine of engines) {
    let browser;
    try {
      console.error(`starting ${engine}`);
      browser = await playwright[engine].launch({ timeout: 20_000, headless: engine === 'firefox' || process.env.LIFECYCLE_HEADLESS === '1',
        ...(engine === 'chromium' ? { ignoreDefaultArgs: ['--disable-back-forward-cache', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] } : {}) });
    } catch (error) {
      outcomes.push({ engine, state: 'unavailable', reason: error.message.slice(0, 1000) });
      console.error(`${engine}: unavailable`);
      continue;
    }
    const outcome = { engine, version: browser.version(), checks: [] };
    const check = async (name, action) => {
      try {
        const detail = await action();
        outcome.checks.push({ name, state: 'pass', detail });
        console.error(`${engine}: ${name}: pass`);
        return detail;
      } catch (error) {
        outcome.checks.push({ name, state: 'fail', reason: error.stack });
        console.error(`${engine}: ${name}: fail: ${error.message}`);
        return null;
      }
    };
    const engineDeadline = setTimeout(() => browser.close().catch(() => {}), 90_000);
    try {
      const context = await browser.newContext();
      const page = await realPage(context, engine);
      await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
      await page.goto(`${origin}/?token=url-query-canary#fragment-canary`);
      await page.bringToFront();
      await page.evaluate(() => boot('lifecycle'));
      const firstID = await page.evaluate(() => replay.getSessionId());
      assert.ok(firstID, `${engine}: real Browser initializes Replay`);
      const backgroundTab = await realPage(context, engine);
      await backgroundTab.goto(origin + '/away');
      await backgroundTab.bringToFront();
      await sleep(150);
      const actuallyHidden = await page.evaluate(() => document.visibilityState === 'hidden');
      if (actuallyHidden) {
        outcome.backgroundTab = Boolean(await check('actual background tab', async () => {
          assert.equal(await page.evaluate(() => replay.getStatus().captureState), 'suspended');
          const before = uploads.filter((upload) => upload.mode === 'lifecycle').length;
          await page.evaluate(() => document.querySelector('#counter').textContent = 'hidden-mutation-canary');
          await sleep(100);
          assert.equal(uploads.filter((upload) => upload.mode === 'lifecycle').length, before);
          return true;
        }));
        outcome.idle800Minutes = Boolean(await check('800-minute hidden clock and resume', async () => {
          await page.clock.fastForward(800 * 60 * 1000);
          await page.bringToFront();
          await page.waitForFunction(() => document.visibilityState === 'visible');
          await page.click('#action');
          const resumedID = await page.evaluate(() => replay.getSessionId());
          assert.ok(resumedID && resumedID !== firstID);
          await page.evaluate(() => replay.flush());
          await sleep(150);
          return true;
        }));
        if (engine === 'chromium') await check('real renderer suspension', async () => {
          await backgroundTab.bringToFront();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
          await sleep(150);
          await cdp.send('Page.setWebLifecycleState', { state: 'active' });
          await page.bringToFront();
          await page.click('#action');
          assert.ok(await page.evaluate(() => replay.getSessionId()));
          await cdp.detach();
          return { method: 'CDP Page.setWebLifecycleState frozen/active' };
        });
        else outcome.checks.push({ name: 'native renderer suspension', state: 'release_gap',
          reason: 'engine has no renderer-freeze automation API; hidden 800-minute clock is separate controlled evidence' });
      } else {
        outcome.checks.push({ name: 'actual background tab and 800-minute hidden clock', state: 'release_gap',
          reason: 'this browser runner does not expose hidden visibility for another foreground tab' });
      }
      await backgroundTab.close();
      await page.bringToFront();
      await check('manual stop survives trusted input and visibility', async () => {
        await page.evaluate(() => replay.stop());
        await page.click('#action');
        assert.equal(await page.evaluate(() => replay.getSessionId()), '');
        await page.evaluate(() => replay.start());
        assert.ok(await page.evaluate(() => replay.getSessionId()));
        return true;
      });
      const beforeNavigationID = await page.evaluate(() => {
        const originalNow = Date.now.bind(Date);
        Date.now = () => originalNow() + Number(sessionStorage.getItem('fixture-elapsed-ms') || 0);
        return replay.getSessionId();
      });
      await page.goto(origin + '/away');
      outcome.pagehide = Boolean(await check('real pagehide', async () => {
        assert.ok(await page.evaluate(() => sessionStorage.getItem('fixture-pagehide')));
        return true;
      }));
      await page.evaluate(() => sessionStorage.setItem('fixture-elapsed-ms', String(800 * 60 * 1000)));
      await page.goBack({ waitUntil: 'commit' });
      await page.waitForFunction(() => Array.isArray(window.lifecycleEvents));
      const restored = await page.evaluate(() => lifecycleEvents.some((event) => event.type === 'pageshow' && event.persisted));
      outcome.backForwardCache = restored;
      outcome.checks.push({ name: 'real back-forward cache restore', state: restored ? 'pass' : 'release_gap',
        detail: restored ? await page.evaluate(() => ({ events: lifecycleEvents, session: replay.getSessionId() })) : 'navigation reloaded; no persisted pageshow in this runner' });
      if (restored) await check('800-minute pagehide and cache resume', async () => {
        await page.click('#action');
        const resumedID = await page.evaluate(() => replay.getSessionId());
        assert.ok(resumedID && resumedID !== beforeNavigationID, 'cached documents must not reuse an idle recording');
        return { elapsedMs: 800 * 60 * 1000, lifecycle: 'real pagehide/pageshow', clock: 'controlled Date.now offset' };
      });
      await page.close();
      const blockedContext = await browser.newContext();
      await blockedContext.addInitScript(() => {
        for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name,
          { get() { throw new DOMException('Blocked', 'SecurityError'); } });
      });
      const blockedPage = await blockedContext.newPage();
      await blockedPage.goto(origin);
      outcome.blockedStorage = Boolean(await check('blocked storage', async () => {
        assert.ok(await blockedPage.evaluate(() => { boot('blocked'); return replay.getSessionId(); }));
        await blockedPage.evaluate(() => replay.teardown());
        return true;
      }));
      await blockedContext.close();
      for (const mode of ['fetch', 'retry', 'beacon', 'private-unload', 'keepalive']) {
        await check(`${mode} serialized transport privacy bytes`, async () => {
          const transportPage = await realPage(context, engine);
          const calls = [];
          await transportPage.exposeBinding('__fixtureTransport', (_, call) => calls.push(call));
          await transportPage.addInitScript((forceFallback) => {
            const record = call => {
              const prior = JSON.parse(sessionStorage.getItem('fixture-transport-calls') || '[]');
              prior.push(call);
              sessionStorage.setItem('fixture-transport-calls', JSON.stringify(prior));
            };
            if (location.pathname !== '/away') sessionStorage.removeItem('fixture-transport-calls');
            const originalFetch = window.fetch.bind(window);
            window.fetch = (url, options) => {
              if (String(url).includes('/api/replays/')) record({ api: 'fetch', keepalive: Boolean(options?.keepalive), referrerPolicy: options?.referrerPolicy });
              return originalFetch(url, options);
            };
            const originalBeacon = navigator.sendBeacon.bind(navigator);
            navigator.sendBeacon = (url, body) => {
              const accepted = forceFallback ? false : originalBeacon(url, body);
              record({ api: 'beacon', accepted });
              return accepted;
            };
          }, mode === 'keepalive');
          await transportPage.goto(mode === 'beacon' || mode === 'keepalive' ? origin : `${origin}/?token=url-query-canary#fragment-canary`);
          await transportPage.bringToFront();
          const key = `${engine}-${mode}`;
          await transportPage.evaluate((name) => boot(name), key);
          await sleep(50);
          if (mode === 'fetch' || mode === 'retry') await transportPage.evaluate(() => replay.flush());
          else {
            // Actual navigation runs pagehide and delivers bytes to the local HTTP receiver.
            await transportPage.goto(origin + '/away');
          }
          await waitFor(() => uploads.filter((upload) => upload.mode === key).length >= (mode === 'retry' ? 2 : 1), `${key} actual HTTP request`);
          calls.push(...await transportPage.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-transport-calls') || '[]')));
          const emitted = uploads.filter((upload) => upload.mode === key);
          for (const upload of emitted) {
            assert.doesNotMatch(JSON.stringify(upload), /private-form-canary|url-query-canary|fragment-canary|attribute-canary|console-object-canary|console-message-canary|private-text-canary|hidden-mutation-canary/);
            assert.ok(upload.bytes > 0 && upload.events.length > 0);
            const boundaries = upload.events.filter((event) => event.data?.tag === 'tracekit.recording-boundary');
            assert.equal(boundaries.length, 2);
            assert.ok(boundaries[1].timestamp - boundaries[0].timestamp <= 2000, 'hidden time must not inflate recorded duration');
          }
          if (mode === 'retry') assert.deepEqual(emitted[0].events, emitted[1].events, 'retry bytes preserve immutable events');
          if (mode === 'beacon') assert.ok(calls.some(call => call.api === 'beacon' && call.accepted), 'safe URLs must retain actual beacon delivery');
          if (mode === 'private-unload') {
            assert.ok(!calls.some(call => call.api === 'beacon'), 'private host URLs must bypass automatic beacon Referer');
            assert.ok(calls.some(call => call.api === 'fetch' && call.keepalive && call.referrerPolicy === 'no-referrer'));
          }
          if (mode === 'keepalive') assert.ok(calls.some(call => call.api === 'fetch' && call.keepalive && call.referrerPolicy === 'no-referrer'));
          if (mode === 'fetch' || mode === 'retry') assert.ok(calls.filter(call => call.api === 'fetch').every(call => call.referrerPolicy === 'no-referrer'));
          const detail = { requests: emitted.length, decodedEvents: emitted.reduce((sum, upload) => sum + upload.events.length, 0), calls };
          await transportPage.evaluate(() => window.replay?.teardown());
          await transportPage.close();
          return detail;
        });
      }
      await context.close();
      outcome.state = outcome.checks.some((item) => item.state === 'fail') ? 'fail'
        : outcome.checks.some((item) => item.state === 'release_gap') ? 'release_gap' : 'pass';
    } catch (error) { outcome.state = 'fail'; outcome.reason = error.stack; }
    finally { clearTimeout(engineDeadline); await browser.close(); }
    outcomes.push(outcome);
  }
} finally { await new Promise((resolve) => server.close(resolve)); }
console.log(JSON.stringify({ fixtureRevision, bundleHashes: { replay: createHash('sha256').update(replayBundle).digest('hex'),
  browser: createHash('sha256').update(browserBundle).digest('hex') }, outcomes, inspectedTransports: uploads.length, errors }));
if (errors.length || outcomes.some((outcome) => outcome.state !== 'pass')) process.exitCode = 2;
