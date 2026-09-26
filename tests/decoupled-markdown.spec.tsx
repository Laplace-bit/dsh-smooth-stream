import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { hasUnclosedCodeFence, useDecoupledMarkdown } from '../src/client/useDecoupledMarkdown.ts'

describe('hasUnclosedCodeFence', () => {
  it('identifies plain text as closed', () => {
    expect(hasUnclosedCodeFence('hello world')).toBe(false)
    expect(hasUnclosedCodeFence('paragraph 1\n\nparagraph 2')).toBe(false)
  })

  it('identifies unclosed code blocks with backticks', () => {
    expect(hasUnclosedCodeFence('```diff\n- foo\n+ bar')).toBe(true)
    expect(hasUnclosedCodeFence('```\nconsole.log(1)')).toBe(true)
  })

  it('identifies closed code blocks as closed', () => {
    expect(hasUnclosedCodeFence('```diff\n- foo\n+ bar\n```')).toBe(false)
    expect(hasUnclosedCodeFence('```\nconsole.log(1)\n```\n')).toBe(false)
  })

  it('ignores inline code', () => {
    expect(hasUnclosedCodeFence('This is `inline code` in text')).toBe(false)
    expect(hasUnclosedCodeFence('```\ncode\n```\n`inline code`')).toBe(false)
  })

  it('handles multiple code blocks sequentially', () => {
    const closedFirst = '```js\nconst a = 1\n```\n\nmiddle text\n\n```python\nx = 2'
    expect(hasUnclosedCodeFence(closedFirst)).toBe(true)

    const bothClosed = closedFirst + '\n```'
    expect(hasUnclosedCodeFence(bothClosed)).toBe(false)
  })

  it('handles tilde fences', () => {
    expect(hasUnclosedCodeFence('~~~html\n<div>hello</div>')).toBe(true)
    expect(hasUnclosedCodeFence('~~~html\n<div>hello</div>\n~~~')).toBe(false)
  })

  it('respects indentation limit of 3 spaces', () => {
    expect(hasUnclosedCodeFence('   ```sql\nselect 1')).toBe(true)
    // 4 spaces is an indented code block in Markdown, not a fenced code block
    expect(hasUnclosedCodeFence('    ```sql\nselect 1')).toBe(false)
  })
})

describe('useDecoupledMarkdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('syncs plain text immediately without delay', () => {
    const { result, rerender } = renderHook(
      ({ text, live }) => useDecoupledMarkdown(text, live, { throttleMs: 80 }),
      { initialProps: { text: 'Hello', live: true } }
    )

    expect(result.current).toBe('Hello')

    rerender({ text: 'Hello world', live: true })
    expect(result.current).toBe('Hello world')
  })

  it('throttles re-renders inside unclosed code blocks', () => {
    const { result, rerender } = renderHook(
      ({ text, live }) => useDecoupledMarkdown(text, live, { throttleMs: 80 }),
      { initialProps: { text: 'Intro\n\n```ts\n', live: true } }
    )

    // First frame inside code block renders
    expect(result.current).toBe('Intro\n\n```ts\n')

    // Subsequent updates within 80ms are throttled
    act(() => {
      vi.advanceTimersByTime(20)
    })
    rerender({ text: 'Intro\n\n```ts\nconst x = 1', live: true })
    expect(result.current).toBe('Intro\n\n```ts\n') // still throttled

    // When time reaches 80ms, the latest text is committed
    act(() => {
      vi.advanceTimersByTime(60)
    })
    expect(result.current).toBe('Intro\n\n```ts\nconst x = 1')
  })

  it('synchronizes immediately upon code block closure', () => {
    const { result, rerender } = renderHook(
      ({ text, live }) => useDecoupledMarkdown(text, live, { throttleMs: 80 }),
      { initialProps: { text: '```ts\nconst a = 1', live: true } }
    )

    expect(result.current).toBe('```ts\nconst a = 1')

    // Append more content within throttle window
    act(() => {
      vi.advanceTimersByTime(20)
    })
    rerender({ text: '```ts\nconst a = 1\nconst b = 2', live: true })
    expect(result.current).toBe('```ts\nconst a = 1') // throttled

    // Now close the code block - must sync immediately!
    rerender({ text: '```ts\nconst a = 1\nconst b = 2\n```', live: true })
    expect(result.current).toBe('```ts\nconst a = 1\nconst b = 2\n```')
  })

  it('defaults to 33ms (30Hz) throttle when options are omitted', () => {
    const { result, rerender } = renderHook(
      ({ text, live }) => useDecoupledMarkdown(text, live),
      { initialProps: { text: '```ts\n', live: true } }
    )

    expect(result.current).toBe('```ts\n')

    act(() => {
      vi.advanceTimersByTime(15)
    })
    rerender({ text: '```ts\nconst a = 1', live: true })
    expect(result.current).toBe('```ts\n') // throttled at 15ms

    act(() => {
      vi.advanceTimersByTime(20) // total 35ms >= 33ms
    })
    expect(result.current).toBe('```ts\nconst a = 1')
  })

  it('syncs plain text and tables synchronously with zero active timers', () => {
    const { result, rerender } = renderHook(
      ({ text, live }) => useDecoupledMarkdown(text, live),
      { initialProps: { text: '| col1 | col2 |\n|---|---|\n', live: true } }
    )

    expect(result.current).toBe('| col1 | col2 |\n|---|---|\n')
    // Outside unclosed code blocks, absolutely no timer should be scheduled
    expect(vi.getTimerCount()).toBe(0)

    rerender({
      text: '| col1 | col2 |\n|---|---|\n| row1 | val1 |\n\nSome paragraph',
      live: true,
    })
    expect(result.current).toBe('| col1 | col2 |\n|---|---|\n| row1 | val1 |\n\nSome paragraph')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('transitions from plain text into unclosed fence and preserves opening fence immediately', () => {
    const { result, rerender } = renderHook(
      ({ text, live }) => useDecoupledMarkdown(text, live, { throttleMs: 80 }),
      { initialProps: { text: 'Paragraph before code block.\n\n', live: true } }
    )

    expect(result.current).toBe('Paragraph before code block.\n\n')

    // Transition into unclosed fence: opening fence must render immediately
    rerender({ text: 'Paragraph before code block.\n\n```python\n', live: true })
    expect(result.current).toBe('Paragraph before code block.\n\n```python\n')

    // Next update within throttle window is throttled
    act(() => {
      vi.advanceTimersByTime(30)
    })
    rerender({ text: 'Paragraph before code block.\n\n```python\nprint(123)', live: true })
    expect(result.current).toBe('Paragraph before code block.\n\n```python\n')

    // Advance to 80ms
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(result.current).toBe('Paragraph before code block.\n\n```python\nprint(123)')
  })
})
