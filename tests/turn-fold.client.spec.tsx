// @vitest-environment jsdom
/** The Turn-level fold override: it waits for a closed Turn, then saves once. */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'
import type { TurnProcessOwnerFace } from '../src/client/turn-process-face.d.ts'

afterEach(() => {
  cleanup()
})

function props(
  turn: number,
  turnStatus: 'open' | 'closed' = 'closed',
): Parameters<typeof TypewriterAssistantNodeView>[0] {
  return {
    node: {
      kind: 'assistant-step',
      location: {
        kind: 'step',
        turn: { status: turnStatus, turn },
        step: { status: turnStatus },
      },
      data: { status: 'settled', blocks: [{ kind: 'text', text: 'done' }], turn, step: 1, time: 0 },
    },
    useTurnData: () => undefined,
    openFile: () => {},
    fileMentions: () => undefined,
    t: (key: string) => key,
  } as unknown as Parameters<typeof TypewriterAssistantNodeView>[0]
}

function process(
  overrides: Partial<TurnProcessOwnerFace> = {},
): TurnProcessOwnerFace & { setOpen: ReturnType<typeof vi.fn> } {
  return {
    spec: { answerStep: 1, inlineReasoning: true },
    foldable: true,
    open: false,
    setOpen: vi.fn(),
    ...overrides,
  } as TurnProcessOwnerFace & { setOpen: ReturnType<typeof vi.fn> }
}

describe('turn fold override', () => {
  it('leaves the kernel alone when following it', () => {
    const turnProcess = process()
    render(<TypewriterAssistantNodeView {...props(1)} turnProcess={turnProcess} turnFold="follow" />)
    expect(turnProcess.setOpen).not.toHaveBeenCalled()
  })

  it('expands a closed foldable Turn when asked', () => {
    const turnProcess = process()
    render(<TypewriterAssistantNodeView {...props(1)} turnProcess={turnProcess} turnFold="expanded" />)
    expect(turnProcess.setOpen).toHaveBeenCalledWith(true)
  })

  it('collapses a closed foldable Turn when asked', () => {
    const turnProcess = process({ open: true })
    render(<TypewriterAssistantNodeView {...props(1)} turnProcess={turnProcess} turnFold="collapsed" />)
    expect(turnProcess.setOpen).toHaveBeenCalledWith(false)
  })

  it('does not spend the override while the Turn is still running', () => {
    // The kernel forces a live Turn's process open and ignores setOpen.
    const running = process({ open: true })
    const view = render(<TypewriterAssistantNodeView {...props(1, 'open')} turnProcess={running} turnFold="expanded" />)
    expect(running.setOpen).not.toHaveBeenCalled()

    // The Turn closes and the kernel folds the process as usual.
    const closed = process({ open: false })
    view.rerender(<TypewriterAssistantNodeView {...props(1, 'closed')} turnProcess={closed} turnFold="expanded" />)
    expect(closed.setOpen).toHaveBeenCalledWith(true)
  })

  it('does not spend a collapsed override while the Turn is still running', () => {
    // next-input timing keeps the latest completed Turn open by default, so a
    // live Turn also reports open; the early answer must not be recorded.
    const running = process({ open: true })
    const view = render(<TypewriterAssistantNodeView {...props(1, 'open')} turnProcess={running} turnFold="collapsed" />)
    expect(running.setOpen).not.toHaveBeenCalled()

    const completed = process({ open: true })
    view.rerender(<TypewriterAssistantNodeView {...props(1, 'closed')} turnProcess={completed} turnFold="collapsed" />)
    expect(completed.setOpen).toHaveBeenCalledWith(false)
  })

  it('saves the choice even when the Turn already shows as expanded', () => {
    // An unstored `open` is the kernel's temporary default (for example with
    // next-input collapse timing), not a saved choice: the next input would
    // fold it back unless the answer is written down.
    const turnProcess = process({ open: true })
    render(<TypewriterAssistantNodeView {...props(1)} turnProcess={turnProcess} turnFold="expanded" />)
    expect(turnProcess.setOpen).toHaveBeenCalledWith(true)
  })

  it('does not re-apply the override after the reader folds it by hand', () => {
    const turnProcess = process()
    const view = render(<TypewriterAssistantNodeView {...props(1)} turnProcess={turnProcess} turnFold="expanded" />)
    expect(turnProcess.setOpen).toHaveBeenCalledTimes(1)

    // The reader clicked the summary: the same Turn is now folded.
    const folded = process({ open: false })
    view.rerender(<TypewriterAssistantNodeView {...props(1)} turnProcess={folded} turnFold="expanded" />)
    expect(folded.setOpen).not.toHaveBeenCalled()
  })

  it('applies the override again on a later Turn', () => {
    const first = process()
    const view = render(<TypewriterAssistantNodeView {...props(1)} turnProcess={first} turnFold="expanded" />)
    expect(first.setOpen).toHaveBeenCalledTimes(1)

    const second = process()
    view.rerender(<TypewriterAssistantNodeView {...props(2)} turnProcess={second} turnFold="expanded" />)
    expect(second.setOpen).toHaveBeenCalledWith(true)
  })

  it('waits for the Turn to become foldable', () => {
    const turnProcess = process({ foldable: false })
    const view = render(<TypewriterAssistantNodeView {...props(1)} turnProcess={turnProcess} turnFold="expanded" />)
    expect(turnProcess.setOpen).not.toHaveBeenCalled()

    const foldable = process({ open: false })
    view.rerender(<TypewriterAssistantNodeView {...props(1)} turnProcess={foldable} turnFold="expanded" />)
    expect(foldable.setOpen).toHaveBeenCalledWith(true)
  })
})
