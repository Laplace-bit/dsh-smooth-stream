import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'
import type { ThinkFoldPolicy } from '../src/fold-policy.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Streaming open, folded at rest. */
const EXPANDED_FOLD: ThinkFoldPolicy = { running: 'expanded', settled: 'collapsed', height: 'limited' }
/** Folded in both phases. */
const COLLAPSED_FOLD: ThinkFoldPolicy = { running: 'collapsed', settled: 'collapsed', height: 'limited' }

function createReasoningProps(options: {
  text: string
  status?: 'running' | 'settled'
  thinkFold?: ThinkFoldPolicy
  isLatest?: boolean
}) {
  const { text, status = 'settled', thinkFold = COLLAPSED_FOLD, isLatest = true } = options
  const finalSeq = 10
  const tailClosingSeq = isLatest ? 10 : 20
  return {
    node: {
      kind: 'assistant-step',
      location: { kind: 'step' },
      data: {
        status,
        blocks: [{ kind: 'reasoning', text }],
        turn: 1,
        step: 1,
        time: 0,
        finalNode: { seq: finalSeq },
      },
    },
    thinkFold,
    loadImage: async () => new Blob(),
    useTurnData: (key: string) => {
      if (key === 'turn-tail') {
        return {
          closing: {
            finalNode: { seq: tailClosingSeq },
          },
        }
      }
      return undefined
    },
    openFile: () => {},
    fileMentions: () => undefined,
    t: (key: string) => {
      if (key === 'message.think') return '思考'
      if (key === 'message.original') return '原文'
      return key
    },
  } as unknown as Parameters<typeof TypewriterAssistantNodeView>[0]
}

