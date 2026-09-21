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
export function hasUnclosedCodeFence(text: string): boolean {
  if (!text.includes('```') && !text.includes('~~~')) {
    return false
  }

  let inFence = false
  let fenceChar = ''
  let fenceLen = 0

  let start = 0
  const len = text.length

  while (start < len) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = len

    let line = text.slice(start, end)
    if (line.endsWith('\r')) line = line.slice(0, -1)

    let indent = 0
    while (indent < line.length && line[indent] === ' ' && indent < 4) {
      indent++
    }

    if (indent < 4) {
      const rest = line.slice(indent)
      const firstChar = rest[0]

      if (firstChar === '`' || firstChar === '~') {
        let count = 0
        while (count < rest.length && rest[count] === firstChar) {
          count++
        }

        if (count >= 3) {
          const afterFence = rest.slice(count)

          if (!inFence) {
            if (firstChar !== '`' || !afterFence.includes('`')) {
              inFence = true
              fenceChar = firstChar
              fenceLen = count
            }
          } else if (firstChar === fenceChar && count >= fenceLen) {
            if (afterFence.trim() === '') {
              inFence = false
              fenceChar = ''
              fenceLen = 0
            }
          }
        }
      }
    }

    start = end + 1
  }

  return inFence
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
  const [markdownShown, setMarkdownShown] = useState(shown)
  const lastCommitTimeRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shownRef = useRef(shown)
  shownRef.current = shown
  const wasUnclosedRef = useRef(false)

  useEffect(() => {
    // If not live (settled / motion reduced / stream closed), sync immediately
    if (!live) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setMarkdownShown(shown)
      lastCommitTimeRef.current = performance.now()
      wasUnclosedRef.current = false
      return
    }

    const unclosed = hasUnclosedCodeFence(shown)
    const now = performance.now()

    // Edge case: Closing edge - code block just closed right now!
    // Immediately sync so completed code block styles render cleanly without any lag
    if (wasUnclosedRef.current && !unclosed) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      wasUnclosedRef.current = false
      setMarkdownShown(shown)
      lastCommitTimeRef.current = now
      return
    }

    wasUnclosedRef.current = unclosed

    // Outside code blocks, keep instant 1:1 synchronization
    if (!unclosed) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setMarkdownShown(shown)
      lastCommitTimeRef.current = now
      return
    }

    // Inside unclosed code block: apply intelligent throttle
    const elapsed = now - lastCommitTimeRef.current
    if (elapsed >= throttleMs) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setMarkdownShown(shown)
      lastCommitTimeRef.current = now
    } else {
      if (timerRef.current === null) {
        const delay = Math.max(16, throttleMs - elapsed)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          setMarkdownShown(shownRef.current)
          lastCommitTimeRef.current = performance.now()
        }, delay)
      }
    }
  }, [shown, live, throttleMs])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  return live ? markdownShown : shown
}
