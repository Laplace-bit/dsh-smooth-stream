import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { FollowHost } from './FollowHost.tsx'
import { useProgressiveDomText } from './useProgressiveDomText.ts'
import { hasRecentConversationFollow } from './teleprompterGlide.ts'

/** Props forwarded through a follow wrap; extra kit seats pass through. */
export type FollowWrapProps = {
  node?: unknown
  renderSlot?: unknown
} & Record<string, unknown>

function openAgentLocation(node: unknown): boolean {
  if (node === null || typeof node !== 'object' || !('location' in node)) return false
  const location = (node as { location: unknown }).location
  if (location === null || typeof location !== 'object' || !('kind' in location)) return false
  const kind = (location as { kind: unknown }).kind
  if (!('turn' in location)) return false
  const turn = (location as { turn: unknown }).turn
  if (turn === null || typeof turn !== 'object' || !('status' in turn)) return false
  if (kind === 'turn') return (turn as { status: unknown }).status === 'open'
  if (kind !== 'step' || !('step' in location)) return false
  const step = (location as { step: unknown }).step
  return step !== null
    && typeof step === 'object'
    && 'status' in step
    && (step as { status: unknown }).status === 'open'
}

/**
 * True while a Chat node has an explicitly unfinished lifecycle: an
 * assistant/workflow `status: 'running'` payload, a Tool root that has not
 * settled (`kind` absent), or a model-retry whose current attempt is still
 * `scheduled`. Open-but-otherwise-unknown rows are covered by
 * `isFollowableChatNode` below.
 * @param node - The Chat node's view `node` prop.
 * @returns whether this row should own conversation follow.
 */
