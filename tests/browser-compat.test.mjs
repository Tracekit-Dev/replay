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

async function run(bridge = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tracekit-replay-browser-compat-'));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const replay = await import('../dist/index.js');
    if (!bridge) {
      for (const version of ['0.1.1', '0.3.0']) {
        const released = await loadBundle(packageBundle(version, directory));
        const client = makeClient(released);
        const addon = replay.replayIntegration({ sessionSampleRate: 1 });
        warnings.length = 0;
        addon.install(client);
        if (typeof client.getScope().subscribeBreadcrumb === 'function') {
          throw new Error(`Published Browser ${version} unexpectedly exposes the unreleased bridge`);
        }
        if (!warnings.some((warning) => warning.includes('owned Browser subscriptions are unavailable'))) {
          throw new Error(`Published Browser ${version} did not report bounded fallback`);
        }
        addon.teardown?.();
        client.destroy();
      }
      process.stdout.write('PASS: published Browser 0.1.1 and 0.3.0 bounded fallback; no local bridge or sibling substitution\n');
      return;
    }
    const explicitModule = process.env.BROWSER_BRIDGE_MODULE;
    const sourceCommit = process.env.BROWSER_BRIDGE_COMMIT;
    if (!explicitModule || !existsSync(explicitModule) || !/^[a-f0-9]{40}$/.test(sourceCommit || '')) {
      throw new Error('Explicit bridge validation requires BROWSER_BRIDGE_MODULE and its exact BROWSER_BRIDGE_COMMIT');
    }
    const current = await loadBundle(explicitModule);
    const currentClient = makeClient(current);
    if (typeof currentClient.getScope().subscribeBreadcrumb !== 'function') {
      throw new Error(`Explicit local Browser source ${sourceCommit} does not expose subscribeBreadcrumb`);
    }
    const currentReplay = replay.replayIntegration({ sessionSampleRate: 1 });
    currentReplay.install(currentClient);

    process.stdout.write(`PASS: explicit unpublished local Browser subscription bridge, source ${sourceCommit}\n`);
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
    it('supports actual published bundle fallback without local siblings', async () => {
      await run();
    });
  });
} else if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.includes('--bridge'));
}

export { run };
