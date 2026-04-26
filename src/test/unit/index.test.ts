import { describe, expect, it } from 'vitest'
import { version } from '../../main/ts/index.ts'

describe('smoke', () => {
  it('toolchain works', () => {
    expect(version).toBe('0.0.0')
  })
})
