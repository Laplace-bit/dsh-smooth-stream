import { useEffect, useRef, type ReactNode } from 'react'
import { useConversationFollow } from './teleprompterGlide.ts'
import css from './TypewriterAssistantNodeView.module.css'

/**
 * Document-flow host that owns conversation-port follow while `active`.
 * Shared by assistant blocks and every other Agent Chat row. `onGrowth` lets
 * generic wrapped renderers re-arm one glide when their DOM grows without
 * requiring a business-kind-specific lifecycle predicate.
 */
export function FollowHost({
  active,
  entrance = false,
  onEntranceSettled,
  onGrowth,
  entranceExtentRef,
  speedCpsRef,
  revealScaleRef,
  predictive = true,
  predictiveRef,
  hostRef,
  children,
}: {
  active: boolean
  entrance?: boolean
  onEntranceSettled?: (() => void) | undefined
  onGrowth?: ((deltaPx: number) => void) | undefined
  entranceExtentRef?: { current: number | null } | undefined
  speedCpsRef: { current: number }
  revealScaleRef?: { current: number } | undefined
  predictive?: boolean
  predictiveRef?: { current: boolean } | undefined
  hostRef?: { current: HTMLDivElement | null } | undefined
  children: ReactNode
}) {
  const localRootRef = useRef<HTMLDivElement>(null)
  const rootRef = hostRef ?? localRootRef
  useConversationFollow(
    rootRef,
    active || entrance,
    speedCpsRef,
    revealScaleRef,
    predictive,
    entrance,
    onEntranceSettled,
    predictiveRef,
    entranceExtentRef,
  )
  useEffect(() => {
    if (onGrowth === undefined || typeof ResizeObserver === 'undefined') return
    const root = rootRef.current
    if (root === null) return
    let previousHeight: number | null = null
    const observer = new ResizeObserver(entries => {
      const nextHeight = entries[0]?.contentRect.height ?? root.getBoundingClientRect().height
      if (!Number.isFinite(nextHeight)) return
      if (previousHeight !== null && nextHeight > previousHeight + 0.5) {
        onGrowth(nextHeight - previousHeight)
      }
      previousHeight = nextHeight
    })
    observer.observe(root)
    return () => { observer.disconnect() }
  }, [onGrowth])
  return <div ref={rootRef} className={css.follow}>{children}</div>
}
