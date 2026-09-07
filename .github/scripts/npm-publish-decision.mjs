import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export function classifyRegistryResult({ status, stdout = '', stderr = '' }) {
  if (status === 0) {
    return { action: 'skip', publish: false, reason: 'already-published' };
  }

  const output = `${stdout}\n${stderr}`;
  if (/npm\s+(?:ERR!|error)\s+code\s+E404\b/i.test(output)) {
    return { action: 'publish', publish: true, reason: 'exact-version-not-found' };
  }

  return { action: 'fail', publish: false, reason: 'registry-lookup-failed' };
}

export function checkRegistryVersion(packageName, version, run = spawnSync) {
  const result = run('npm', ['view', `${packageName}@${version}`, 'version', '--json'], {
    encoding: 'utf8',
  });
  return classifyRegistryResult(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [packageName, version] = process.argv.slice(2);
  if (!packageName || !version) {
    console.error('Usage: npm-publish-decision.mjs <package-name> <version>');
    process.exit(1);
  }

  const decision = checkRegistryVersion(packageName, version);
  if (decision.action === 'fail') {
    console.error('The npm registry lookup failed. Publication is blocked.');
    process.exit(1);
  }

  const outputs = `publish=${decision.publish}\nreason=${decision.reason}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  console.log(outputs.trim());
}
