/** Behavior of the reasoning fold policy that replaced the three switches. */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THINK_FOLD,
  foldStateFor,
  isFoldHeight,
  isFoldState,
  type ThinkFoldPolicy,
} from '../src/fold-policy.ts'

function policy(running: 'expanded' | 'collapsed', settled: 'expanded' | 'collapsed'): ThinkFoldPolicy {
  return { running, settled, height: 'limited' }
}

describe('fold policy', () => {
  it('answers each phase from its own field', () => {
    expect(foldStateFor(policy('expanded', 'collapsed'), true)).toBe('expanded')
    expect(foldStateFor(policy('expanded', 'collapsed'), false)).toBe('collapsed')
    expect(foldStateFor(policy('collapsed', 'expanded'), true)).toBe('collapsed')
    expect(foldStateFor(policy('collapsed', 'expanded'), false)).toBe('expanded')
    expect(foldStateFor(policy('expanded', 'expanded'), false)).toBe('expanded')
    expect(foldStateFor(policy('collapsed', 'collapsed'), true)).toBe('collapsed')
  })

  it('keeps the defaults of the three switches it replaced', () => {
    // auto-expand on, keep-after-settle off, height limit on.
    expect(DEFAULT_THINK_FOLD).toEqual({
      running: 'expanded',
      settled: 'collapsed',
      height: 'limited',
    })
  })

  it('accepts only the declared states', () => {
    expect(isFoldState('expanded')).toBe(true)
    expect(isFoldState('collapsed')).toBe(true)
    expect(isFoldState('manual')).toBe(false)
    expect(isFoldState(true)).toBe(false)
    expect(isFoldState(undefined)).toBe(false)
  })

  it('accepts only the declared heights', () => {
    expect(isFoldHeight('limited')).toBe(true)
    expect(isFoldHeight('full')).toBe(true)
    expect(isFoldHeight('auto')).toBe(false)
    expect(isFoldHeight(null)).toBe(false)
  })
})
