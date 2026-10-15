import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function createReasoningProps(options: { text: string; status?: 'running' | 'settled'; thinkAutoExpand?: boolean }) {
  const { text, status = 'settled', thinkAutoExpand = false } = options
  return {
    node: {
      kind: 'assistant-step',
      location: { kind: 'unresolved' },
      data: {
        status,
        blocks: [{ kind: 'reasoning', text }],
        turn: 1,
        step: 1,
        time: 0,
      },
    },
    thinkAutoExpand,
    loadImage: async () => new Blob(),
    useTurnData: () => undefined,
    openFile: () => {},
    fileMentions: () => undefined,
    t: (key: string) => {
      if (key === 'message.think') return '思考'
      if (key === 'message.original') return '原文'
      return key
    },
  } as unknown as Parameters<typeof TypewriterAssistantNodeView>[0]
}

describe('think translation integration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders translated thinking and expandable original details when endpoint succeeds', async () => {
    const originalText = 'Evaluating the candidates for database indexing.'
    const translatedText = '评估数据库索引的候选方案。'

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, text: translatedText }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

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

  it('defers translation while streaming and only translates once settled', async () => {
    const partialText = 'Evaluating candidates in real time...'
    const settledText = 'Evaluating candidates in real time... Done.'
    const translatedText = '实时评估候选方案... 完成。'

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, text: translatedText }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // 1. When running (even if auto-expanded), no translation fetch occurs
    const view = render(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: partialText, status: 'running', thinkAutoExpand: true })}
      />,
    )

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain('原文')

    // 2. Once settled, translation is triggered
    view.rerender(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: settledText, status: 'settled', thinkAutoExpand: true })}
      />,
    )

    await waitFor(() => {
      expect(view.container.textContent).toContain(translatedText)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors mode=expand preference for collapsed history and triggers on user expansion', async () => {
    localStorage.setItem('dsh-think-translate:mode', 'expand')
    const originalText = 'Historical reasoning from earlier turn.'
    const translatedText = '来自更早轮次的历史思考过程。'

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, text: translatedText }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // Render collapsed history row
    const view = render(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: originalText, status: 'settled', thinkAutoExpand: false })}
      />,
    )

    // In expand-only mode, collapsed row must NOT trigger fetch
    await new Promise(resolve => setTimeout(resolve, 50))
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

    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Network glitch'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, text: translatedText }),
      })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // 1. Mount settled in expand mode, then expand
    const view = render(
      <TypewriterAssistantNodeView
        {...createReasoningProps({ text: originalText, status: 'settled', thinkAutoExpand: false })}
      />,
    )
    const toggleButton = view.container.querySelector('[class*="thinkRow"]') || view.container.querySelector('button')
    fireEvent.click(toggleButton!)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(view.container.textContent).toContain(originalText)

    // 2. Collapse and reopen: cache key was not locked by the failure, so it retries and succeeds
    fireEvent.click(toggleButton!)
    await new Promise(resolve => setTimeout(resolve, 20))
    fireEvent.click(toggleButton!)

    await waitFor(() => {
      expect(view.container.textContent).toContain(translatedText)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back gracefully to original text when translation endpoint is unavailable', async () => {
    const originalText = 'Checking network configuration.'

    const fetchMock = vi.fn().mockRejectedValue(new Error('Endpoint unavailable'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const view = render(<TypewriterAssistantNodeView {...createReasoningProps({ text: originalText })} />)

    // Wait microtasks to ensure fetch rejected
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(view.container.textContent).toContain(originalText)
    expect(view.container.textContent).not.toContain('原文')
  })

  it('skips translation when disabled in storage preferences', async () => {
    localStorage.setItem('dsh-think-translate:think', 'false')
    const originalText = 'Reading memory preferences.'

    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const view = render(<TypewriterAssistantNodeView {...createReasoningProps({ text: originalText })} />)

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(view.container.textContent).toContain(originalText)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
