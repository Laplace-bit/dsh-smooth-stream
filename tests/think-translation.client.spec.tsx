import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function settledReasoningProps(text: string) {
  return {
    node: {
      kind: 'assistant-step',
      location: { kind: 'unresolved' },
      data: {
        status: 'settled',
        blocks: [{ kind: 'reasoning', text }],
        turn: 1,
        step: 1,
        time: 0,
      },
    },
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

    const view = render(<TypewriterAssistantNodeView {...settledReasoningProps(originalText)} />)

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

  it('falls back gracefully to original text when translation endpoint is unavailable', async () => {
    const originalText = 'Checking network configuration.'

    const fetchMock = vi.fn().mockRejectedValue(new Error('Endpoint unavailable'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const view = render(<TypewriterAssistantNodeView {...settledReasoningProps(originalText)} />)

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

    const view = render(<TypewriterAssistantNodeView {...settledReasoningProps(originalText)} />)

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(view.container.textContent).toContain(originalText)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
