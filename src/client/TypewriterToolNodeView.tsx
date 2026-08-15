import { createElement, useRef, type ComponentType } from 'react'
import { FollowHost } from './FollowHost.tsx'

/** Props forwarded through a follow wrap; extra kit seats pass through. */
export type FollowWrapProps = {
  node?: unknown
  renderSlot?: unknown
} & Record<string, unknown>

/**
 * True while a Chat node is still growing: an assistant/workflow `status:
 * 'running'` payload, a Tool root that has not settled (`kind` absent), or a
 * model-retry whose current attempt is still `scheduled`.
 * @param node - The Chat node's view `node` prop.
 * @returns whether this row should own conversation follow.
 */
export function isGrowingChatNode(node: unknown): boolean {
  if (node === null || typeof node !== 'object' || !('data' in node)) return false
  const data = (node as { data: unknown }).data
  if (data === null || typeof data !== 'object') return false
  if ('status' in data && (data as { status: unknown }).status === 'running') return true
  if ('root' in data) {
    const root = (data as { root: unknown }).root
    if (root !== null && typeof root === 'object' && !('kind' in root)) return true
  }
  if ('current' in data) {
    const current = (data as { current: unknown }).current
    if (
      current !== null
      && typeof current === 'object'
      && 'retryState' in current
      && (current as { retryState: unknown }).retryState === 'scheduled'
    ) return true
  }
  return false
}

/**
 * Wrap a prior Chat node renderer so a growing row shares conversation
 * follow. Presentation stays with the wrapped component; kit seats
 * (`renderSlot`, locale, inject) pass through unchanged.
 * @param Inner - The already-registered row component.
 * @returns A follow-hosted row.
 */
export function wrapFollowNodeView(Inner: ComponentType<FollowWrapProps>) {
  return function TypewriterFollowNodeView(props: FollowWrapProps) {
    const speedCpsRef = useRef(35)
    return (
      <FollowHost active={isGrowingChatNode(props.node)} speedCpsRef={speedCpsRef}>
        {createElement(Inner, props)}
      </FollowHost>
    )
  }
}