function translatedResponse(text: string): Response {
  return new Response(JSON.stringify({ ok: true, text }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('think translation integration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders translated thinking and expandable original details when endpoint succeeds', async () => {
    const originalText = 'Evaluating the candidates for database indexing.'
    const translatedText = '评估数据库索引的候选方案。'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(translatedResponse(translatedText))

    const view = render(<TypewriterAssistantNodeView {...createReasoningProps({ text: originalText })} />)

    await waitFor(() => {
      expect(view.container.textContent).toContain(translatedText)
    })

    // Contains translation, summary is translated, and original details exist
    expect(view.container.textContent).toContain('原文')
    expect(view.container.textContent).toContain(originalText)
    expect(fetchMock).toHaveBeenCalledWith(
      '/_xlate/translate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: originalText, target: 'zh-CN' }),
      }),
    )
  })

  it('drops a stale translation when settled reasoning changes and the new request fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(translatedResponse('旧译文'))
      .mockRejectedValueOnce(new Error('Translation unavailable'))
    const view = render(<TypewriterAssistantNodeView {...createReasoningProps({ text: 'First reasoning' })} />)

    await waitFor(() => { expect(view.container.textContent).toContain('旧译文') })
    view.rerender(<TypewriterAssistantNodeView {...createReasoningProps({ text: 'Updated reasoning' })} />)

    expect(view.container.textContent).toContain('Updated reasoning')
    expect(view.container.textContent).not.toContain('旧译文')
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).not.toContain('旧译文')
  })

  it('invalidates visible translation when preferences change before the next render', async () => {
    const originalText = 'Reasoning with configurable translation.'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(translatedResponse('中文译文'))
      .mockResolvedValueOnce(translatedResponse('English translation'))
    const view = render(<TypewriterAssistantNodeView {...createReasoningProps({ text: originalText })} />)
    await waitFor(() => { expect(view.container.textContent).toContain('中文译文') })

    localStorage.setItem('dsh-think-translate:think', 'false')
    view.rerender(<TypewriterAssistantNodeView {...createReasoningProps({ text: originalText })} />)
    expect(view.container.textContent).not.toContain('中文译文')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    localStorage.setItem('dsh-think-translate:think', 'true')
    localStorage.setItem('dsh-think-translate:lang', 'en')
    view.rerender(<TypewriterAssistantNodeView {...createReasoningProps({ text: originalText })} />)
    await waitFor(() => { expect(view.container.textContent).toContain('English translation') })
    expect(view.container.textContent).not.toContain('中文译文')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('defers translation while streaming and only translates once settled', async () => {
    const partialText = 'Evaluating candidates in real time...'
    const settledText = 'Evaluating candidates in real time... Done.'
    const translatedText = '实时评估候选方案... 完成。'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(translatedResponse(translatedText))

    // 1. When running (even if auto-expanded), no translation fetch occurs
    const view = render(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: partialText, status: 'running', thinkFold: EXPANDED_FOLD })}
      />,
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain('原文')

    // 2. Once settled, translation is triggered for the active/latest row
    view.rerender(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: settledText, status: 'settled', thinkFold: EXPANDED_FOLD })}
      />,
    )

    await waitFor(() => {
      expect(view.container.textContent).toContain(translatedText)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('waits for collapsed historical reasoning to expand under default lazy mode', async () => {
    // Default mode is 'lazy'
    const historicalText = 'Historical reasoning from earlier conversation turn.'
    const translatedText = '来自早期会话轮次的历史思考过程。'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(translatedResponse(translatedText))

    // Render collapsed historical row (isLatest: false)
    const view = render(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: historicalText, status: 'settled', isLatest: false, thinkFold: COLLAPSED_FOLD })}
      />,
    )

    // Under default lazy mode, collapsed historical rows must NOT trigger fetch
    expect(fetchMock).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain(translatedText)

    // User expands historical Think disclosure
    const toggleButton = view.container.querySelector('[class*="thinkRow"]') || view.container.querySelector('button')
    expect(toggleButton).not.toBeNull()
    fireEvent.click(toggleButton!)

    // Now that it is expanded, translation is fetched and rendered
    await waitFor(() => {
      expect(view.container.textContent).toContain(translatedText)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors mode=expand preference for collapsed rows and triggers on user expansion', async () => {
    localStorage.setItem('dsh-think-translate:mode', 'expand')
    const originalText = 'Reasoning under expand-only mode.'
    const translatedText = '仅展开模式下的思考过程。'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(translatedResponse(translatedText))

    // Render collapsed row in expand-only mode
    const view = render(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: originalText, status: 'settled', thinkFold: COLLAPSED_FOLD })}
      />,
    )

    // In expand-only mode, collapsed row must NOT trigger fetch
    expect(fetchMock).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain(translatedText)

    // User clicks the Think row disclosure to expand
    const toggleButton = view.container.querySelector('[class*="thinkRow"]') || view.container.querySelector('button')
    expect(toggleButton).not.toBeNull()
    fireEvent.click(toggleButton!)

    // Now that it is expanded, translation is fetched and rendered
    await waitFor(() => {
      expect(view.container.textContent).toContain(translatedText)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not permanently lock cache key if an in-flight request fails or is invalidated', async () => {
    localStorage.setItem('dsh-think-translate:mode', 'expand')
    const originalText = 'Testing retry behavior after network failure.'
    const translatedText = '测试网络失败后的重试行为。'

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Network glitch'))
      .mockResolvedValueOnce(translatedResponse(translatedText))

    // 1. Mount settled in expand mode, then expand
    const view = render(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: originalText, status: 'settled', thinkFold: COLLAPSED_FOLD })}
      />,
    )
    const toggleButton = view.container.querySelector('[class*="thinkRow"]') || view.container.querySelector('button')
    fireEvent.click(toggleButton!)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain(originalText)

    // 2. Collapse and reopen: cache key was not locked by the failure, so it retries and succeeds
    fireEvent.click(toggleButton!)
    fireEvent.click(toggleButton!)

    await waitFor(() => {
      expect(view.container.textContent).toContain(translatedText)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back gracefully to original text when translation endpoint is unavailable', async () => {
    const originalText = 'Checking network configuration.'

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Endpoint unavailable'))

    const view = render(<TypewriterAssistantNodeView {...createReasoningProps({ text: originalText })} />)

    // Wait microtasks to ensure fetch rejected
    await act(async () => { await Promise.resolve() })

    expect(view.container.textContent).toContain(originalText)
    expect(view.container.textContent).not.toContain('原文')
  })

  it('skips translation when disabled in storage preferences', async () => {
    localStorage.setItem('dsh-think-translate:think', 'false')
    const originalText = 'Reading memory preferences.'

    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const view = render(<TypewriterAssistantNodeView {...createReasoningProps({ text: originalText })} />)

    expect(view.container.textContent).toContain(originalText)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hands the expanded reasoning body to a replacing kernel feature instead of translating itself', async () => {
    const originalText = 'Evaluating the candidates for database indexing.'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const renderBody = vi.fn((text: string) => <div data-kernel-body>{`translated:${text}`}</div>)

    const view = render(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: originalText, status: 'settled', thinkFold: COLLAPSED_FOLD })}
        renderReasoningBody={renderBody}
      />,
    )

    // A replaced Body is the kernel's expanded-disclosure contribution, so it
    // stays unmounted while the block is closed — exactly as the kernel's own
    // ReasoningRow leaves it, and no translation starts in the background.
    expect(renderBody).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-kernel-body]')).toBeNull()
    expect(view.container.textContent).toContain(originalText)

    fireEvent.click(view.container.querySelector('[data-disclosure-row]')!)

    await waitFor(() => { expect(view.container.querySelector('[data-kernel-body]')).not.toBeNull() })
    expect(renderBody).toHaveBeenCalledWith(originalText, false)

    // The plugin's own display-layer translation stands down: two translations
    // in one reasoning row would disagree with each other.
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain('原文')
  })
})
