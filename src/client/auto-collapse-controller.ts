/**
 * Auto-collapse coordinator: folds the work process of finished turns behind
 * one summary row so only the model's final answer stays visible.
 *
 * The Harness ChatView lays a conversation out as a flat list of flow items
 * (`[data-chat-flow] > [data-chat-flow-kind=…]`). This controller watches that
 * list, splits it into turn segments at `user`/`steering` boundaries closed by
 * `turn-tail`, and — once a segment has settled — hides its thinking rows,
 * tool/command/context seats and intermediate replies, leaving one clickable
 * `已处理 {时长}` row plus the final answer. Clicking the row expands the full
 * process again; the choice survives later renders because it lives in the
 * controller, not the DOM.
 *
 * Adapted from the standalone `dsh-auto-collapse` plugin (level-1 folding
 * only): no second-level chips, no merged thinking rows, no status-text
 * rewrite, no transition animation — the collapse decision itself stays
 * instantaneous and reversible.
 *
 * React coexistence follows the upstream design: injected rows are plain
 * siblings/prepend children the vdom diff never claims, native rows are only
 * ever touched through an inline-`display` ledger that records the precise
 * original value and restores it on stop, session switch, or foreign takeover
 * (a written-value comparison plus an ownership sentinel catches another
 * script rewriting styles behind our back). A MutationObserver batches real
 * structure changes into rAF passes; a low-frequency self-rearming audit pass
 * reconciles unobservable style writes; a setTimeout fallback keeps passes
 * flowing when background tabs suspend rAF.
 */

const STYLE_ID = 'dshss-auto-collapse-style'
/** Class of the injected per-turn summary row; the follow engine's generalized
 * surface walk picks it up as an ordinary foreign flow sibling. */
const PROCESSED_CLASS = 'dshss-processed'
/** Inline custom property marking elements whose display this plugin owns. */
const DISPLAY_OWNED_PROP = '--dshss-display-owned'
/** Unobservable external style writes are reconciled by this audit cadence. */
const AUDIT_TICK_MS = 1000
/** Background-tab fallback that flushes a scheduled pass when rAF is frozen. */
const PASS_FALLBACK_MS = 60
/**
 * Fold motion, deliberately minimal: layout changes land synchronously (the
 * display toggle happens in the same tick as the decision) and nothing
 * animates geometry at all — the earlier container-height squeeze was removed
 * because real sessions showed residual drift after the pin released (other
 * layout participants keep settling around the fold). What remains is one
 * paint-only flourish: the summary row fades its opacity in. A fold is
 * therefore a single reflow followed by a fade — the most stable shape
 * possible.
 */
const FOLD_ROW_FADE_MS = 160
const FOLD_EASE_OUT = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

/** User-visible copy; DSH web ships Chinese-first, other locales get English. */
interface FoldCopy {
  processedLabel: string
  expandTitle: string
  collapseTitle: string
  formatDuration: (ms: number) => string
}

const ZH_COPY: FoldCopy = {
  processedLabel: '已处理',
  expandTitle: '展开工作过程',
  collapseTitle: '收起工作过程',
  formatDuration: formatZhDuration,
}

const EN_COPY: FoldCopy = {
  processedLabel: 'Processed',
  expandTitle: 'Show the work process',
  collapseTitle: 'Hide the work process',
  formatDuration: formatEnDuration,
}

function resolveFoldCopy(): FoldCopy {
  let lang = ''
  try {
    lang = document.documentElement.lang || navigator.language || ''
  } catch {
    lang = ''
  }
  return lang.toLowerCase().startsWith('zh') ? ZH_COPY : EN_COPY
}

const FOLD_CSS = `
.${PROCESSED_CLASS} {
  box-sizing: border-box;
  display: inline-flex;
  align-self: flex-start;
  width: fit-content;
  max-width: 100%;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  border: none;
  background: none;
  font: 400 14px/24px system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
  cursor: pointer;
  user-select: none;
  border-radius: 4px;
  transition: color 0.15s ease;
}
.${PROCESSED_CLASS}:hover {
  color: var(--dsw-alias-label-primary, inherit);
  background: transparent;
}
.${PROCESSED_CLASS}:focus-visible {
  outline: 2px solid var(--dsw-alias-state-focus-ring, rgba(77, 107, 254, 0.8));
  outline-offset: 2px;
}
.${PROCESSED_CLASS}-chevron {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
  opacity: 0.55;
  transform: rotate(-90deg);
  transition: transform 0.12s ease, opacity 0.1s ease;
}
.${PROCESSED_CLASS}:hover .${PROCESSED_CLASS}-chevron {
  opacity: 0.9;
}
.${PROCESSED_CLASS}[aria-expanded="true"] .${PROCESSED_CLASS}-chevron {
  transform: rotate(0deg);
}
@media (prefers-reduced-motion: reduce) {
  .${PROCESSED_CLASS},
  .${PROCESSED_CLASS}-chevron {
    transition: none;
  }
}
`

