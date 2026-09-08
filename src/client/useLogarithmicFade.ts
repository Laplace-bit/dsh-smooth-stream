import { useLayoutEffect, useRef, type RefObject } from 'react'
import css from './LogarithmicFade.module.css'

export const FADE_DURATION_MS = 240
export const FADE_TAIL_SIZE = 24
export const FADE_MAX_TAIL_SIZE = 160
export const FADE_MIN_OPACITY = 0
const FADE_STEPS = 32
const PREFIX = 'dsh-smooth-stream-log-fade-'
const COLOR_PROPERTY = '--dsh-smooth-stream-fade-color'
// Lightning CSS scopes highlight identifiers as well as class names.
const highlightName = (index: number): string => css[`${PREFIX}${index}`] ?? `${PREFIX}${index}`
const EXCLUDED = 'pre,code,math,.katex,.katex-display,mjx-container,svg,script,style,textarea,input,button,select,[role="button"],[contenteditable],[hidden],[aria-hidden="true"],[aria-live]'

export function logarithmicOpacity(progress: number): number {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 1
  // Reverse the log easing: preserve translucency early, then settle to ink.
  return FADE_MIN_OPACITY + (1 - FADE_MIN_OPACITY) * (1 - Math.log1p(5 * (1 - p)) / Math.log(6))
}

export function fadeTailSize(speedCps: number): number {
  const speed = Number.isFinite(speedCps) ? Math.max(0, speedCps) : 0
  return Math.min(FADE_MAX_TAIL_SIZE, Math.max(FADE_TAIL_SIZE, Math.ceil(speed * FADE_DURATION_MS / 1000)))
}

interface FadeCharacter {
  start: number
  end: number
  born: number
  range: Range
  bucket: number
}

interface Scheduler {
  highlights: Highlight[]
  clients: Set<LogarithmicFadeController>
  pending: Set<LogarithmicFadeController>
  frame: number
  registry: HighlightRegistry
  window: Window
}

const schedulers = new WeakMap<Document, Scheduler>()
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function schedule(scheduler: Scheduler): void {
  if (scheduler.frame !== 0 || scheduler.pending.size === 0) return
  scheduler.frame = scheduler.window.requestAnimationFrame((now) => {
    scheduler.frame = 0
    for (const client of scheduler.pending) {
      if (!client.paint(now)) scheduler.pending.delete(client)
    }
    schedule(scheduler)
  })
}

function schedulerFor(root: HTMLElement): Scheduler | null {
  const doc = root.ownerDocument
  const win = doc.defaultView
  if (win === null) return null
  // Use the root's realm, including when a renderer lives in another document.
  const realm = win as Window & typeof globalThis
  if (typeof realm.Highlight !== 'function' || !realm.CSS?.highlights
    || !realm.CSS.supports('color', 'color-mix(in srgb, currentColor 15%, transparent)')) return null
  let scheduler = schedulers.get(doc)
  if (scheduler === undefined) {
    const highlights = Array.from({ length: FADE_STEPS }, () => new realm.Highlight())
    for (const [index, highlight] of highlights.entries()) realm.CSS.highlights.set(highlightName(index), highlight)
    scheduler = {
      highlights,
      clients: new Set(),
      pending: new Set(),
      frame: 0,
      registry: realm.CSS.highlights,
      window: win,
    }
    schedulers.set(doc, scheduler)
  }
  return scheduler
}

/** Owns ranges only: React retains ownership of every element and Text node. */
export class LogarithmicFadeController {
  private previous = ''
  private characters: FadeCharacter[] = []
  private colors = new Map<HTMLElement, { value: string, priority: string }>()
  private enabled = false
  private active = false
  private speedCps = 100
  private pausedAt: number | null = null
  private disposed = false
  private readonly observer: MutationObserver

  private constructor(private readonly root: HTMLElement, private readonly scheduler: Scheduler) {
    scheduler.clients.add(this)
    const win = root.ownerDocument.defaultView as Window & typeof globalThis
    this.observer = new win.MutationObserver(() => { this.reconcile() })
    this.observer.observe(root, { subtree: true, childList: true, characterData: true })
  }

  static create(root: HTMLElement): LogarithmicFadeController | null {
    const scheduler = schedulerFor(root)
    return scheduler === null ? null : new LogarithmicFadeController(root, scheduler)
  }

  update(enabled: boolean, active: boolean, speedCps = 100, paused = false): void {
    const now = this.scheduler.window.performance.now()
    if (paused && this.pausedAt === null) this.pausedAt = now
    if (!paused && this.pausedAt !== null) {
      const pauseDuration = now - this.pausedAt
      for (const character of this.characters) character.born += pauseDuration
      this.pausedAt = null
    }
    this.enabled = enabled
    this.active = active
    this.speedCps = speedCps
    this.reconcile()
  }

  private clearRanges(): void {
    for (const character of this.characters) {
      this.scheduler.highlights[character.bucket]?.delete(character.range)
    }
    this.characters = []
    this.restoreColors()
  }

  private restoreColors(): void {
    for (const [element, original] of this.colors) {
      if (original.value === '') element.style.removeProperty(COLOR_PROPERTY)
      else element.style.setProperty(COLOR_PROPERTY, original.value, original.priority)
    }
    this.colors.clear()
  }

  private preserveColor(element: HTMLElement): void {
    if (this.colors.has(element)) return
    const color = this.scheduler.window.getComputedStyle(element).color
    this.colors.set(element, {
      value: element.style.getPropertyValue(COLOR_PROPERTY),
      priority: element.style.getPropertyPriority(COLOR_PROPERTY),
    })
    // An explicit source color prevents highlight inheritance from multiplying
    // alpha through nested Markdown elements (root → paragraph → strong).
    element.style.setProperty(COLOR_PROPERTY, color)
  }

