import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkRegistryVersion, classifyRegistryResult } from './npm-publish-decision.mjs';

test('skips an already published exact version', () => {
  assert.deepEqual(
    classifyRegistryResult({ status: 0, stdout: '"0.3.2"', stderr: '' }),
    { action: 'skip', publish: false, reason: 'already-published' },
  );
});

test('publishes only when npm returns exact E404', () => {
  assert.deepEqual(
    classifyRegistryResult({
      status: 1,
      stdout: '',
      stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@tracekit%2freplay - Not found',
    }),
    { action: 'publish', publish: true, reason: 'exact-version-not-found' },
  );
});

test('fails closed for authentication errors', () => {
  assert.deepEqual(
    classifyRegistryResult({ status: 1, stdout: '', stderr: 'npm error code E401' }),
    { action: 'fail', publish: false, reason: 'registry-lookup-failed' },
  );
});

test('fails closed for network errors', () => {
  assert.deepEqual(
    classifyRegistryResult({ status: 1, stdout: '', stderr: 'npm error code ENETUNREACH' }),
    { action: 'fail', publish: false, reason: 'registry-lookup-failed' },
  );
});

test('queries the exact package and version', () => {
  let command;
  const decision = checkRegistryVersion('@tracekit/replay', '0.3.2', (...args) => {
    command = args;
    return { status: 0, stdout: '"0.3.2"', stderr: '' };
  });

  assert.equal(decision.action, 'skip');
  assert.deepEqual(command.slice(0, 2), ['npm', ['view', '@tracekit/replay@0.3.2', 'version', '--json']]);
});

test('manual dispatch cannot publish from a non-main ref', () => {
  const workflow = readFileSync(new URL('../workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if:\s*github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.match(workflow, /group:\s*replay-npm-publication\s*\n\s*cancel-in-progress:\s*false/);
});

test('publishes through npm trusted publishing with the required toolchain', () => {
  const workflow = readFileSync(new URL('../workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read\s*\n\s*id-token:\s*write/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /node-version:\s*['"]24['"]/);
  assert.match(workflow, /package-manager-cache:\s*false/);
  assert.match(workflow, /npm install --global npm@11\.19\.1/);
  assert.doesNotMatch(workflow, /registry-url:/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.match(workflow, /\.github\/workflows\/publish\.yml/);
  assert.match(workflow, /npm pack --dry-run --json/);
  assert.match(workflow, /npm publish --access public --provenance --tag latest/);
});

test('keeps the package repository aligned with the trusted publisher', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.repository.url, 'https://github.com/Tracekit-Dev/replay');
});