/** One settled-or-open stretch of the flow between boundaries. */
interface SegmentSnapshot {
  /** Stable across React re-renders; derived from the opening marker. */
  key: string
  /** Closing element: turn-tail, or the user/steering row that ended it. */
  boundary: HTMLElement | null
  /** Opening user/steering element; null for history before the first one. */
  startMarker: HTMLElement | null
  /** Whole flow items hidden while collapsed (work seats + middle replies). */
  hideSeats: ReadonlySet<HTMLElement>
  /** Reply-bearing steps that are not the segment's final answer. */
  middleSteps: ReadonlySet<HTMLElement>
  /** Last reply-bearing step; always visible, its thinking rows may hide. */
  finalStep: HTMLElement | null
  /** Thinking rows inside {@link finalStep}, hidden while collapsed. */
  finalThinkRows: readonly HTMLElement[]
  /** Summary row anchor: first hidden seat, else the final answer. */
  firstWork: HTMLElement | null
  closed: boolean
  running: boolean
  hasWork: boolean
}

interface SegmentState {
  key: string
  row: HTMLButtonElement | null
  /** User gesture state; a newly settled segment starts collapsed. */
  expanded: boolean
  snapshot: SegmentSnapshot
  /** Frozen display duration in ms; official host value wins once known. */
  duration?: number
}


export class AutoCollapseController {
  private observer: MutationObserver | null = null
  private raf = 0
  private timer: ReturnType<typeof setTimeout> | 0 = 0
  private auditTimer: ReturnType<typeof setTimeout> | 0 = 0
  /** True between start() and stop(); the preference toggle re-enters both. */
  private running = false
  private lastPassError = ''

  private flow: HTMLElement | null = null
  /** Stable segment key → summary row + gesture state. */
  private segmentStates = new Map<string, SegmentState>()
  /** First sighting of a running segment, for turns without a host duration. */
  private runningSince = new Map<string, number>()
  /** Segments that settled once: a resumed run restarts local timing. */
  private completedOnce = new Set<string>()
  /** Precise pre-plugin display values, restored on stop/switch/takeover. */
  private originalDisplay = new WeakMap<HTMLElement, string>()
  private writtenDisplay = new WeakMap<HTMLElement, string>()
  private controlledDisplay = new Set<HTMLElement>()
  /** Reply-presence verdicts cached per message until a mutation hits it. */
  private bodyTextCache = new WeakMap<HTMLElement, boolean>()
  private dirtyMessages = new Set<HTMLElement>()

  private readonly onVisibilityChange = (): void => {
    if (typeof document === 'undefined' || document.hidden !== true) this.schedule()
  }

  /** Re-run a pass immediately (settings changes, diagnostics, tests).
   * Reply-presence verdicts are dropped wholesale: manual refreshes are rare,
   * and a conservative rebuild beats a stale classification. */
  refresh(): void {
    this.bodyTextCache = new WeakMap()
    this.dirtyMessages.clear()
    this.schedule()
  }

