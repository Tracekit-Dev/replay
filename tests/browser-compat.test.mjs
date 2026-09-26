import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as oldest from '../node_modules/@tracekit/browser/dist/index.js';
import * as current from '../../browser/dist/index.js';
import { replayIntegration } from '../dist/index.js';

async function packageVersion(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')).version;
}

async function checkActualBundles() {
  const oldestVersion = await packageVersion('../node_modules/@tracekit/browser/package.json');
  const currentVersion = await packageVersion('../../browser/package.json');
  assert.equal(oldestVersion, '0.1.1', 'the installed oldest bundle must be the declared peer minimum');

  const options = { apiKey: 'test-key', endpoint: 'https://api.test', enabled: true,
    integrations: { globalError: false, console: false, fetch: false, xhr: false, dom: false, navigation: false } };

  const oldClient = new oldest.BrowserClient(options);
  const oldScope = oldClient.getScope();
  assert.equal(typeof oldScope.subscribeBreadcrumb, 'undefined');
  let legacyCalls = 0;
  oldScope.onBreadcrumb(() => { legacyCalls++; });
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  const oldReplay = replayIntegration({ sessionSampleRate: 0, errorSampleRate: 0 });
  try {
    oldReplay.install(oldClient);
    oldScope.addBreadcrumb({ type: 'console', category: 'console.log', message: 'synthetic' });
    assert.equal(legacyCalls, 1, 'Replay must not replace the legacy listener');
    assert.equal(warnings.filter((message) => message.includes('subscription bridge is missing')).length, 1);
  } finally {
    oldReplay.teardown?.();
    oldClient.destroy?.();
    console.warn = previousWarn;
  }

  const currentClient = new current.BrowserClient(options);
  const currentScope = currentClient.getScope();
  assert.equal(typeof currentScope.subscribeBreadcrumb, 'function');
  let hostCalls = 0;
  const unsubscribe = currentScope.subscribeBreadcrumb(() => { hostCalls++; });
  const newReplay = replayIntegration({ sessionSampleRate: 0, errorSampleRate: 0 });
  try {
    newReplay.install(currentClient);
    currentScope.addBreadcrumb({ type: 'console', category: 'console.log', message: 'synthetic' });
    assert.equal(hostCalls, 1);
    newReplay.teardown?.();
    currentScope.addBreadcrumb({ type: 'console', category: 'console.log', message: 'synthetic' });
    assert.equal(hostCalls, 2, 'Replay disposal must preserve the host subscription');
  } finally {
    newReplay.teardown?.();
    unsubscribe();
    currentClient.destroy?.();
  }

  return { oldestVersion, currentVersion, oldBridge: false, currentBridge: true };
}

if (process.env.VITEST_WORKER_ID !== undefined) {
  const { describe, it, expect } = await import('vitest');
  describe('actual Browser bundle compatibility', () => {
    it('preserves the old listener and uses the current owned bridge', async () => {
      const result = await checkActualBundles();
      expect(result.oldBridge).toBe(false);
      expect(result.currentBridge).toBe(true);
    });
  });
} else {
  const result = await checkActualBundles();
  process.stdout.write(`Browser compatibility passed: installed ${result.oldestVersion} lacks the owned bridge; checkout ${result.currentVersion} has it.\n`);
}
