/**
 * The fold's summary row is a plugin-injected flow child without an anchor
 * key. In per-row follow mode the lag transform is distributed over outermost
 * anchor surfaces; if the row were excluded it would stay put while its
 * neighbours glide and visibly detach during scrolling. Locks the inclusion
 * contract of the surface selection.
 */

import { describe, expect, it } from 'vitest'
import { shiftSurfacesOf } from '../src/client/teleprompterGlide.ts'

describe('follow lag surfaces include fold summary rows', () => {
  it('selects anchored rows and plugin summary rows together, in DOM order', () => {
    const port = document.createElement('div')
    const flow = document.createElement('div')
    port.appendChild(flow)

    const rowA = document.createElement('div')
    rowA.setAttribute('data-chat-anchor-key', 'row-a')
    flow.appendChild(rowA)

    // Nested anchored rows ride their parent: never separate surfaces.
    const nested = document.createElement('div')
    nested.setAttribute('data-chat-anchor-key', 'nested')
    rowA.appendChild(nested)

    const summary = document.createElement('button')
    summary.className = 'dshss-processed'
    flow.appendChild(summary)

    const rowB = document.createElement('div')
    rowB.setAttribute('data-chat-anchor-key', 'row-b')
    flow.appendChild(rowB)

    // An unrelated transcript wrapper elsewhere must not leak in.
    const transcriptElsewhere = document.createElement('div')
    transcriptElsewhere.setAttribute('data-chat-transcript', '')

    const direct = shiftSurfacesOf(port)
    expect(direct).toEqual([rowA, summary, rowB])
    expect(direct).not.toContain(nested)
  })

  it('collapses to the single transcript surface when one exists', () => {
    const port = document.createElement('div')
    const transcript = document.createElement('div')
    transcript.setAttribute('data-chat-transcript', '')
    port.appendChild(transcript)
    const rowA = document.createElement('div')
    rowA.setAttribute('data-chat-anchor-key', 'row-a')
    port.appendChild(rowA)
    const summary = document.createElement('button')
    summary.className = 'dshss-processed'
    port.appendChild(summary)

    expect(shiftSurfacesOf(port)).toEqual([transcript])
  })
})