  start(): void {
    if (this.running) return
    this.running = true
    injectStyle()
    try {
      this.observer = new MutationObserver(records => {
        if (this.shouldSchedule(records)) {
          this.markDirty(records)
          this.schedule()
        }
      })
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        // Tool/think completion flips data-state without touching structure;
        // characterData drives late reply text into the classifier.
        attributeFilter: ['data-state'],
        characterData: true,
      })
      this.armAuditLoop()
      this.schedule()
    } catch (error) {
      this.reportError(error)
      throw error
    }
  }

  stop(): void {
    this.running = false
    if (this.raf !== 0) cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.timer !== 0) clearTimeout(this.timer)
    this.timer = 0
    if (this.auditTimer !== 0) clearTimeout(this.auditTimer)
    this.auditTimer = 0
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
    }
    this.observer?.disconnect()
    this.observer = null
    this.switchFlow(null)
    removeStyle()
  }

  /** Low-frequency reconciliation for style writes no observer can see. */
  private armAuditLoop(): void {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
    }
    this.rearmAudit()
  }

  private rearmAudit(): void {
    if (!this.running || this.auditTimer !== 0) return
    this.auditTimer = setTimeout(() => {
      this.auditTimer = 0
      if (!this.running) return
      if (typeof document !== 'undefined' && document.hidden === true) {
        this.rearmAudit()
        return
      }
      this.schedule()
      this.rearmAudit()
    }, AUDIT_TICK_MS)
  }

  /** Body-level observations only need to wake us up near the active flow. */
  private shouldSchedule(records: MutationRecord[]): boolean {
    if (records.length === 0 || this.flow === null || !this.flow.isConnected) return true
    return records.some(record => (
      nodeWithin(record.target, this.flow as HTMLElement)
      || nodeWithin(this.flow as HTMLElement, record.target)
    ))
  }

  /** Walk each record to its flow child so reply-cache invalidation stays
   * targeted; anything unattributable invalidates conservatively. */
  private markDirty(records: MutationRecord[]): void {
    const flow = this.flow
    if (flow === null || !flow.isConnected) return
    if (records.length === 0) {
      this.bodyTextCache = new WeakMap()
      this.dirtyMessages.clear()
      return
    }
    for (const record of records) {
      let current: Node | null = record.target
      while (current !== null && current.parentNode !== flow) current = current.parentNode
      if (!(current instanceof HTMLElement)) {
        this.bodyTextCache = new WeakMap()
        this.dirtyMessages.clear()
        return
      }
      this.dirtyMessages.add(current)
    }
  }

  private schedule(): void {
    if (!this.running || this.raf !== 0) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      if (this.timer !== 0) {
        clearTimeout(this.timer)
        this.timer = 0
      }
      this.runPass()
    })
    // Background tabs freeze rAF; the timeout guarantees the pass still runs.
    if (this.timer !== 0) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = 0
      if (this.raf !== 0) {
        cancelAnimationFrame(this.raf)
        this.raf = 0
        this.runPass()
      }
    }, PASS_FALLBACK_MS)
  }

  private runPass(): void {
    try {
      this.pass()
      this.lastPassError = ''
    } catch (error) {
      this.reportError(error)
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    // An async observer crash must not kill coordination silently; keep one
    // non-spammy diagnostic and let later mutations retry.
    if (message === this.lastPassError) return
    this.lastPassError = message
    console.error('[dsh-smooth-stream] auto-collapse pass failed', error)
  }

  private pass(): void {
    if (!this.running) return

    const nextFlow = findFlow()
    if (nextFlow !== this.flow) this.switchFlow(nextFlow)
    const flow = this.flow
    if (flow === null) return

    for (const el of this.dirtyMessages) this.bodyTextCache.delete(el)
    this.dirtyMessages.clear()
    const segments = buildSegments(flow, el => this.hasBodyCached(el))
    const liveSegmentKeys = new Set(segments.map(segment => segment.key))

    for (const segment of segments) {
      if (!segment.running) continue
      // Re-settled after completing once: restart local timing so the frozen
      // duration cannot swallow the idle gap in between.
      if (this.completedOnce.has(segment.key)) {
        this.completedOnce.delete(segment.key)
        this.runningSince.delete(segment.key)
      }
      if (!this.runningSince.has(segment.key)) this.runningSince.set(segment.key, Date.now())
    }

    const completedKeys = new Set<string>()
    for (const segment of segments) {
      if (!segment.closed || segment.running || !segment.hasWork) continue
      completedKeys.add(segment.key)
      this.completedOnce.add(segment.key)
      let state = this.segmentStates.get(segment.key)
      if (state === undefined) {
        state = { key: segment.key, row: null, expanded: false, snapshot: segment }
        this.segmentStates.set(segment.key, state)
      } else {
        state.snapshot = segment
      }
      const started = this.runningSince.get(segment.key)
      const parsed = segment.boundary === null ? undefined : parseTurnDuration(segment.boundary)
      // The host's own duration always wins so live completions and reloaded
      // history agree. Without one (typically a stopped turn) fall back to the
      // locally observed running window, frozen at first settlement so the
      // label stops ticking; a late official value may still override it.
      if (parsed !== undefined) state.duration = parsed
      else if (state.duration === undefined && started !== undefined) state.duration = Date.now() - started
      if (state.row === null || !state.row.isConnected) state.row = this.createProcessedRow(state)
      this.syncProcessedRow(state)
    }

    // Every layout-affecting decision below lands synchronously: one pass,
    // one reflow, no deferred or animated geometry.
    for (const [key, state] of [...this.segmentStates]) {
      if (completedKeys.has(key)) continue
      state.row?.remove()
      this.segmentStates.delete(key)
    }

    const desiredHidden = new Set<HTMLElement>()
    for (const segment of segments) {
      const state = this.segmentStates.get(segment.key)
      const collapse = state !== undefined && !state.expanded
      if (collapse) {
        for (const seat of segment.hideSeats) this.hideElement(seat, desiredHidden)
        for (const row of segment.finalThinkRows) this.hideElement(row, desiredHidden)
        // The final answer itself always shows; its thinking rows were hidden
        // above, everything else about it is restored defensively.
        if (segment.finalStep !== null) this.restoreElement(segment.finalStep)
      } else {
        for (const seat of segment.hideSeats) this.restoreElement(seat)
        for (const row of segment.finalThinkRows) this.restoreElement(row)
        if (segment.finalStep !== null) this.restoreElement(segment.finalStep)
      }
    }

    // Segments whose work is already invisible (hidden by the host or another
    // extension) withdraw their summary row instead of pointing at nothing,
    // but keep owning whatever they still hold so the sweep below leaves it.
    for (const segment of segments) {
      if (!hasVisibleSegmentWork(segment)) {
        const state = this.segmentStates.get(segment.key)
        if (state !== undefined && state.row !== null) {
          state.row.remove()
          state.row = null
        }
      }
      for (const seat of segment.hideSeats) this.retainDisplayControl(seat, desiredHidden)
      for (const row of segment.finalThinkRows) this.retainDisplayControl(row, desiredHidden)
      if (segment.finalStep !== null) this.retainDisplayControl(segment.finalStep, desiredHidden)
    }

    this.restoreUnusedDisplays(desiredHidden)
    for (const state of this.segmentStates.values()) this.placeProcessedRow(flow, state)

    for (const key of [...this.runningSince.keys()]) {
      if (!liveSegmentKeys.has(key)) this.runningSince.delete(key)
    }
    for (const key of [...this.completedOnce]) {
      if (!liveSegmentKeys.has(key)) this.completedOnce.delete(key)
    }
  }

  /** Flow swap means a session switch: fully restore the old tree, rebuild. */
  private switchFlow(next: HTMLElement | null): void {
    if (next === this.flow) return
    for (const state of this.segmentStates.values()) state.row?.remove()
    this.segmentStates.clear()
    this.runningSince.clear()
    this.completedOnce.clear()
    this.bodyTextCache = new WeakMap()
    this.dirtyMessages.clear()
    this.restoreAllDisplays()
    this.flow = next
  }

  /** Keep already-controlled elements in the desired-hidden set so the sweep
   * does not flip them back mid-flight of an external change. */
  private retainDisplayControl(el: HTMLElement, desiredHidden: Set<HTMLElement>): void {
    if (this.controlledDisplay.has(el)) desiredHidden.add(el)
  }

  /** Restore every element the ledger controls that this pass no longer wants
   * hidden; elements absent from `desired` come back to their true display. */
  private restoreUnusedDisplays(desired: ReadonlySet<HTMLElement>): void {
    for (const el of [...this.controlledDisplay]) {
      if (!desired.has(el)) this.restoreElement(el)
    }
  }

  /** Restore every element still under the display ledger, then retire the
   * ledger itself (stop / session switch). */
  private restoreAllDisplays(): void {
    for (const el of [...this.controlledDisplay]) this.restoreElement(el)
    this.controlledDisplay.clear()
    this.originalDisplay = new WeakMap<HTMLElement, string>()
    this.writtenDisplay = new WeakMap<HTMLElement, string>()
  }

  private createProcessedRow(state: SegmentState): HTMLButtonElement {
    const row = createProcessedRowElement(state.duration)
    row.addEventListener('click', () => {
      state.expanded = !state.expanded
      this.syncProcessedRow(state)
      this.schedule()
    })
    return row
  }

  private syncProcessedRow(state: SegmentState): void {
    const row = state.row
    if (row === null) return
    const copy = resolveFoldCopy()
    const text = row.firstElementChild
    const label = state.duration === undefined
      ? copy.processedLabel
      : `${copy.processedLabel} ${copy.formatDuration(state.duration)}`
    if (text !== null && text.textContent !== label) text.textContent = label
    const expanded = String(state.expanded)
    if (row.getAttribute('aria-expanded') !== expanded) row.setAttribute('aria-expanded', expanded)
    const title = state.expanded ? copy.collapseTitle : copy.expandTitle
    if (row.title !== title) row.title = title
  }

  private placeProcessedRow(flow: HTMLElement, state: SegmentState): void {
    const row = state.row
    if (row === null) return
    if (!state.snapshot.hasWork || !hasVisibleSegmentWork(state.snapshot)) {
      row.remove()
      state.row = null
      return
    }
    let target = state.snapshot.firstWork ?? state.snapshot.finalStep ?? state.snapshot.boundary
    // Snapshot targets are always flow children; if that invariant somehow
    // breaks, drop the row and let the next pass rebuild it rather than
    // stacking disconnected rows with duplicate click handlers.
    if (target === null || target.parentElement !== flow) {
      row.remove()
      state.row = null
      return
    }
    if (row.parentElement !== flow || row.nextElementSibling !== target) {
      target.before(row)
      this.revealVisualOnce(row)
    }
  }

  private hasBodyCached(el: HTMLElement): boolean {
    const cached = this.bodyTextCache.get(el)
    if (cached !== undefined) return cached
    const value = hasBodyContent(el)
    this.bodyTextCache.set(el, value)
    return value
  }

  /** True when the recorded display was changed (or the ownership sentinel
   * wiped) behind the ledger's back; callers hand control back to reality. */
  private displayForeign(el: HTMLElement): boolean {
    const written = this.writtenDisplay.get(el)
    if (written === undefined) return false
    return el.style.getPropertyValue(DISPLAY_OWNED_PROP) === '' || el.style.display !== written
  }

  private releaseDisplayLedger(el: HTMLElement): void {
    this.originalDisplay.delete(el)
    this.writtenDisplay.delete(el)
    this.controlledDisplay.delete(el)
    el.style.removeProperty(DISPLAY_OWNED_PROP)
  }

  private hideElement(el: HTMLElement, desired: Set<HTMLElement>): void {
    desired.add(el)
    if (!this.originalDisplay.has(el) && !isDisplayed(el)) return
    // First takeover records the exact original; a foreign full rewrite (sentinel
    // gone) or value swap re-records from current truth so restoration hands
    // back what the outsider wrote over, never a stale snapshot.
    if (!this.originalDisplay.has(el) || this.displayForeign(el)) {
      this.originalDisplay.set(el, el.style.display)
      this.writtenDisplay.set(el, el.style.display)
      el.style.setProperty(DISPLAY_OWNED_PROP, '1')
    }
    this.controlledDisplay.add(el)
    if (el.style.display === 'none') return
    // Synchronous by contract: deferring the layout change to an animation end
    // leaves the true geometry unmeasured and reintroduces the post-collapse
    // snap. Folds are one reflow plus a paint-only row fade.
    el.style.display = 'none'
    this.writtenDisplay.set(el, 'none')
  }

  private restoreElement(el: HTMLElement): void {
    if (!this.originalDisplay.has(el)) return
    // Respect an outside takeover: never resurrect something another script
    // (or the user) deliberately hid after we did.
    if (this.displayForeign(el)) {
      this.releaseDisplayLedger(el)
      return
    }
    const original = this.originalDisplay.get(el) as string
    if (el.style.display !== original) el.style.display = original
    this.releaseDisplayLedger(el)
  }

  /** Whether WAAPI exists and the user has not asked for reduced motion. */
  private canAnimate(el: HTMLElement): boolean {
    if (typeof el.animate !== 'function') return false
    try {
      if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    } catch {
      return false
    }
    return true
  }

  /** First-appearance flourish for the plugin-owned summary row: a pure
  * opacity fade. Paint-only, so it cannot shift anyone's layout. */
  private revealVisualOnce(row: HTMLButtonElement): void {
    if (row.dataset.dshssShown === '1') return
    row.dataset.dshssShown = '1'
    if (!this.canAnimate(row)) return
    row.animate(
      [{ opacity: '0' }, { opacity: '1' }],
      { duration: FOLD_ROW_FADE_MS, easing: FOLD_EASE_OUT },
    )
  }
}