export function isGrowingChatNode(node: unknown): boolean {
  if (node === null || typeof node !== 'object' || !('data' in node)) return false
  const data = (node as { data: unknown }).data
  if (data === null || typeof data !== 'object') return false
  if ('status' in data && (data as { status: unknown }).status === 'running') return true
  if (
    'kind' in data
    && (data as { kind: unknown }).kind === 'command'
    && 'outcome' in data
    && (data as { outcome: unknown }).outcome === null
  ) return true
  if ('command' in data) {
    const command = (data as { command: unknown }).command
    if (
      command !== null
      && typeof command === 'object'
      && 'outcome' in command
      && (command as { outcome: unknown }).outcome === null
    ) return true
  }
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
 * True for any Agent-owned Chat row in the currently open turn/step. This is
 * the extensibility boundary: a newly registered Context, Command, Tool, or
 * workflow renderer is followed without adding another kind-specific branch.
 */
export function isFollowableChatNode(node: unknown): boolean {
  return isGrowingChatNode(node) || openAgentLocation(node)
}

/**
 * True when a newly mounted Agent-owned row belongs to the current open
 * Turn/Step, or is itself an unresolved growing lifecycle.
 * @param node - The Chat node's view `node` prop.
 * @returns whether its initial height should enter through conversation follow.
 */
export function shouldAnimateChatNodeEntrance(node: unknown): boolean {
  return isFollowableChatNode(node)
}

/** Runtime-only fallback for unknown or terminal rows at the active flow tip. */
function liveAgentTailMode(root: HTMLElement): 'turn' | 'handoff' | null {
  const port = root.closest<HTMLElement>('[data-conversation-scroll]')
  if (port === null) return null
  const row = root.closest<HTMLElement>('[data-chat-flow-key]')
  if (row !== null) {
    let sibling = row.nextElementSibling
    while (sibling !== null) {
      if (sibling instanceof HTMLElement && sibling.hasAttribute('data-chat-flow-key')) return null
      sibling = sibling.nextElementSibling
    }
  }
  const flow = root.closest<HTMLElement>('[data-chat-flow]')
  const hasTurnStatus = flow !== null && [...flow.children].some(child =>
    child instanceof HTMLElement
    && child.getAttribute('role') === 'status'
    && !child.hasAttribute('data-chat-flow-key'))
  if (hasTurnStatus) return 'turn'
  return hasRecentConversationFollow(port) ? 'handoff' : null
}

/**
 * Wrap a prior Agent Chat renderer so its entrance and later growth share
 * conversation follow. Presentation stays with the wrapped component; kit
 * seats (`renderSlot`, locale, inject) pass through unchanged.
 * @param Inner - The already-registered row component.
 * @returns A follow-hosted row.
 */
export function wrapFollowNodeView(Inner: ComponentType<FollowWrapProps>) {
  return function TypewriterFollowNodeView(props: FollowWrapProps) {
    const speedCpsRef = useRef(35)
    const hostRef = useRef<HTMLDivElement>(null)
    const growing = isGrowingChatNode(props.node)
    const structurallyFollowable = isFollowableChatNode(props.node)
    const structuralRef = useRef(structurallyFollowable)
    const [runtimeFollowable, setRuntimeFollowable] = useState(false)
    const runtimePersistentRef = useRef(false)
    const runtimeHandledRef = useRef(false)
    const followable = structurallyFollowable || runtimeFollowable
    const revealInitialRef = useRef(true)
    const [entering, setEntering] = useState(() => shouldAnimateChatNodeEntrance(props.node))
    const [growthPulse, setGrowthPulse] = useState(false)
    const followableRef = useRef(false)
    const growingRef = useRef(growing)
    const entranceActiveRef = useRef(entering || growthPulse)
    const growthExtentRef = useRef<number | null>(null)
    const mountedRef = useRef(true)
    const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    structuralRef.current = structurallyFollowable
    followableRef.current = followable
    growingRef.current = growing
    entranceActiveRef.current = entering || growthPulse
    const finishRuntimeReveal = useCallback(() => {
      if (structuralRef.current || runtimePersistentRef.current) return
      runtimeHandledRef.current = true
      setRuntimeFollowable(false)
    }, [])
    useProgressiveDomText(
      hostRef,
      followable,
      revealInitialRef.current,
      speedCpsRef,
      runtimeFollowable ? finishRuntimeReveal : undefined,
    )
    useLayoutEffect(() => {
      if (structurallyFollowable) return
      const root = hostRef.current
      if (root === null) return
      const mode = liveAgentTailMode(root)
      if (runtimeFollowable) {
        if (runtimePersistentRef.current && mode !== 'turn') {
          runtimePersistentRef.current = false
          runtimeHandledRef.current = true
          setRuntimeFollowable(false)
        }
        return
      }
      if (runtimeHandledRef.current || mode === null) return
      runtimePersistentRef.current = mode === 'turn'
      setRuntimeFollowable(true)
      setEntering(true)
    }, [runtimeFollowable, structurallyFollowable])
    const finishEntrance = useCallback(() => {
      growthExtentRef.current = null
      if (pulseTimerRef.current !== null) {
        clearTimeout(pulseTimerRef.current)
        pulseTimerRef.current = null
      }
      setEntering(false)
      setGrowthPulse(false)
    }, [])
    const onGrowth = useCallback((deltaPx: number) => {
      // A row with an explicit streaming lifecycle keeps its original owner
      // through completion. For every other Agent row, a pure layout increase
      // is enough evidence to glide it; renderer kind and payload shape are
      // intentionally irrelevant.
      if (
        !mountedRef.current
        || !followableRef.current
        || growingRef.current
        || entranceActiveRef.current
      ) return
      growthExtentRef.current = deltaPx
      setGrowthPulse(true)
      if (pulseTimerRef.current !== null) clearTimeout(pulseTimerRef.current)
      pulseTimerRef.current = setTimeout(() => {
        pulseTimerRef.current = null
        setGrowthPulse(false)
      }, 1200)
    }, [])
    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        if (pulseTimerRef.current !== null) clearTimeout(pulseTimerRef.current)
      }
    }, [])
    return (
      <FollowHost
        active={growing}
        entrance={entering || growthPulse}
        onEntranceSettled={finishEntrance}
        onGrowth={followable ? onGrowth : undefined}
        entranceExtentRef={growthExtentRef}
        speedCpsRef={speedCpsRef}
        // Generic Agent rows reveal and spring their measured growth, but do
        // not continuously reserve space for a future Markdown line wrap.
        // Keeping that assistant-only prediction here creates an idle gap
        // above TurnStatus and a visible return when a short Tool row settles.
        predictive={false}
        hostRef={hostRef}
      >
        {createElement(Inner, props)}
      </FollowHost>
    )
  }
}
