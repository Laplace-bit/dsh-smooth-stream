// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { restoreRunway, shiftSurfacesOf } from '../src/client/teleprompterGlide.ts'

/**
 * Residue left by older bundles is an inline margin on a row the current
 * engine no longer owns. The sweep has to be unconditional: the old writer
 * parked its 72px completion runway on whatever row happened to be last at the
 * time, which after a reload or a new step is a row in the middle of the
 * transcript — a silently blank band the user reads as a layout bug.
 */
function buildPort(): { port: HTMLElement; group1: HTMLElement; response: HTMLElement; status: HTMLElement } {
  const port = document.createElement('div')
  port.setAttribute('data-conversation-scroll', '')
  const flow = document.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  port.appendChild(flow)

  // Step 15 reasoning / group 1: the row an older bundle left its runway on.
  const group1 = document.createElement('div')
  group1.setAttribute('data-chat-anchor-key', 'group:process:step-14')
  group1.style.marginBottom = '72px'
  flow.appendChild(group1)

  // Step 15 response: the real tail, which must also come out clean.
  const response = document.createElement('div')
  response.setAttribute('data-chat-anchor-key', 'step-15')
  flow.appendChild(response)

  const status = document.createElement('div')
  status.setAttribute('role', 'status')
  status.style.marginTop = '72px'
  flow.appendChild(status)

  return { port, group1, response, status }
}

describe('runway residue cleanup', () => {
  it('sweeps inline runway margins off every surface it no longer owns', () => {
    const { port, group1, response, status } = buildPort()
    expect(shiftSurfacesOf(port)).toEqual([group1, response])

    restoreRunway(port)

    expect(group1.style.marginBottom).toBe('')
    expect(response.style.marginBottom).toBe('')
    expect(status.style.marginTop).toBe('')
  })

  it('leaves a margin that was never a runway alone', () => {
    const { port, group1 } = buildPort()
    // A host-authored layout margin is not a px runway value.
    group1.style.marginBottom = '2rem'

    restoreRunway(port)

    expect(group1.style.marginBottom).toBe('2rem')
  })
})