/** Visible chat flow container, falling back to the first one rendered. */
function findFlow(): HTMLElement | null {
  const flows = document.querySelectorAll<HTMLElement>('[data-chat-flow]')
  for (const flow of flows) {
    if (flow.offsetParent !== null || flow.getBoundingClientRect().width > 0) return flow
  }
  return flows[0] ?? null
}

/** parentNode walk that also accepts Text mutation targets. */
function nodeWithin(node: Node, ancestor: Node): boolean {
  for (let current: Node | null = node; current !== null; current = current.parentNode) {
    if (current === ancestor) return true
  }
  return false
}

/** Top-level message order, excluding this plugin's own summary rows. */
function flowItems(flow: HTMLElement): HTMLElement[] {
  return [...flow.children].filter((el): el is HTMLElement => (
    el instanceof HTMLElement && !el.classList.contains(PROCESSED_CLASS)
  ))
}

function isDisplayed(el: HTMLElement): boolean {
  if (typeof getComputedStyle === 'function') return getComputedStyle(el).display !== 'none'
  return el.style.display !== 'none'
}

function stableElementKey(el: HTMLElement, fallbackIndex: number): string {
  const kind = el.getAttribute('data-chat-flow-kind') ?? 'node'
  const key = el.getAttribute('data-chat-flow-key')
    ?? el.getAttribute('data-chat-anchor-key')
    ?? `${kind}:${fallbackIndex}`
  return `${kind}:${key}`
}

