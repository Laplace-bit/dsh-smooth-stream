/**
 * Flow-part routing for the assistant node view.
 *
 * Kernels from 0.1.7 place one assistant step at up to two rendering positions
 * in the same Turn: the `reasoning` member of the Turn's process disclosure and
 * the `response` node that carries the answer. Each position receives its own
 * instance of the shadowed assistant renderer plus a `groupPart` on the seat
 * props, and the built-in renderer keeps them disjoint:
 *
 * ```ts
 * if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue
 * if (groupPart === 'response' && block.kind === 'reasoning') continue
 * ```
 *
 * A takeover that ignores the field paints the reply twice — once inside the
 * process fold (which the Host forces open while the turn is running) and once
 * as the answer. Older kernels render each step once and send no `groupPart`,
 * which means "every block belongs here".
 */

/** Rendering position the Host hands one assistant step. */
export type AssistantStepPart = 'reasoning' | 'response'

/** Structural block shape the routing decision needs; block payloads stay opaque. */
export interface FlowPartBlock {
  kind: string
}

/**
 * Whether one assistant block belongs to the flow part this render owns.
 * @param block - block carried by the assistant step node.
 * @param part - `groupPart` handed by the seat, absent on single-render kernels.
 * @returns whether this render should paint the block.
 */
export function belongsToFlowPart(block: FlowPartBlock, part: AssistantStepPart | undefined): boolean {
  if (part === 'reasoning') return block.kind === 'reasoning'
  if (part === 'response') return block.kind !== 'reasoning'
  return true
}

/**
 * Whether the active streaming tail block belongs to the flow part this render owns.
 * On split kernels (0.1.7+), only the seat owning the tail block may claim the
 * conversation scrollport's follow leader. The inactive part must not register
 * a competing active FollowHost, which would cause frame-by-frame leader fights
 * and jerky autoscrolling.
 */
export function isFlowPartActiveTail(
  blocks: readonly FlowPartBlock[],
  part: AssistantStepPart | undefined,
): boolean {
  if (part === undefined) return true
  const lastBlock = blocks[blocks.length - 1]
  return lastBlock !== undefined && belongsToFlowPart(lastBlock, part)
}

