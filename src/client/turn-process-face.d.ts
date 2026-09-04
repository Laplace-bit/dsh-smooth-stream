/**
 * Turn-process fold face for the DSH 0.1.2 completion-collapse contract.
 *
 * The Host seat hands every keyed Chat renderer a `turnProcess` owner prop
 * when the node belongs to a projected Turn: the fold decision lives in the
 * conversation snapshot (turn closed + compact transcript), and the renderer
 * is expected to hide its answer-inline reasoning while folded. The pinned
 * type-only dependency predates the field, so the face is declared here and
 * merged into the owner-props interface; erases at compile time.
 */
export interface TurnProcessOwnerFace {
  /** Answer anchor of the projection; null while the answer has not landed. */
  readonly spec: { readonly answerStep: number | null, readonly inlineReasoning: boolean }
  /** Whether this node's process content may fold (turn closed + compact mode). */
  readonly foldable: boolean
  /** Current fold state, persisted by the Host across sessions. */
  readonly open: boolean
  /** Fold or unfold from the renderer side (summary click, find-in-page reveal). */
  setOpen(open: boolean): void
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeOwnerProps {
    /** Present only when the node belongs to a projected Turn (0.1.2+). */
    turnProcess?: TurnProcessOwnerFace | undefined
  }
}