/** Kinds that can open a history stretch lacking an explicit user marker. */
function opensTurnWork(el: HTMLElement): boolean {
  const kind = el.getAttribute('data-chat-flow-kind')
  return kind === 'assistant-step'
    || kind === 'assistant'
    || kind === 'tool-call'
    || kind === 'command'
    || kind === 'manual-compaction'
}

/**
 * Split the flow into turn segments. `user`/`steering` rows close the previous
 * segment and open the next; `turn-tail` closes and resets the opener. Leading
 * context before the first user row joins that user's segment, matching how
 * the host presents context injection.
 */
function buildSegments(flow: HTMLElement, hasBody: (el: HTMLElement) => boolean): SegmentSnapshot[] {
  const items = flowItems(flow)
  const itemIndex = new Map(items.map((el, index) => [el, index]))
  const snapshots: SegmentSnapshot[] = []
  let contentStart = 0
  let startMarker: HTMLElement | null = null

  const append = (end: number, boundary: HTMLElement | null, closed: boolean): void => {
    if (end < contentStart) return
    const range = items.slice(contentStart, end)
    const hideSeats = new Set<HTMLElement>()
    const bodySteps: HTMLElement[] = []
    let running = false
    for (const el of range) {
      const classified = classifyItem(el, hasBody)
      if (classified.fold === 'body') bodySteps.push(el)
      else if (classified.fold === 'seat') hideSeats.add(el)
      if (classified.running) running = true
    }
    const finalStep = bodySteps.at(-1) ?? null
    const middleSteps = new Set(bodySteps.slice(0, -1))
    for (const step of middleSteps) hideSeats.add(step)
    const finalThinkRows = finalStep === null ? [] : thinkRowsIn(finalStep)
    const firstWork: HTMLElement | null = range.find(el => hideSeats.has(el)) ?? finalStep
    const identity = startMarker
      ?? range.find(el => opensTurnWork(el))
      ?? boundary
    const identityIndex = identity === null ? contentStart : (itemIndex.get(identity) ?? contentStart)
    const prefix = startMarker === null ? 'leading' : 'segment'
    const key = `${prefix}:${identity === null ? `open:${contentStart}` : stableElementKey(identity, identityIndex)}`
    snapshots.push({
      key,
      boundary,
      startMarker,
      hideSeats,
      middleSteps,
      finalStep,
      finalThinkRows,
      firstWork,
      closed,
      running,
      hasWork: hideSeats.size > 0 || finalThinkRows.length > 0,
    })
  }

  items.forEach((el, index) => {
    const kind = el.getAttribute('data-chat-flow-kind')
    if (kind === 'user' || kind === 'steering') {
      if (startMarker !== null) {
        append(index, el, true)
        contentStart = index + 1
      } else {
        const leading = items.slice(contentStart, index)
        if (leading.some(el => opensTurnWork(el))) {
          append(index, el, true)
          contentStart = index + 1
        }
        // Only leading context so far: keep accumulating into the next user's
        // segment, mirroring the host's presentation of context injection.
      }
      startMarker = el
      return
    }
    if (kind === 'turn-tail') {
      append(index, el, true)
      contentStart = index + 1
      startMarker = null
    }
  })
  if (contentStart < items.length) append(items.length, null, false)
  return snapshots
}

