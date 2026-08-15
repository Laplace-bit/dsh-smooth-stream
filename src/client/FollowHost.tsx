import { useRef, type ReactNode } from 'react'
import { useConversationFollow } from './teleprompterGlide.ts'
import css from './TypewriterAssistantNodeView.module.css'

/**
 * Document-flow host that owns conversation-port follow while `active`.
 * Shared by assistant blocks and every other growing Chat row.
 */
export function FollowHost({
  active,
  speedCpsRef,
  children,
}: {
  active: boolean
  speedCpsRef: { current: number }
  children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useConversationFollow(rootRef, active, speedCpsRef)
  return <div ref={rootRef} className={css.follow}>{children}</div>
}
