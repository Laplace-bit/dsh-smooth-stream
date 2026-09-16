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

/** One text node of the fade root with its span in the concatenated source text. */
interface TextNodeEntry {
  node: Text
  start: number
  end: number
  eligible: boolean
}

interface PreservedColor {
  value: string
  priority: string
  /** Reconcile pass that last wanted this element, so stale entries can be pruned. */
  generation: number
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

/**
 * Hot-path counters for the streaming benchmark. Increments only — this is the
 * evidence that the per-frame pass count collapsed, not a control input.
 */
export const fadeHotPathStats = {
  /** Observer batches that reached reconcile(). */
  reconcileCalls: 0,
  /** Reconciles that did real work (the rest are dirty-check no-ops). */
  reconcilePasses: 0,
  /** Full text-node table rebuilds (structural DOM change). */
  nodeScans: 0,
  /** Forced style resolutions for newly faded elements. */
  styleReads: 0,
}

export function resetFadeHotPathStats(): void {
  fadeHotPathStats.reconcileCalls = 0
  fadeHotPathStats.reconcilePasses = 0
  fadeHotPathStats.nodeScans = 0
  fadeHotPathStats.styleReads = 0
}

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

/**
 * Owns ranges only: React retains ownership of every element and Text node.
 *
 * The controller used to re-derive its whole view of the subtree (textContent,
 * prefix walk, full TreeWalker, an O(tail x #nodes) filter) on *every* commit
 * AND on every observer batch for that same commit. It now keeps an
 * incremental text-node table, reconciles at most once per observed DOM
 * change, and preserves the per-element colour memo across passes.
 */
export class LogarithmicFadeController {
  private previous = ''
  private characters: FadeCharacter[] = []
  private colors = new Map<HTMLElement, PreservedColor>()
  private enabled = false
  private active = false
  private speedCps = 100
  private pausedAt: number | null = null
  private disposed = false
  private readonly observer: MutationObserver
  /** Text nodes of the root with their source offsets; survives data-only edits. */
  private nodes: TextNodeEntry[] = []
  /** Ineligible nodes in nodes[0..index): a span is fadeable when its bounds match. */
  private ineligiblePrefix: number[] = [0]
  /** `closest(EXCLUDED)` per node identity, so a rescan never re-runs the selector. */
  private readonly eligibleCache = new WeakMap<Text, boolean>()
  /** Bumped by every observed mutation; reconcile() no-ops while it does not move. */
  private domRevision = 0
  /** Bumped only by structural (childList) mutations; the node table is rebuilt then. */
  private structureRevision = 0
  private scannedStructureRevision = -1
  private reconciledRevision = -1
  private reconciledEnabled = false
  private reconciledActive = false
  private reconciledPaused = false
  private reconciledTailSize = 0
  private colorGeneration = 0

  private constructor(private readonly root: HTMLElement, private readonly scheduler: Scheduler) {
    scheduler.clients.add(this)
    const win = root.ownerDocument.defaultView as Window & typeof globalThis
    // The observer is the single invalidation source. It does not watch
    // attributes, and every write below is an attribute, a Range or a highlight
    // bucket, so this can never re-enter itself.
    this.observer = new win.MutationObserver((records) => { this.onDomMutation(records) })
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

  /** Invalidate and reconcile from one observer batch (one batch per commit). */
  private onDomMutation(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type !== 'childList') continue
      this.structureRevision += 1
      break
    }
    this.domRevision += 1
    this.reconcile()
  }

  /** Rebuild the text-node table after a structural change. */
  private scanNodes(): void {
    const nodes: TextNodeEntry[] = []
    const walker = this.root.ownerDocument.createTreeWalker(this.root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node as Text
      let eligible = this.eligibleCache.get(text)
      if (eligible === undefined) {
        eligible = text.parentElement?.closest(EXCLUDED) === null
        this.eligibleCache.set(text, eligible)
      }
      nodes.push({ node: text, start: 0, end: 0, eligible })
    }
    this.nodes = nodes
    this.scannedStructureRevision = this.structureRevision
    fadeHotPathStats.nodeScans += 1
  }