interface ItemClass {
  fold: 'body' | 'seat' | 'skip'
  running: boolean
}

/**
 * Classify one top-level flow item against the Harness's own node vocabulary.
 * Reply-bearing assistant messages become `body` candidates (last one per
 * segment wins as the final answer); core work process — tool-call seats,
 * command/compaction cards, context injection, thinking-only messages —
 * becomes a hideable `seat`. Everything else is skipped untouched: boundaries,
 * empty decorations, and crucially any kind this module does not own, so rows
 * contributed by other plugins' slots are never folded or hidden.
 */
function classifyItem(el: HTMLElement, hasBody: (el: HTMLElement) => boolean): ItemClass {
  const kind = el.getAttribute('data-chat-flow-kind')
  if (kind === 'user' || kind === 'steering' || kind === 'turn-tail') return { fold: 'skip', running: false }
  if (kind === 'assistant-step' || kind === 'assistant') {
    if (hasBody(el)) return { fold: 'body', running: subtreeRunning(el) }
    // Thinking-only message: folded whole, like any other work seat.
    if (thinkRowsIn(el).length > 0) return { fold: 'seat', running: subtreeRunning(el) }
    return { fold: 'skip', running: false }
  }
  if (kind === 'tool-call') {
    // Native tool cards come in two families — ToolRow compositions
    // (read/write/search/todo/… plus the GenericToolCard fallback, stamped
    // data-tool + data-variant + data-state) and hand-rolled chrome that
    // still follows the convention (Bash: data-variant="bash" +
    // data-state). Fully custom toolviews — an embedded piano, a game board
    // — carry neither attribute; they belong to other plugins' surfaces and
    // are never folded.
    const rows = topCallRowsIn(el)
    if (rows.length === 0 || !rows.every(row => hasNativeCardChrome(row))) {
      return { fold: 'skip', running: subtreeRunning(el) }
    }
    return { fold: 'seat', running: subtreeRunning(el) }
  }
  if (kind === 'context' || kind === 'command' || kind === 'manual-compaction') {
    return { fold: 'seat', running: subtreeRunning(el) }
  }
  return { fold: 'skip', running: false }
}

