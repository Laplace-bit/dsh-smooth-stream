import { useEffect, useRef, useState } from 'react'

/**
 * Detect whether the given markdown text ends inside an unclosed code block (fence).
 * Supports both backtick (```) and tilde (~~~) fences per CommonMark rules.
 *
 * Rules:
 * 1. An opening fence begins on a line with 0-3 leading spaces, followed by 3+ backticks or tildes.
 * 2. An opening backtick fence info-string cannot contain backticks.
 * 3. A closing fence must have at least as many characters as the opening fence, matching fence char,
 *    and cannot have non-whitespace content after the fence characters.
 * 4. While inside a code block, all lines belong to the block until a matching closing fence is found.
 */
interface FenceState {
  inFence: boolean
  fenceChar: string
  fenceLen: number
}

/**
 * Apply one logical line (already split at its `\n`) to the fence state.
 * Shared by the one-shot scan and the incremental scanner below so both make
 * exactly the same fence decision.
 */
function applyFenceLine(state: FenceState, line: string): void {
  let text = line
  if (text.endsWith('\r')) text = text.slice(0, -1)

  let indent = 0
  while (indent < text.length && text[indent] === ' ' && indent < 4) {
    indent++
  }
  if (indent >= 4) return

  const rest = text.slice(indent)
  const firstChar = rest[0]
  if (firstChar !== '`' && firstChar !== '~') return

  let count = 0
  while (count < rest.length && rest[count] === firstChar) {
    count++
  }
  if (count < 3) return

  const afterFence = rest.slice(count)

  if (!state.inFence) {
    if (firstChar !== '`' || !afterFence.includes('`')) {
      state.inFence = true
      state.fenceChar = firstChar
      state.fenceLen = count
    }
  } else if (firstChar === state.fenceChar && count >= state.fenceLen) {
    if (afterFence.trim() === '') {
      state.inFence = false
      state.fenceChar = ''
      state.fenceLen = 0
    }
  }
}

export function hasUnclosedCodeFence(text: string): boolean {
  if (!text.includes('```') && !text.includes('~~~')) {
    return false
  }

  const state: FenceState = { inFence: false, fenceChar: '', fenceLen: 0 }

  let start = 0
  const len = text.length

  while (start < len) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = len

    applyFenceLine(state, text.slice(start, end))
    start = end + 1
  }

  return state.inFence
}

/**
 * Cached scan state for a growing text. `consumed` always sits just past a
 * `\n` (or at 0), so resuming never has to reason about a half-consumed line;
 * the still-growing trailing line is re-applied per call from a copy.
 */
interface FenceScan extends FenceState {
  /** Text this state was derived from; a mismatch means the text was replaced. */
  source: string
  consumed: number
  /** A fence marker has been seen in `source`, so the cheap path is over. */
  sawMarker: boolean
}

export function createFenceScan(): FenceScan {
  return { inFence: false, fenceChar: '', fenceLen: 0, source: '', consumed: 0, sawMarker: false }
}

/** Whether a fence marker starts at or after `from`, looking 2 back for a split append. */
function hasFenceMarkerFrom(text: string, from: number): boolean {
  const start = Math.max(0, from - 2)
  return text.indexOf('```', start) !== -1 || text.indexOf('~~~', start) !== -1
}

/**
 * `hasUnclosedCodeFence` for a text that only ever grows. The reveal engine
 * re-renders on every frame, and a full scan there costs time proportional to
 * the reply's whole line count on every frame; this walks only the lines that
 * arrived since the previous call.
 */
export function scanUnclosedFence(scan: FenceScan, text: string): boolean {
  if (!text.startsWith(scan.source)) {
    scan.inFence = false
    scan.fenceChar = ''
    scan.fenceLen = 0
    scan.consumed = 0
    scan.sawMarker = false
  }

  if (!scan.sawMarker) {
    if (!hasFenceMarkerFrom(text, scan.consumed)) {
      // No marker anywhere in the text, so no line can open a fence. Advance
      // to the last line boundary, not to the end: `consumed` must keep
      // sitting just past a `\n`.
      scan.consumed = text.lastIndexOf('\n') + 1
      scan.source = text
      return false
    }
    scan.sawMarker = true
  }

  let start = scan.consumed
  const len = text.length
  while (start < len) {
    const end = text.indexOf('\n', start)
    if (end === -1) break
    applyFenceLine(scan, text.slice(start, end))
    start = end + 1
  }
  scan.consumed = start
  scan.source = text

  const tail: FenceState = { inFence: scan.inFence, fenceChar: scan.fenceChar, fenceLen: scan.fenceLen }
  applyFenceLine(tail, text.slice(start))
  return tail.inFence
}

export interface DecoupledMarkdownOptions {
  /** Throttle interval in milliseconds during unclosed code blocks. Defaults to 33ms (~30Hz). */
  throttleMs?: number
}

/**
 * Decouple the smooth 60 FPS animation clock from the heavyweight Markdown AST compilation clock.
 *
 * Outside unclosed code blocks (or when settled), Markdown renders 1:1 with `shown`.
 * Inside unclosed code blocks (where host incremental parsing degenerates to O(n) full-text compilation),
 * Markdown re-renders are throttled to ~33ms (30Hz).
 * Upon code block closure or stream end, updates are synchronized immediately without latency.
 */
export function useDecoupledMarkdown(
  shown: string,
  live: boolean,
  options?: DecoupledMarkdownOptions
): string {
  const throttleMs = options?.throttleMs ?? 33
  // Incremental across renders: `shown` only ever grows during a stream, so
  // only the lines appended since the previous render are walked.
  const fenceScanRef = useRef<FenceScan | null>(null)
  const fenceScan = fenceScanRef.current ?? (fenceScanRef.current = createFenceScan())
  const unclosed = live && scanUnclosedFence(fenceScan, shown)
  const [throttledShown, setThrottledShown] = useState(shown)
  const lastCommitTimeRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shownRef = useRef(shown)
  shownRef.current = shown
  const wasUnclosedRef = useRef(false)

  useEffect(() => {
    // If not in unclosed code block (plain text, tables, closed fences, settled):
    // clear pending timers and reset the fence tracker.
    // Crucially: DO NOT call setState here, avoiding double renders and 1-frame lag!
    if (!unclosed) {
      wasUnclosedRef.current = false
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }

    const now = performance.now()

    // Rising edge: just entered unclosed code block
    if (!wasUnclosedRef.current) {
      wasUnclosedRef.current = true
      lastCommitTimeRef.current = now
      setThrottledShown(shown)
      return
    }

    // Inside unclosed code block: apply intelligent throttle
    const elapsed = now - lastCommitTimeRef.current
    if (elapsed >= throttleMs) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setThrottledShown(shown)
      lastCommitTimeRef.current = now
    } else if (timerRef.current === null) {
      const delay = Math.max(16, throttleMs - elapsed)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setThrottledShown(shownRef.current)
        lastCommitTimeRef.current = performance.now()
      }, delay)
    }
  }, [shown, unclosed, throttleMs])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  // Outside unclosed code blocks (or when settled), return `shown` directly.
  // 100% synchronous, zero 1-frame lag, zero double-renders, zero scheduling jitter!
  if (!unclosed) {
    return shown
  }

  // When unclosed, if this is the opening frame of the fence, show it immediately.
  if (!wasUnclosedRef.current) {
    return shown
  }

  return throttledShown
}
