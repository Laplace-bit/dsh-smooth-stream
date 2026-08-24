/**
 * Progressive text reveal for opaque Agent renderers.
 *
 * Slot renderers own arbitrary React trees, so the generic integration cannot
 * clone or classify their business components. This hook leaves that tree and
 * all of its event handlers in place, and only paces visible Text node data
 * while the row belongs to the live Agent turn. No clip, mask, overlay, or
 * duplicate accessibility tree is introduced.
 */

import { useLayoutEffect, type RefObject } from 'react'
import { computeAdaptiveQueueStep } from './useSmoothStreamContent.ts'
import { debugRuntime } from './debugRuntime.ts'

interface TextRevealRecord {
  chars: readonly string[]
  full: string
  shown: number
}

/** Last presented text per root, retained across follow lifecycle flips. */
const ledgerByRoot = new WeakMap<HTMLElement, Map<Text, TextRevealRecord>>()

const SKIP_TEXT_SELECTOR = [
  '[aria-hidden="true"]',
  '[aria-live]',
  '[contenteditable="true"]',
  'script',
  'style',
  'textarea',
].join(',')

function revealable(node: Text, root: HTMLElement): boolean {
  if (node.data.trim() === '') return false
  const parent = node.parentElement
  return parent !== null
    && root.contains(parent)
    && parent.closest(SKIP_TEXT_SELECTOR) === null
}

