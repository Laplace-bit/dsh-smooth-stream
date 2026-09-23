/**
 * High-performance append-only stream buffer with code-point cursor addressing.
 *
 * Avoids per-frame `[...content].slice().join('')` or repeated full-string allocations.
 * Chunks are stored in an indexed rope array, and code-point to UTF-16 offset maps
 * are updated incrementally per chunk.
 */

export class StreamBuffer {
  private chunks: string[] = []
  private chunkCodePoints: number[] = []
  private chunkCharLengths: number[] = []
  private totalCodePoints = 0
  private fullStringCache: string | null = null

  constructor(initialText = '') {
    if (initialText.length > 0) {
      this.append(initialText)
    }
  }

  /**
   * Count Unicode code points (perceived characters, UTF-16 surrogate pairs counted as 1).
   */
  static countCodePoints(str: string): number {
    let count = 0
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        const next = str.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++
        }
      }
      count++
    }
    return count
  }

  /**
   * Convert code-point index into UTF-16 unit offset within a single chunk.
   */
  private static codePointToOffset(str: string, targetCp: number): number {
    let cp = 0
    let offset = 0
    while (offset < str.length && cp < targetCp) {
      const code = str.charCodeAt(offset)
      if (code >= 0xd800 && code <= 0xdbff && offset + 1 < str.length) {
        const next = str.charCodeAt(offset + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          offset++
        }
      }
      offset++
      cp++
    }
    return offset
  }

  /**
   * Append a new chunk to the buffer.
   */
  append(chunk: string): void {
    if (chunk.length === 0) return
    const cps = StreamBuffer.countCodePoints(chunk)
    this.chunks.push(chunk)
    this.chunkCodePoints.push(cps)
    this.chunkCharLengths.push(chunk.length)
    this.totalCodePoints += cps
    this.fullStringCache = null
  }

  /**
   * Total perceived characters (code points) in the buffer.
   */
  get length(): number {
    return this.totalCodePoints
  }

  /**
   * Reset the buffer to empty or to a new baseline string.
   */
  reset(text = ''): void {
    this.chunks = []
    this.chunkCodePoints = []
    this.chunkCharLengths = []
    this.totalCodePoints = 0
    this.fullStringCache = null
    if (text.length > 0) {
      this.append(text)
    }
  }

  /**
   * Extract a slice of text between `fromCp` and `toCp` (both in code points).
   */
  slice(fromCp: number, toCp: number): string {
    const start = Math.max(0, fromCp)
    const end = Math.min(this.totalCodePoints, toCp)
    if (start >= end) return ''

    // Fast path: if requesting the full string
    if (start === 0 && end === this.totalCodePoints) {
      return this.toString()
    }

    let result = ''
    let accumulatedCp = 0

    for (let i = 0; i < this.chunks.length; i++) {
      const chunkCps = this.chunkCodePoints[i]!
      const chunkEndCp = accumulatedCp + chunkCps

      if (chunkEndCp <= start) {
        accumulatedCp = chunkEndCp
        continue
      }
      if (accumulatedCp >= end) {
        break
      }

      const chunk = this.chunks[i]!
      const localStartCp = Math.max(0, start - accumulatedCp)
      const localEndCp = Math.min(chunkCps, end - accumulatedCp)

      const startOffset = localStartCp === 0 ? 0 : StreamBuffer.codePointToOffset(chunk, localStartCp)
      const endOffset = localEndCp === chunkCps ? chunk.length : StreamBuffer.codePointToOffset(chunk, localEndCp)

      result += chunk.slice(startOffset, endOffset)
      accumulatedCp = chunkEndCp
    }

    return result
  }

  /**
   * Get the full concatenated string (cached until next append/reset).
   */
  toString(): string {
    if (this.fullStringCache === null) {
      this.fullStringCache = this.chunks.join('')
    }
    return this.fullStringCache
  }
}
