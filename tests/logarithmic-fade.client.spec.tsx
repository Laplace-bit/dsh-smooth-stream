import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fadeTailSize, logarithmicOpacity, LogarithmicFadeController, useLogarithmicFade } from '../src/client/useLogarithmicFade.ts'
import { TypewriterAssistantNodeView } from '../src/client/TypewriterAssistantNodeView.tsx'

/** Custom property the fade publishes its captured ink colour through. */
const FADE_COLOR = '--dsh-smooth-stream-fade-color'

const registry = new Map<string, Set<Range>>()
const controllers: LogarithmicFadeController[] = []
const ranges = () => [...registry.values()].flatMap(value => [...value])
function attach(text = '') {
  const root = document.createElement('div')
  root.textContent = text
  document.body.append(root)
  const controller = LogarithmicFadeController.create(root)!
  controllers.push(controller)
  return { root, controller }
}
function tick(ms: number) { act(() => { vi.advanceTimersByTime(ms) }) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] })
  registry.clear()
  vi.stubGlobal('Highlight', class extends Set<Range> {})
  vi.stubGlobal('CSS', { highlights: registry, supports: () => true })
})
afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('has bounded endpoints and a monotonic logarithmic curve', () => {
  expect(logarithmicOpacity(-1)).toBe(0)
  expect(logarithmicOpacity(0)).toBe(0)
  expect(logarithmicOpacity(1)).toBe(1)
  expect(logarithmicOpacity(2)).toBe(1)
  expect(logarithmicOpacity(NaN)).toBe(1)
  for (let i = 1; i <= 100; i += 1) expect(logarithmicOpacity(i / 100)).toBeGreaterThan(logarithmicOpacity((i - 1) / 100))
  expect(logarithmicOpacity(0.5)).toBeLessThan(0.4)
  expect(logarithmicOpacity(0.25)).toBeLessThan(0.21)
})

it('extends the tail at high speed and bounds invalid or extreme rates', () => {
  expect(fadeTailSize(35)).toBe(24)
  expect(fadeTailSize(300)).toBe(72)
  expect(fadeTailSize(600)).toBe(144)
  expect(fadeTailSize(10000)).toBe(160)
  expect(fadeTailSize(NaN)).toBe(24)
  expect(fadeTailSize(-1)).toBe(24)
})

it('keeps high-speed text translucent through a completion speed reset', () => {
  const { controller } = attach('文'.repeat(200))
  controller.update(true, true, 600)
  expect(ranges()).toHaveLength(144)
  tick(128)
  controller.update(true, false, 35)
  expect(ranges()).toHaveLength(144)
  tick(128)
  expect(ranges()).toHaveLength(0)
})

it('does not cut off the old tail when slowing down while appending', () => {
  const { root, controller } = attach('文'.repeat(48))
  controller.update(true, true, 200)
  tick(64)
  root.append('字'.repeat(10))
  controller.update(true, true, 35)
  expect(ranges()).toHaveLength(58)
  tick(192)
  expect(ranges()).toHaveLength(10)
  tick(64)
  expect(ranges()).toHaveLength(0)
})