  /**
   * Re-derive the source text, the per-node spans and the eligibility prefix
   * sums from the cached table. No DOM read, no selector match, no allocation
   * beyond the string itself.
   */
  private readText(): string {
    if (this.scannedStructureRevision !== this.structureRevision) this.scanNodes()
    // The commit-driven pass runs before the observer microtask for the same
    // commit, so a replaced text node can still be in the table. A removed
    // node keeps its data, which would silently hand a detached node to the
    // Range and colour code, so re-scan on the first eviction.
    for (const entry of this.nodes) {
      if (entry.node.parentNode !== null) continue
      this.scanNodes()
      break
    }
    const nodes = this.nodes
    const prefix = this.ineligiblePrefix
    if (prefix.length < nodes.length + 1) prefix.length = nodes.length + 1
    prefix[0] = 0
    let text = ''
    let offset = 0
    for (let index = 0; index < nodes.length; index += 1) {
      const entry = nodes[index]!
      const data = entry.node.data
      entry.start = offset
      offset += data.length
      entry.end = offset
      text += data
      prefix[index + 1] = prefix[index]! + (entry.eligible ? 0 : 1)
    }
    prefix.length = nodes.length + 1
    this.ineligiblePrefix = prefix
    return text
  }

  /** First cached node whose span ends after `offset` (binary search). */
  private firstNodeEndingAfter(offset: number): number {
    const nodes = this.nodes
    let low = 0
    let high = nodes.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (nodes[mid]!.end > offset) high = mid
      else low = mid + 1
    }
    return low
  }

  /** Last cached node whose span starts before `offset` (binary search). */
  private lastNodeStartingBefore(offset: number): number {
    const nodes = this.nodes
    let low = -1
    let high = nodes.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (nodes[mid]!.start < offset) low = mid
      else high = mid - 1
    }
    return low
  }

  private clearRanges(): void {
    for (const character of this.characters) {
      this.scheduler.highlights[character.bucket]?.delete(character.range)
    }
    this.characters = []
  }

  private restoreColor(element: HTMLElement, preserved: PreservedColor): void {
    if (preserved.value === '') element.style.removeProperty(COLOR_PROPERTY)
    else element.style.setProperty(COLOR_PROPERTY, preserved.value, preserved.priority)
  }

  private restoreColors(): void {
    for (const [element, preserved] of this.colors) this.restoreColor(element, preserved)
    this.colors.clear()
  }

  private preserveColor(element: HTMLElement): void {
    const preserved = this.colors.get(element)
    if (preserved !== undefined) {
      preserved.generation = this.colorGeneration
      return
    }
    fadeHotPathStats.styleReads += 1
    const color = this.scheduler.window.getComputedStyle(element).color
    this.colors.set(element, {
      value: element.style.getPropertyValue(COLOR_PROPERTY),
      priority: element.style.getPropertyPriority(COLOR_PROPERTY),
      generation: this.colorGeneration,
    })
    // An explicit source color prevents highlight inheritance from multiplying
    // alpha through nested Markdown elements (root → paragraph → strong).
    element.style.setProperty(COLOR_PROPERTY, color)
  }

  /** Drop the preserved colour of elements that left the fade tail this pass. */
  private pruneColors(): void {
    for (const [element, preserved] of this.colors) {
      if (preserved.generation === this.colorGeneration) continue
      this.colors.delete(element)
      this.restoreColor(element, preserved)
    }
  }

  /**
   * Refresh the fade ranges. Two triggers used to run this 2-3x per frame with
   * no dirty check: the commit-driven `update()` and the observer batch for the
   * very same DOM write. Both converge here, and the pass is skipped unless the
   * DOM revision, the gate, the fade window or the pause state actually moved.
   */
  private reconcile(): void {
    if (this.disposed) return
    fadeHotPathStats.reconcileCalls += 1
    const tailSize = fadeTailSize(this.speedCps)
    const paused = this.pausedAt !== null
    const domChanged = this.domRevision !== this.reconciledRevision
    // The window only matters while characters are still fading: an idle
    // controller has nothing to re-cut, and the next append reconciles anyway.
    const paramsChanged = this.enabled !== this.reconciledEnabled
      || this.active !== this.reconciledActive
      || paused !== this.reconciledPaused
      || (tailSize !== this.reconciledTailSize && this.characters.length > 0)
    if (!domChanged && !paramsChanged) return
    fadeHotPathStats.reconcilePasses += 1
    this.reconciledRevision = this.domRevision
    this.reconciledEnabled = this.enabled
    this.reconciledActive = this.active
    this.reconciledPaused = paused
    this.reconciledTailSize = tailSize

    const text = this.readText()
    const previous = this.previous
    this.previous = text
    const old = this.characters
    this.clearRanges()
    if (!this.enabled) {
      this.root.classList.remove(css.scope!)
      this.restoreColors()
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
    const nodes = this.nodes
    const ineligible = this.ineligiblePrefix
    // containing() walks backwards by grapheme without segmenting the entire
    // answer into an array. Offsets still refer to the original DOM text.
    const segments = segmenter.segment(text)
    // Keep existing characters alive when the engine resets its speed during
    // completion. A shrinking window must not abruptly darken the old tail.
    const oldestLiveStart = old.reduce((start, character) => (
      now - character.born < FADE_DURATION_MS && character.end <= prefix
        ? Math.min(start, character.start)
        : start
    ), Infinity)
    const retainedBySpan = new Map<string, FadeCharacter>()
    for (const character of old) retainedBySpan.set(`${String(character.start)}:${String(character.end)}`, character)
    this.colorGeneration += 1
    let end = text.length
    for (let count = 0; count < FADE_MAX_TAIL_SIZE && end > 0 && (count < tailSize || end > oldestLiveStart); count += 1) {
      const segment = segments.containing(end - 1)
      if (segment === undefined) break
      const start = segment.index
      const retained = end <= prefix
        ? retainedBySpan.get(`${String(start)}:${String(end)}`)
        : undefined
      const born = retained?.born ?? (this.active && appended && start >= previous.length ? now : null)
      if (born !== null && now - born < FADE_DURATION_MS && segment.segment.trim() !== '') {
        // One binary-searched node span replaces the former O(tail x #nodes)
        // filter; the prefix sums answer "is every part eligible" in O(1).
        const first = this.firstNodeEndingAfter(start)
        const last = this.lastNodeStartingBefore(end)
        if (last >= first && first < nodes.length && nodes[last]!.end > start
          && ineligible[last + 1] === ineligible[first]) {
          const firstPart = nodes[first]!
          const lastPart = nodes[last]!
          const range = this.root.ownerDocument.createRange()
          range.setStart(firstPart.node, start - firstPart.start)
          range.setEnd(lastPart.node, end - lastPart.start)
          for (let index = first; index <= last; index += 1) {
            const element = nodes[index]!.node.parentElement
            if (element !== null) this.preserveColor(element)
          }
          this.characters.push({ start, end, born, range, bucket: -1 })
        }
      }
      end = start
    }
    this.pruneColors()
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
    this.restoreColors()
    this.nodes = []
    this.scannedStructureRevision = -1
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
  // Deliberately commit-driven, including Markdown updates with unchanged
  // source: React may swap text nodes for identical text, and the controller's
  // observer cannot report that before the commit's layout effects. The
  // controller itself drops the redundant half of those passes now.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!enabled) {
      // "Fade off" must cost nothing: no observer, no reconcile, no rAF seat,
      // no leftover scope class or colour property.
      if (controller.current !== null) {
        controller.current.dispose()
        controller.current = null
      }
      committed.current = true
      return
    }
    // Settled history allocates neither observers nor highlight buckets.
    if (controller.current === null && root !== null && active) {
      controller.current = LogarithmicFadeController.create(root)
      // Enabling midway through a message must not replay readable text.
      if (committed.current) controller.current?.update(false, false)
    }
    controller.current?.update(enabled, active, speedCpsRef?.current, paused)
    committed.current = true
  })
}
