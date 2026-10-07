import { StrictMode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFpsGuard } from '../src/client/useFpsGuard.ts'

const observers: Array<{ connected: boolean }> = []
afterEach(() => {
  cleanup()
  observers.length = 0
  vi.unstubAllGlobals()
})
function Probe({ text }: { text: string }) {
  const guard = useFpsGuard(false)
  return <div ref={guard.ref}>{text}</div>
}
it('keeps one visibility observer through rerenders and StrictMode effect replay', () => {
  vi.stubGlobal('IntersectionObserver', class {
    connected = false
    constructor() { observers.push(this) }
    observe() { this.connected = true }
    disconnect() { this.connected = false }
  })
  const view = render(<StrictMode><Probe text="first" /></StrictMode>)
  expect(observers.filter(observer => observer.connected)).toHaveLength(1)
  const count = observers.length
  view.rerender(<StrictMode><Probe text="updated" /></StrictMode>)
  expect(observers).toHaveLength(count)
  expect(observers.filter(observer => observer.connected)).toHaveLength(1)
  view.unmount()
  expect(observers.every(observer => !observer.connected)).toBe(true)
})
