import { describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }

describe('browser SDK compatibility', () => {
  it('supports every Browser SDK release from 0.1.1 onward', () => {
    expect(packageJson.version).toBe('0.3.3')
    expect(packageJson.peerDependencies['@tracekit/browser']).toBe('>=0.1.1')
    expect(packageJson.devDependencies['@tracekit/browser']).toBe('^0.2.0')
  })
})
