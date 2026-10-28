// @vitest-environment jsdom
/**
 * Fold-state ownership boundaries.
 *
 * One Turn renders through more than one assistant row, and one block's
 * disclosure must not be re-asserted by a setting that does not concern it.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'
import type { TurnProcessOwnerFace } from '../src/client/turn-process-face.d.ts'
import type { ThinkFoldPolicy } from '../src/fold-policy.ts'

type ViewProps = Parameters<typeof TypewriterAssistantNodeView>[0]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function props(step: number, reasoning = false): ViewProps {
  return {
    node: {
      kind: 'assistant-step',
      location: {
        kind: 'step',
        turn: { status: 'closed', turn: 1 },
        step: { status: 'closed' },
      },
      data: {
        status: 'settled',
        blocks: reasoning
          ? [{ kind: 'reasoning', text: 'Finished reasoning to read.' }]
          : [{ kind: 'text', text: `Step ${step}` }],
        turn: 1,
        step,
        time: 0,
      },
    },
    useTurnData: () => undefined,
    openFile: () => {},
    fileMentions: () => undefined,
    t: (key: string) => key,
    controlScroll: false,
    motionPreference: 'force-reduced',
  } as unknown as ViewProps
}

describe('fold state ownership', () => {
  it('preserves a manual fold when another row of the same closed Turn mounts', () => {
    // Model the shared per-Turn state owned by the kernel. Each assistant
    // renderer receives the same Turn-process owner, not its own store.
    let storedOpen = false
    const setOpen = vi.fn((open: boolean) => { storedOpen = open })

    function rows(includeEarlierStep: boolean) {
      const turnProcess: TurnProcessOwnerFace = {
        spec: { answerStep: 2, inlineReasoning: true },
        foldable: true,
        open: storedOpen,
        setOpen,
      }
      return (
        <>
          {includeEarlierStep && (
            <TypewriterAssistantNodeView
              key="earlier-step"
              {...props(1)}
              turnProcess={turnProcess}
              turnFold="expanded"
            />
          )}
          <TypewriterAssistantNodeView
            key="answer-step"
            {...props(2)}
            turnProcess={turnProcess}
            turnFold="expanded"
          />
        </>
      )
    }

    const view = render(rows(false))
    expect(setOpen).toHaveBeenCalledWith(true)
    expect(storedOpen).toBe(true)

    // The reader explicitly folds the process after the initial override.
    storedOpen = false
    setOpen.mockClear()
    view.rerender(rows(false))
    expect(setOpen).not.toHaveBeenCalled()

    // A historical page adds an earlier assistant step of this SAME Turn.
    // Its fresh component-local ref must not override the reader's choice.
    view.rerender(rows(true))
    expect(setOpen).not.toHaveBeenCalled()
    expect(storedOpen).toBe(false)
  })

  it('does not re-apply from the reasoning part of the same answer step', () => {
    // Supporting kernels render one assistant step twice, once per flow part.
    // Both carry the same data.step, so the answer check alone lets the
    // reasoning row claim the Turn as well.
    const storedOpen = { current: false }
    const setOpen = vi.fn((open: boolean) => { storedOpen.current = open })
    const turnProcess: TurnProcessOwnerFace = {
      spec: { answerStep: 2, inlineReasoning: true },
      foldable: true,
      open: storedOpen.current,
      setOpen,
    }
    function rows(includeReasoning: boolean) {
      return (
        <>
          {includeReasoning && (
            <TypewriterAssistantNodeView
              key="reasoning-part"
              {...props(2)}
              groupPart="reasoning"
              turnProcess={turnProcess}
              turnFold="expanded"
            />
          )}
          <TypewriterAssistantNodeView
            key="response-part"
            {...props(2)}
            groupPart="response"
            turnProcess={turnProcess}
            turnFold="expanded"
          />
        </>
      )
    }

    const view = render(rows(false))
    expect(setOpen).toHaveBeenCalledTimes(1)
    expect(storedOpen.current).toBe(true)

    // The reader folds it by hand; the response row stays mounted.
    storedOpen.current = false
    setOpen.mockClear()

    // The same step's reasoning row mounts afterwards.
    view.rerender(rows(true))
    expect(setOpen).not.toHaveBeenCalled()
    expect(storedOpen.current).toBe(false)
  })

  it('preserves a manually expanded reasoning block when only its height changes', () => {
    const limited: ThinkFoldPolicy = {
      running: 'expanded',
      settled: 'collapsed',
      height: 'limited',
    }
    // Delegate the body so the test does not invoke the optional translation
    // endpoint. Only disclosure state and the height preference are involved.
    const renderReasoningBody: NonNullable<ViewProps['renderReasoningBody']> =
      text => <span>{text}</span>
    const base = props(2, true)
    const view = render(
      <TypewriterAssistantNodeView
        {...base}
        thinkFold={limited}
        renderReasoningBody={renderReasoningBody}
      />,
    )
    const toggle = view.getByRole('button', { name: /message\.think/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    view.rerender(
      <TypewriterAssistantNodeView
        {...base}
        thinkFold={{ ...limited, height: 'full' }}
        renderReasoningBody={renderReasoningBody}
      />,
    )
    expect(view.container.querySelector('[data-unbounded]')).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})
