import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function packageBundle(version, directory) {
  const target = join(directory, version);
  mkdirSync(target, { recursive: true });
  const output = execFileSync('npm', ['pack', `@tracekit/browser@${version}`, '--pack-destination', target, '--silent'], {
    encoding: 'utf8',
  }).trim();
  const archive = join(target, output.split(/\r?\n/).at(-1));
  execFileSync('tar', ['-xzf', archive, '-C', target]);
  return join(target, 'package', 'dist', 'index.js');
}

async function loadBundle(file) {
  return import(`${pathToFileURL(file).href}?compat=${Date.now()}-${Math.random()}`);
}

function makeClient(browser, config) {
  return new browser.BrowserClient(browser.resolveConfig({
    apiKey: 'compat-key',
    endpoint: 'https://tracekit.test',
    enabled: true,
    ...config,
  }));
}

async function run() {
  const directory = mkdtempSync(join(tmpdir(), 'tracekit-replay-browser-compat-'));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const lowest = await loadBundle(packageBundle('0.1.1', directory));
    const localCurrent = join(process.cwd(), '..', 'browser-phase-187', 'dist', 'index.js');
    const current = await loadBundle(existsSync(localCurrent) ? localCurrent : packageBundle('0.3.0', directory));
    const replay = await import('../dist/index.js');

    const oldClient = makeClient(lowest);
    const oldReplay = replay.replayIntegration({ sessionSampleRate: 1 });
    oldReplay.install(oldClient);
    if (typeof oldClient.getScope().subscribeBreadcrumb === 'function') {
      throw new Error('Browser 0.1.1 unexpectedly exposes subscribeBreadcrumb');
    }
    if (!warnings.some((warning) => warning.includes('owned Browser subscriptions are unavailable'))) {
      throw new Error('Replay did not report the bounded missing-subscription reason');
    }
    oldReplay.teardown?.();
    oldClient.destroy();

    const currentClient = makeClient(current);
    if (typeof currentClient.getScope().subscribeBreadcrumb !== 'function') {
      throw new Error('Browser 0.3.0 does not expose subscribeBreadcrumb');
    }
    const currentReplay = replay.replayIntegration({ sessionSampleRate: 1 });
    currentReplay.install(currentClient);

    process.stdout.write('PASS: Browser 0.1.1 bounded bridge fallback and Browser 0.3.0 subscription bridge\n');
    currentReplay.teardown?.();
    currentClient.destroy();
  } finally {
    console.warn = originalWarn;
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.env.VITEST) {
  const { describe, it } = await import('vitest');
  describe('Browser bundle compatibility', () => {
    it('supports the lowest bundle fallback and current bridge', async () => {
      await run();
    });
  });
} else if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run();
}

export { run };
