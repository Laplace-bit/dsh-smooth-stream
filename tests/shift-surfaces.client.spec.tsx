// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { shiftSurfacesOf } from '../src/client/teleprompterGlide.ts'

/**
 * Build a conversation port whose flow column mixes harness Chat rows with a
 * row injected by another plugin, which is the topology meow-memory produces.
 * @param injected - whether to insert the foreign sibling.
 * @returns the scroll port element.
 */
function buildPort(injected: boolean): HTMLElement {
  const port = document.createElement('div')
  port.setAttribute('data-conversation-scroll', '')
  const flow = document.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  port.appendChild(flow)

  const first = document.createElement('div')
  first.setAttribute('data-chat-anchor-key', '1:user')
  flow.appendChild(first)

  if (injected) {
    const bar = document.createElement('div')
    bar.setAttribute('data-meow-memory-anchor', '2:input')
    flow.appendChild(bar)
  }

  const second = document.createElement('div')
  second.setAttribute('data-chat-anchor-key', '2:assistant')
  // A nested tool row must keep riding its parent rather than shifting twice.
  const nested = document.createElement('div')
  nested.setAttribute('data-chat-anchor-key', '2:tool')
  second.appendChild(nested)
  flow.appendChild(second)

  const status = document.createElement('div')
  status.setAttribute('role', 'status')
  flow.appendChild(status)

  return port
}

describe('shiftSurfacesOf', () => {
  it('shifts a foreign flow sibling with the conversation so it cannot be painted over', () => {
    const surfaces = shiftSurfacesOf(buildPort(true))
    expect(surfaces.map(el => el.getAttribute('data-chat-anchor-key')
      ?? el.getAttribute('data-meow-memory-anchor'))).toEqual([
      '1:user',
      '2:input',
      '2:assistant',
    ])
  })

  it('excludes the turn status and nested tool rows', () => {
    const surfaces = shiftSurfacesOf(buildPort(false))
    expect(surfaces.some(el => el.getAttribute('role') === 'status')).toBe(false)
    expect(surfaces.map(el => el.getAttribute('data-chat-anchor-key'))).toEqual([
      '1:user',
      '2:assistant',
    ])
  })

  it('keeps the single transcript surface when the conversation exposes one', () => {
    const port = document.createElement('div')
    const transcript = document.createElement('div')
    transcript.setAttribute('data-chat-transcript', '')
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow', '')
    transcript.appendChild(flow)
    port.appendChild(transcript)
    expect(shiftSurfacesOf(port)).toEqual([transcript])
  })
})
