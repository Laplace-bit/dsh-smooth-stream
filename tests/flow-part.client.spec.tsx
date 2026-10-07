import { describe, expect, it } from 'vitest'
import { belongsToFlowPart, isFlowPartActiveTail, type AssistantStepPart } from '../src/client/flowPart.ts'

/** Every block kind a Host may put on an assistant step, reasoning last. */
const BLOCKS = [
  { kind: 'text', text: 'the answer body' },
  { kind: 'reasoning', text: 'weighing the candidates' },
  { kind: 'image' },
  { kind: 'tool-call' },
  { kind: 'other' },
]

describe('assistant flow-part routing', () => {
  it('paints every block on kernels that render a step once', () => {
    for (const block of BLOCKS) {
      expect(belongsToFlowPart(block, undefined), block.kind).toBe(true)
    }
  })

  it('keeps the reasoning part to reasoning blocks only', () => {
    expect(belongsToFlowPart({ kind: 'reasoning' }, 'reasoning')).toBe(true)
    for (const block of BLOCKS) {
      if (block.kind === 'reasoning') continue
      expect(belongsToFlowPart(block, 'reasoning'), block.kind).toBe(false)
    }
  })

  it('keeps the reply out of the reasoning part so the text is not painted twice', () => {
    // The Host forces the Turn's process disclosure open while the turn runs,
    // so a response block admitted here shows up as a duplicate answer.
    const answerBlock = { kind: 'text', text: 'the answer body' }
    expect(belongsToFlowPart(answerBlock, 'reasoning')).toBe(false)
    expect(belongsToFlowPart(answerBlock, 'response')).toBe(true)
  })

  it('drops reasoning from the response part', () => {
    expect(belongsToFlowPart({ kind: 'reasoning' }, 'response')).toBe(false)
    expect(belongsToFlowPart({ kind: 'tool-call' }, 'response')).toBe(true)
  })

  it('routes every block to exactly one of the two live parts', () => {
    const parts: AssistantStepPart[] = ['reasoning', 'response']
    for (const block of BLOCKS) {
      const owners = parts.filter(part => belongsToFlowPart(block, part))
      expect(owners, block.kind).toHaveLength(1)
    }
  })

  it('determines the active streaming tail part mutually exclusively', () => {
    // In legacy single-seat kernels, the single renderer is unconditionally the active tail
    expect(isFlowPartActiveTail([{ kind: 'reasoning' }], undefined)).toBe(true)
    expect(isFlowPartActiveTail([{ kind: 'text' }], undefined)).toBe(true)

    // When thinking is streaming, reasoning part is tail, response part is NOT
    const thinkingBlocks = [{ kind: 'reasoning', text: 'thinking...' }]
    expect(isFlowPartActiveTail(thinkingBlocks, 'reasoning')).toBe(true)
    expect(isFlowPartActiveTail(thinkingBlocks, 'response')).toBe(false)

    // When answer is streaming, response part is tail, reasoning part is NOT
    const answerBlocks = [
      { kind: 'reasoning', text: 'done thinking' },
      { kind: 'text', text: 'here is the answer' },
    ]
    expect(isFlowPartActiveTail(answerBlocks, 'reasoning')).toBe(false)
    expect(isFlowPartActiveTail(answerBlocks, 'response')).toBe(true)
  })
})