function commonPrefix(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

/**
 * Pace text inside a renderer whose React component is intentionally opaque.
 * Initial content is revealed only for a genuinely new row; later mutations
 * stay paced until `enabled` becomes false, at which point the full renderer
 * content is restored synchronously before paint.
 */
export function useProgressiveDomText(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  revealInitial: boolean,
  speedCpsRef: { current: number },
  onSettled?: (() => void) | undefined,
): void {
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null || typeof document === 'undefined') return

    let records = ledgerByRoot.get(root)
    if (!enabled && records === undefined) return
    if (records === undefined) {
      records = new Map<Text, TextRevealRecord>()
      ledgerByRoot.set(root, records)
    }

    const forEachText = (from: Node, callback: (text: Text) => void): void => {
      if (from.nodeType === Node.TEXT_NODE) {
        callback(from as Text)
        return
      }
      const walker = document.createTreeWalker(from, NodeFilter.SHOW_TEXT)
      let current = walker.nextNode()
      while (current !== null) {
        callback(current as Text)
        current = walker.nextNode()
      }
    }

    const settle = (text: Text): void => {
      if (!revealable(text, root)) return
      const chars = [...text.data]
      records.set(text, { chars, full: text.data, shown: chars.length })
    }

    const snapshotVisible = (): void => {
      const current = new Set<Text>()
      forEachText(root, (text) => {
        if (!revealable(text, root)) return
        current.add(text)
        settle(text)
      })
      for (const text of records.keys()) {
        if (!current.has(text)) records.delete(text)
      }
    }

    if (!enabled) {
      snapshotVisible()
      const observer = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(snapshotVisible)
      observer?.observe(root, { childList: true, characterData: true, subtree: true })
      return () => {
        observer?.disconnect()
      }
    }

    const pending = new Set<Text>()
    const internalWrites = new WeakMap<Text, string>()
    let rafId = 0
    let lastFrame: number | null = null
    let debt = 0
    let stopped = false
    let announcedSettled = false
    const streamId = `dom-${Math.random().toString(36).slice(2)}`

    const announceSettled = (): void => {
      lastFrame = null
      debt = 0
      speedCpsRef.current = 35
      debugRuntime.reportStream(streamId, null)
      if (announcedSettled) return
      announcedSettled = true
      onSettled?.()
    }

    const write = (node: Text, value: string): void => {
      if (node.data === value) return
      internalWrites.set(node, value)
      node.data = value
    }

    const enqueue = (node: Text, full: string, preserve: TextRevealRecord | undefined): void => {
      if (!revealable(node, root)) return
      const chars = [...full]
      const preserved = preserve === undefined
        ? 0
        : Math.min(preserve.shown, commonPrefix(preserve.chars, chars))
      const record = { chars, full, shown: preserved }
      records.set(node, record)
      if (preserved < chars.length) {
        pending.add(node)
        announcedSettled = false
      } else {
        pending.delete(node)
      }
      write(node, chars.slice(0, preserved).join(''))
    }

    const visit = (from: Node, reveal: boolean): void => {
      forEachText(from, (text) => {
        if (!revealable(text, root)) return
        if (reveal) {
          enqueue(text, text.data, records.get(text))
          return
        }
        settle(text)
      })
    }

    const forget = (from: Node): void => {
      forEachText(from, (text) => {
        if (root.contains(text)) return
        records.delete(text)
        pending.delete(text)
      })
    }

    const scheduleFrame = (): void => {
      if (stopped || pending.size === 0 || rafId !== 0) return
      rafId = requestAnimationFrame(frame)
    }

    const frame = (now: number): void => {
      rafId = 0
      if (stopped) return
      if (pending.size === 0) {
        announceSettled()
        return
      }
      announcedSettled = false
      if (lastFrame === null) {
        lastFrame = now
        scheduleFrame()
        return
      }
      const elapsed = Math.max(0, now - lastFrame)
      lastFrame = now
      let backlog = 0
      for (const node of pending) {
        const record = records.get(node)
        if (record !== undefined) backlog += record.chars.length - record.shown
      }
      const step = computeAdaptiveQueueStep(backlog, elapsed, debt, 1, debugRuntime.activeTuning())
      debt = step.debt
      speedCpsRef.current = step.speedCps
      let remaining = step.revealChars
      for (const node of [...pending]) {
        if (remaining <= 0) break
        const record = records.get(node)
        if (record === undefined || !node.isConnected) {
          pending.delete(node)
          records.delete(node)
          continue
        }
        const amount = Math.min(remaining, record.chars.length - record.shown)
        const shown = record.shown + amount
        const next = { ...record, shown }
        records.set(node, next)
        write(node, next.chars.slice(0, shown).join(''))
        remaining -= amount
        if (shown >= next.chars.length) pending.delete(node)
      }
      let targetChars = 0
      let displayedChars = 0
      let nextBacklog = 0
      for (const [node, record] of records) {
        if (!node.isConnected) {
          records.delete(node)
          pending.delete(node)
          continue
        }
        targetChars += record.chars.length
        displayedChars += record.shown
        if (pending.has(node)) nextBacklog += record.chars.length - record.shown
      }
      debugRuntime.reportStream(streamId, {
        backlog: nextBacklog,
        speedCps: step.speedCps,
        targetChars,
        displayedChars,
        active: pending.size > 0,
      })
      if (pending.size === 0) announceSettled()
      else scheduleFrame()
    }

    visit(root, revealInitial)

    const observer = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === 'characterData') {
              const node = mutation.target as Text
              const expected = internalWrites.get(node)
              if (expected === node.data) {
                internalWrites.delete(node)
                continue
              }
              enqueue(node, node.data, records.get(node))
              continue
            }
            for (const removed of mutation.removedNodes) forget(removed)
            for (const added of mutation.addedNodes) visit(added, true)
          }
          if (pending.size === 0) announceSettled()
          else scheduleFrame()
        })
    observer?.observe(root, { childList: true, characterData: true, subtree: true })
    if (pending.size === 0) announceSettled()
    else scheduleFrame()

    return () => {
      stopped = true
      cancelAnimationFrame(rafId)
      observer?.disconnect()
      for (const [node, record] of records) {
        const controlled = record.chars.slice(0, record.shown).join('')
        // React may have committed a terminal replacement in the same mutation
        // phase that disables this hook. Never overwrite that newer renderer
        // value with the previous controlled source during layout cleanup.
        if (node.isConnected && node.data === controlled) {
          write(node, record.full)
        }
      }
      pending.clear()
      speedCpsRef.current = 35
      debugRuntime.reportStream(streamId, null)
    }
  }, [enabled, onSettled, revealInitial, rootRef, speedCpsRef])
}