  private reconcile(): void {
    if (this.disposed) return
    const text = this.root.textContent ?? ''
    const previous = this.previous
    this.previous = text
    const old = this.characters
    this.clearRanges()
    if (!this.enabled) {
      this.root.classList.remove(css.scope!)
      this.scheduler.pending.delete(this)
      this.stopIfIdle()
      return
    }
    this.root.classList.add(css.scope!)
    const now = this.pausedAt ?? this.scheduler.window.performance.now()
    // A parser rewrite must not replay already readable content. Retain only
    // the unchanged prefix; future appends resume the effect normally.
    let prefix = 0
    while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix += 1
    const appended = text.startsWith(previous)
    const nodes: { node: Text, start: number, end: number, eligible: boolean }[] = []
    const walker = this.root.ownerDocument.createTreeWalker(this.root, NodeFilter.SHOW_TEXT)
    let offset = 0
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const end = offset + (node.textContent?.length ?? 0)
      nodes.push({ node: node as Text, start: offset, end, eligible: node.parentElement?.closest(EXCLUDED) === null })
      offset = end
    }
    // containing() walks backwards by grapheme without segmenting the entire
    // answer into an array. Offsets still refer to the original DOM text.
    const segments = segmenter.segment(text)
    // Keep existing characters alive when the engine resets its speed during
    // completion. A shrinking window must not abruptly darken the old tail.
    const tailSize = fadeTailSize(this.speedCps)
    const oldestLiveStart = old.reduce((start, character) => (
      now - character.born < FADE_DURATION_MS && character.end <= prefix
        ? Math.min(start, character.start)
        : start
    ), Infinity)
    let end = text.length
    for (let count = 0; count < FADE_MAX_TAIL_SIZE && end > 0 && (count < tailSize || end > oldestLiveStart); count += 1) {
      const segment = segments.containing(end - 1)
      if (segment === undefined) break
      const start = segment.index
      const parts = nodes.filter(node => node.end > start && node.start < end)
      const retained = old.find(character => character.start === start && character.end === end && end <= prefix)
      const born = retained?.born ?? (this.active && appended && start >= previous.length ? now : null)
      if (born !== null && now - born < FADE_DURATION_MS && segment.segment.trim() !== ''
        && parts.length > 0 && parts.every(part => part.eligible)) {
        const first = parts[0]!
        const last = parts[parts.length - 1]!
        const range = this.root.ownerDocument.createRange()
        range.setStart(first.node, start - first.start)
        range.setEnd(last.node, end - last.start)
        for (const part of parts) this.preserveColor(part.node.parentElement!)
        this.characters.push({ start, end, born, range, bucket: -1 })
      }
      end = start
    }
    if (this.paint(now)) {
      if (this.pausedAt === null) {
        this.scheduler.pending.add(this)
        schedule(this.scheduler)
      } else {
        this.scheduler.pending.delete(this)
        this.stopIfIdle()
      }
    } else {
      this.scheduler.pending.delete(this)
      this.stopIfIdle()
    }
  }

  paint(now: number): boolean {
    this.characters = this.characters.filter((character) => {
      const progress = (now - character.born) / FADE_DURATION_MS
      if (progress >= 1 || !this.root.isConnected || !this.root.contains(character.range.startContainer)) {
        this.scheduler.highlights[character.bucket]?.delete(character.range)
        return false
      }
      const bucket = Math.min(FADE_STEPS - 1, Math.round((logarithmicOpacity(progress) - FADE_MIN_OPACITY) / (1 - FADE_MIN_OPACITY) * (FADE_STEPS - 1)))
      if (bucket !== character.bucket) {
        this.scheduler.highlights[character.bucket]?.delete(character.range)
        this.scheduler.highlights[bucket]!.add(character.range)
        character.bucket = bucket
      }
      return true
    })
    if (this.characters.length === 0) this.restoreColors()
    return this.characters.length > 0
  }

  private stopIfIdle(): void {
    if (this.scheduler.pending.size !== 0) return
    this.scheduler.window.cancelAnimationFrame(this.scheduler.frame)
    this.scheduler.frame = 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer.disconnect()
    this.clearRanges()
    this.root.classList.remove(css.scope!)
    this.scheduler.pending.delete(this)
    this.scheduler.clients.delete(this)
    this.stopIfIdle()
    if (this.scheduler.clients.size === 0) {
      for (const [index, highlight] of this.scheduler.highlights.entries()) {
        const name = highlightName(index)
        if (this.scheduler.registry.get(name) === highlight) this.scheduler.registry.delete(name)
      }
      schedulers.delete(this.root.ownerDocument)
    }
  }
}

/** active admits new characters; enabled=false also cancels completion linger. */
export function useLogarithmicFade(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  active: boolean,
  speedCpsRef?: { current: number },
  paused = false,
): void {
  const controller = useRef<LogarithmicFadeController | null>(null)
  const committed = useRef(false)
  useLayoutEffect(() => {
    return () => {
      controller.current?.dispose()
      controller.current = null
    }
  }, [rootRef])
  // Deliberately commit-driven, including Markdown updates with unchanged source.
  useLayoutEffect(() => {
    const root = rootRef.current
    // Settled history allocates neither observers nor highlight buckets.
    if (controller.current === null && root !== null && enabled && active) {
      controller.current = LogarithmicFadeController.create(root)
      // Enabling midway through a message must not replay readable text.
      if (committed.current) controller.current?.update(false, false)
    }
    controller.current?.update(enabled, active, speedCpsRef?.current, paused)
    committed.current = true
  })
}
