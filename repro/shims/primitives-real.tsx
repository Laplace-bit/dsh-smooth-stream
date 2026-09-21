/**
 * Real Host primitives for the measurement rig.
 *
 * `repro/shims/primitives.tsx` stubs MarkdownText down to a plain <div> of raw
 * text, which makes every "120 FPS" number produced by that rig meaningless for
 * the streaming path: the per-frame Markdown parse and React commit under test
 * in the real app simply did not exist in those runs. This shim re-exports the
 * SHIPPED @deepseek-ai/dsh-client-ui-primitives so the rig measures the same
 * renderer the desktop client runs.
 */
export {
  IconChevronDownOutline14,
  IconRefreshOutline14,
  IconRefreshOutline16,
  IconQuestionOutline14,
  IconThinkOutline14,
  JsonBlock,
  MarkdownText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