it('keeps a 24-grapheme burst tail without changing DOM or selection text', () => {
  const tail = 'abcdefghijklmnopqrA👩‍👩‍👧‍👦é🇨🇳中文'
  const text = '不参与淡入的前文'.repeat(4) + tail
  const { root, controller } = attach(text)
  const node = root.firstChild
  controller.update(true, true)
  expect(ranges()).toHaveLength(24)
  expect(ranges().map(range => range.toString()).reverse().join('')).toBe(tail)
  expect(ranges().map(range => range.toString())).toContain('👩‍👩‍👧‍👦')
  expect(root.firstChild).toBe(node)
  expect(root.childNodes).toHaveLength(1)
  const selection = document.createRange()
  selection.selectNodeContents(root)
  expect(selection.toString()).toBe(text)
  tick(256)
  expect(ranges()).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('retains birth times through repeat commits, DOM replacement and append', () => {
  const { root, controller } = attach('a')
  controller.update(true, true)
  tick(128)
  root.replaceChildren(document.createTextNode('ab'))
  controller.update(true, true)
  controller.update(true, true)
  tick(128)
  expect(ranges().map(range => range.toString())).toEqual(['b'])
  tick(128)
  expect(ranges()).toHaveLength(0)
  controller.update(true, true)
  expect(ranges()).toHaveLength(0)
})

it('lingers after completion and clears immediately when disabled', () => {
  const { controller } = attach('hello')
  controller.update(true, true)
  tick(64)
  controller.update(true, false)
  expect(ranges()).toHaveLength(5)
  tick(192)
  expect(ranges()).toHaveLength(0)
  const second = attach('world')
  second.controller.update(true, true)
  second.controller.update(false, false)
  expect(ranges()).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('freezes opacity while paused and resumes from the same progress', () => {
  const { controller } = attach('暂停保留透明度')
  controller.update(true, true, 100)
  tick(64)
  const before = [...registry.entries()].filter(([, ranges]) => ranges.size > 0).map(([name]) => name)
  controller.update(true, true, 100, true)
  tick(500)
  const frozen = [...registry.entries()].filter(([, ranges]) => ranges.size > 0).map(([name]) => name)
  expect(frozen).toEqual(before)
  expect(ranges().length).toBeGreaterThan(0)
  controller.update(true, true, 100, false)
  tick(192)
  expect(ranges()).toHaveLength(0)
})

it('does not replay replacement, history or content revealed while disabled', () => {
  const { root, controller } = attach('history')
  controller.update(true, false)
  expect(ranges()).toHaveLength(0)
  root.textContent = 'replacement'
  controller.update(true, true)
  expect(ranges()).toHaveLength(0)
  root.textContent += '!'
  controller.update(true, true)
  expect(ranges().map(range => range.toString())).toEqual(['!'])
  controller.update(false, true)
  root.textContent += '?'
  controller.update(false, true)
  controller.update(true, true)
  expect(ranges()).toHaveLength(0)
})

it.each(['pre', 'code', 'math', 'button', 'textarea'])('skips %s without fading earlier prose', (tag) => {
  const { root, controller } = attach()
  const protectedNode = document.createElement(tag)
  protectedNode.textContent = '123456'
  root.append('earlier')
  controller.update(true, false)
  root.append(protectedNode)
  controller.update(true, true)
  expect(ranges()).toHaveLength(0)
})

it('skips hidden/formula nodes and handles graphemes spanning nodes', () => {
  const { root, controller } = attach()
  const base = document.createElement('strong')
  base.textContent = 'e'
  root.append(base, document.createTextNode('́'))
  controller.update(true, true)
  expect(ranges().map(range => range.toString())).toEqual(['é'])
  for (const attr of ['hidden', 'aria-hidden', 'class']) {
    const other = attach()
    const child = document.createElement('span')
    child.setAttribute(attr, attr === 'class' ? 'katex' : 'true')
    child.textContent = 'hidden'
    other.root.append(child)
    other.controller.update(true, true)
  }
  expect(ranges()).toHaveLength(1)
})

it('re-derives exclusion when a Text node is moved into an excluded ancestor', async () => {
  const span = document.createElement('span')
  const text = document.createTextNode('a')
  span.append(text)
  const code = document.createElement('code')
  const { root, controller } = attach()
  root.append(span, code)
  controller.update(true, true, 200)
  expect(ranges().map(range => range.toString())).toEqual(['a'])

  // The same Text node re-parents into <code> and grows a character. Eligibility
  // is inherited, so it has to be re-decided for the tree it lives in NOW: the
  // still-fading 'a' is dropped and the new 'b' never enters the fade.
  code.append(text)
  text.data = 'ab'
  await vi.advanceTimersByTimeAsync(0)
  controller.update(true, true, 200)
  expect(ranges()).toHaveLength(0)
})

it('re-derives exclusion when an ancestor stops being hidden', async () => {
  const span = document.createElement('span')
  span.setAttribute('hidden', '')
  const text = document.createTextNode('a')
  span.append(text)
  const { root, controller } = attach()
  root.append(span)
  controller.update(true, true, 200)
  expect(ranges()).toHaveLength(0)
  tick(400)

  // `hidden` is an exclusion attribute: dropping it re-opens the subtree even
  // though the Text node itself only grew by one character.
  span.removeAttribute('hidden')
  text.data = 'ab'
  await vi.advanceTimersByTimeAsync(0)
  controller.update(true, true, 200)
  expect(ranges().map(range => range.toString())).toEqual(['b'])
})

it('re-reads the fade colour when the document appearance changes', async () => {
  const { root, controller } = attach('a')
  root.style.color = 'rgb(20, 40, 60)'
  controller.update(true, true, 200)
  expect(root.style.getPropertyValue(FADE_COLOR)).toBe('rgb(20, 40, 60)')

  // Theme switch while the tail is still live: the document flips its
  // appearance attributes and the root resolves to a different ink.
  root.style.color = 'rgb(230, 240, 250)'
  document.documentElement.classList.add('dsh-appearance-probe')
  await vi.advanceTimersByTimeAsync(0)
  expect(root.style.getPropertyValue(FADE_COLOR)).toBe('rgb(230, 240, 250)')

  document.documentElement.classList.remove('dsh-appearance-probe')
})

it('shares one frame loop and isolates other messages and highlights', () => {
  const one = attach('one')
  const two = attach('two')
  registry.set('search', new Set())
  one.controller.update(true, true)
  two.controller.update(true, true)
  expect(vi.getTimerCount()).toBe(1)
  one.controller.dispose()
  expect(ranges()).toHaveLength(3)
  two.controller.dispose()
  expect([...registry.keys()]).toEqual(['search'])
  expect(vi.getTimerCount()).toBe(0)
})

it('restores pre-existing inline color variables when the fade finishes', () => {
  const { root, controller } = attach('abc')
  root.style.color = 'rgb(20, 40, 60)'
  root.style.setProperty('--dsh-smooth-stream-fade-color', 'red', 'important')
  // jsdom's CSSStyleDeclaration drops priority on custom properties; compare
  // with what this DOM actually stored rather than assuming browser support.
  const originalPriority = root.style.getPropertyPriority('--dsh-smooth-stream-fade-color')
  controller.update(true, true)
  expect(root.style.getPropertyValue('--dsh-smooth-stream-fade-color')).toBe('rgb(20, 40, 60)')
  tick(256)
  expect(root.style.getPropertyValue('--dsh-smooth-stream-fade-color')).toBe('red')
  expect(root.style.getPropertyPriority('--dsh-smooth-stream-fade-color')).toBe(originalPriority)
  expect(root.style.color).toBe('rgb(20, 40, 60)')
})

it('observes descendant commits', async () => {
  const { root, controller } = attach('a')
  controller.update(true, true)
  tick(256)
  root.append('b')
  await act(async () => { await Promise.resolve() })
  expect(ranges().map(range => range.toString())).toEqual(['b'])
})

it('degrades without highlight or color mixing support', () => {
  vi.stubGlobal('Highlight', undefined)
  expect(LogarithmicFadeController.create(document.createElement('div'))).toBeNull()
  vi.stubGlobal('Highlight', class extends Set<Range> {})
  vi.stubGlobal('CSS', { highlights: registry, supports: () => false })
  expect(LogarithmicFadeController.create(document.createElement('div'))).toBeNull()
})

function Probe({ text, enabled = true }: { text: string, enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useLogarithmicFade(ref, enabled, true)
  return <div ref={ref}>{text}</div>
}

it('cleans hook ranges on unmount and preference changes', () => {
  const view = render(<Probe text="abc" />)
  expect(ranges()).toHaveLength(3)
  view.rerender(<Probe text="abc" enabled={false} />)
  expect(ranges()).toHaveLength(0)
  view.unmount()
  expect(registry.size).toBe(0)
})

function assistantProps(blocks: unknown[], status = 'running') {
  return {
    node: { kind: 'assistant-step', location: { kind: 'unresolved' }, data: { status, blocks, turn: 1, step: 1, time: 0 } },
    useTurnData: () => undefined,
    openFile: () => {},
    fileMentions: () => undefined,
    t: (key: string) => key,
    controlScroll: false,
    motionPreference: 'force-smooth',
  } as unknown as Parameters<typeof TypewriterAssistantNodeView>[0]
}

it.each(['text', 'reasoning'])('integrates with real %s and clears on interruption', (kind) => {
  const blocks = [{ kind, text: '测试流式文字效果正在逐字出现。'.repeat(12) }]
  const view = render(<TypewriterAssistantNodeView {...assistantProps(blocks)} />)
  tick(96)
  expect(ranges().length).toBeGreaterThan(0)
  expect(ranges().every(range => !range.startContainer.parentElement?.closest('[aria-live]'))).toBe(true)
  view.rerender(<TypewriterAssistantNodeView {...assistantProps(blocks, 'interrupted')} />)
  expect(ranges()).toHaveLength(0)
})

it('bypasses reduced motion, disabled fade and history', () => {
  const blocks = [{ kind: 'text', text: '历史消息' }]
  const view = render(<TypewriterAssistantNodeView {...assistantProps(blocks, 'settled')} />)
  expect(ranges()).toHaveLength(0)
  expect(registry.size).toBe(0)
  view.rerender(<TypewriterAssistantNodeView {...assistantProps(blocks)} motionPreference="force-reduced" />)
  tick(96)
  expect(ranges()).toHaveLength(0)
  view.rerender(<TypewriterAssistantNodeView {...assistantProps(blocks)} logarithmicFade={false} />)
  tick(96)
  expect(ranges()).toHaveLength(0)
})
