import { describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }

describe('browser SDK compatibility', () => {
  it('supports Browser SDK 0.2 while retaining 0.1 compatibility', () => {
    expect(packageJson.version).toBe('0.3.2')
    expect(packageJson.peerDependencies['@tracekit/browser']).toBe('^0.1.1 || ^0.2.0')
    expect(packageJson.devDependencies['@tracekit/browser']).toBe('^0.2.0')
  })
})