/** Native work-card shape: every core card family stamps `data-variant`
 * together with `data-state`, whether composed through ToolRow or hand-rolled
 * (Bash). Custom toolviews use their own namespaced attributes instead. */
function hasNativeCardChrome(row: HTMLElement): boolean {
  return row.querySelector('[data-variant][data-state]') !== null
}

/** Whether anything inside the item reports a running lifecycle. Deliberately
 * broad: staying "running" too long only delays a collapse, collapsing early
 * would cut off live output. Native cards stamp `data-state` next to
 * `data-tool`/`data-variant`; custom views use their own vocabulary and are
 * intentionally invisible here. */
function subtreeRunning(el: HTMLElement): boolean {
  if (el.getAttribute('data-state') === 'running') return true
  for (const root of el.querySelectorAll<HTMLElement>('[data-tool][data-state], [data-variant][data-state]')) {
    if (root.getAttribute('data-state') === 'running') return true
  }
  return false
}

function hasVisibleSegmentWork(segment: SegmentSnapshot): boolean {
  const candidates = [
    ...segment.hideSeats,
    ...segment.middleSteps,
  ]
  if (segment.startMarker !== null) candidates.push(segment.startMarker)
  if (segment.finalStep !== null) candidates.push(segment.finalStep)
  return candidates.some(isDisplayed)
}

/** Top-level tool card rows of a seat (excluding sub-dispatch nests). */
function topCallRowsIn(el: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = []
  for (const row of el.querySelectorAll<HTMLElement>('[data-chat-call-id]')) {
    if (row.closest('[data-subcalls]') !== null) continue
    if (row.closest('[data-chat-call-id]') !== row) continue
    rows.push(row)
  }
  return rows
}

/** Reasoning rows of a message: native think variants outside tool cards. */
function thinkRowsIn(el: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = []
  for (const row of el.querySelectorAll<HTMLElement>('[data-variant="think"]:not([data-tool])')) {
    if (row.closest('[data-chat-call-id]') !== null) continue
    if (row.closest('[data-subcalls]') !== null) continue
    rows.push(row)
  }
  return rows
}

/**
 * Reply detection beyond reasoning rows and tool cards: any non-empty text or
 * media counts, because Markdown paragraphs necessarily carry text nodes.
 * Rendered markdown class names are build-time hashes, so structure-based
 * detection is the only stable contract.
 */
function hasBodyContent(el: HTMLElement): boolean {
  // Command and compaction cards are work visualization, never replies.
  const kind = el.getAttribute('data-chat-flow-kind')
  if (kind === 'command' || kind === 'manual-compaction') return false
  if (hasBodyText(el)) return true
  const excluded = '[data-variant="think"], [data-chat-call-id]'
  for (const media of el.querySelectorAll<HTMLElement>('img, video, audio, canvas')) {
    if (media.closest(excluded) === null) return true
  }
  return false
}

