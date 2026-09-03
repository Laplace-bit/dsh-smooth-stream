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
  revealedCharsRef,
  revealScaleRef,
  predictive = true,
  predictiveRef,
  controlScroll = true,
  hostRef,
  className,
  entranceActive,
  children,
}: {
  active: boolean
  entrance?: boolean
  onEntranceSettled?: (() => void) | undefined
  onGrowth?: ((deltaPx: number) => void) | undefined
  entranceExtentRef?: { current: number | null } | undefined
  speedCpsRef: { current: number }
  revealedCharsRef?: { current: number } | undefined
  revealScaleRef?: { current: number } | undefined
  predictive?: boolean
  predictiveRef?: { current: boolean } | undefined
  /** False leaves conversation bottom-follow to the Host. */
  controlScroll?: boolean
  hostRef?: { current: HTMLDivElement | null } | undefined
  children: ReactNode
  className?: string | undefined
  /** Optional marker for a generic row's one-shot entrance animation. */
  entranceActive?: boolean | undefined
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
    revealedCharsRef,
    controlScroll,
  )
  useEffect(() => {
    if (onGrowth === undefined || typeof ResizeObserver === 'undefined') return
    const root = rootRef.current
    if (root === null) return
    let previousHeight: number | null = null
    let pendingGrowth = 0
    let growthFrame: number | null = null
    const flushGrowth = (): void => {
      growthFrame = null
      if (pendingGrowth <= 0) return
      const delta = pendingGrowth
      pendingGrowth = 0
      onGrowth(delta)
    }
    const observer = new ResizeObserver(entries => {
      const measuredHeight = entries[0]?.contentRect.height
      if (measuredHeight === undefined || !Number.isFinite(measuredHeight)) return
      const nextHeight = measuredHeight
      if (previousHeight !== null && nextHeight > previousHeight + 0.5) {
        pendingGrowth += nextHeight - previousHeight
        if (growthFrame === null) growthFrame = requestAnimationFrame(flushGrowth)
      }
      previousHeight = nextHeight
    })
    observer.observe(root)
    return () => {
      observer.disconnect()
      if (growthFrame !== null) cancelAnimationFrame(growthFrame)
    }
  }, [onGrowth])
  return (
    <div
      ref={rootRef}
      className={className === undefined ? css.follow : `${css.follow} ${className}`}
      data-entrance={entranceActive === undefined ? undefined : entranceActive ? 'active' : 'idle'}
    >
      {children}
    </div>
  )
}