function hasBodyText(el: HTMLElement): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node: Text | null
  while ((node = walker.nextNode() as Text | null) !== null) {
    if (node.data.trim() === '') continue
    const parent = node.parentElement
    if (parent !== null && parent.closest('[data-variant="think"], [data-chat-call-id], [data-variant="others"][data-state]') !== null) continue
    return true
  }
  return false
}

/**
 * Official turn duration from the closing element: localized tails read
 * `用时 33秒` / `用时 2分05秒` or `Ran for 33s` / `Ran for 2m 05s`; newer
 * tails only carry an end timestamp, which is diffed against the opening user
 * row's timestamp.
 */
function parseTurnDuration(boundary: HTMLElement): number | undefined {
  const text = boundary.textContent ?? ''
  const zh = text.match(/用时\s*(\d+)分(\d+)秒|用时\s*(\d+)秒/)
  if (zh !== null) {
    if (zh[1] !== undefined && zh[2] !== undefined) return Number(zh[1]) * 60000 + Number(zh[2]) * 1000
    if (zh[3] !== undefined) return Number(zh[3]) * 1000
    return undefined
  }
  const en = text.match(/Ran for\s*(?:(\d+)m\s*)?(\d+)s/)
  if (en !== null) {
    const minutes = en[1] === undefined ? 0 : Number(en[1])
    return (minutes * 60 + Number(en[2])) * 1000
  }
  const end = parseTimeText(text)
  const start = findTurnStart(boundary)
  if (end !== undefined && start !== undefined && end > start) return end - start
  return undefined
}

/** DSH timestamp text (`8月14日 21:56` / `2026年8月14日 22:11`) → epoch ms. */
function parseTimeText(text: string): number | undefined {
  const m = text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/)
  if (m === null) return undefined
  const year = m[1] !== undefined ? Number(m[1]) : new Date().getFullYear()
  const t = new Date(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime()
  return Number.isNaN(t) ? undefined : t
}

/** Latest turn-opening timestamp at or before the boundary element. */
function findTurnStart(boundary: HTMLElement): number | undefined {
  const flow = boundary.parentElement
  if (flow === null) return undefined
  let best: HTMLElement | null = null
  for (const s of flow.querySelectorAll<HTMLElement>('[class*="timeStart"]')) {
    // Timestamps live deep inside user rows; order them against the boundary
    // instead of trusting querySelector document order alone.
    const pos = s.compareDocumentPosition(boundary)
    if ((pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 || (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0 || s === boundary) best = s
    else break
  }
  if (best === null) return undefined
  return parseTimeText(best.textContent ?? '')
}

/** Compact duration pieces shared by both locales: seconds under a minute,
 * whole minutes drop the seconds, hours drop to minute granularity. */
function durationParts(ms: number): { h: number; m: number; s: number } {
  const s = Math.round(ms / 1000)
  return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 }
}

/** 毫秒 → 中文紧凑时长（14秒 / 2分05秒 / 15分 / 3小时2分）。 */
export function formatZhDuration(ms: number): string {
  const { h, m, s } = durationParts(ms)
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`
  if (s < 60 && m === 0 && h === 0) return `${s}秒`
  if (s === 0) return `${m}分`
  return `${m}分${String(s).padStart(2, '0')}秒`
}

/** Milliseconds → compact English duration (14s / 2m05s / 15m / 3h2m). */
export function formatEnDuration(ms: number): string {
  const { h, m, s } = durationParts(ms)
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`
  if (m === 0 && h === 0) return `${s}s`
  if (s === 0) return `${m}m`
  return `${m}m${String(s).padStart(2, '0')}s`
}

/** Native disclosure chevron (IconChevronDownOutline14, 14x14). */
const CHEVRON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'

function createChevronIcon(className: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 14 14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', CHEVRON_PATH)
  path.setAttribute('fill', 'currentColor')
  svg.appendChild(path)
  return svg
}

function createProcessedRowElement(duration?: number): HTMLButtonElement {
  const copy = resolveFoldCopy()
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = PROCESSED_CLASS
  btn.setAttribute('aria-expanded', 'false')
  const text = document.createElement('span')
  text.textContent = duration === undefined
    ? copy.processedLabel
    : `${copy.processedLabel} ${copy.formatDuration(duration)}`
  btn.append(text, createChevronIcon(`${PROCESSED_CLASS}-chevron`))
  btn.title = copy.expandTitle
  return btn
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = FOLD_CSS
  document.head.appendChild(style)
}

function removeStyle(): void {
  document.getElementById(STYLE_ID)?.remove()
}
