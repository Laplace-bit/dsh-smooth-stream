/**
 * Cross-generation access to the client primitive packages.
 *
 * Why this exists instead of plain named imports: a named import the serving
 * kernel no longer exports is simply `undefined` at runtime. React throws
 * minified error #130 ("Element type is invalid … got: undefined") the moment
 * such a value is rendered, and inside a slot entry that crash *abdicates* the
 * entry: the outlet re-renders onto the next survivor — the kernel's own
 * assistant renderer — so the plugin keeps loading, its styles stay injected,
 * its settings channel stays reachable, and yet the streaming takeover silently
 * disappears. That is the "Web half loaded but nothing changes" symptom.
 *
 * Icons live in `harnessIcons.ts`, which probes the same way for the renamed
 * glyph exports. What remains here is the block renderers and the clipboard
 * helper the takeover renders itself, each read out of the module table and
 * given a safe stand-in when this build does not ship it.
 */

import type { ComponentType } from 'react'
import * as attachmentModule from '@deepseek-ai/dsh-client-ui-attachment'
import * as primitivesModule from '@deepseek-ai/dsh-client-ui-primitives'

type Primitives = typeof import('@deepseek-ai/dsh-client-ui-primitives')
type Attachment = typeof import('@deepseek-ai/dsh-client-ui-attachment')

/** Runtime view over one client module table entry. */
type ModuleTable = Record<string, unknown>

const primitives = primitivesModule as unknown as ModuleTable
const attachment = attachmentModule as unknown as ModuleTable

/** True for anything React can render as an element type. */
function isRenderable(value: unknown): value is ComponentType<never> {
  return typeof value === 'function'
    || (typeof value === 'object' && value !== null && '$$typeof' in (value as object))
}

/** Read one primitive, `undefined` when this build does not export it. */
function primitive(name: string): unknown {
  return primitives[name]
}

/**
 * Plain-text stand-in for the markdown renderer. Only reachable on a build
 * that ships no `MarkdownText` at all, where the takeover is skipped anyway
 * (see {@link markdownAvailable}) — it exists so a stray render degrades to
 * text instead of throwing.
 */
function PlainTextFallback({ text }: { readonly text?: string }) {
  return <div>{text ?? ''}</div>
}

/** Stand-in for an optional block renderer: render nothing, never throw. */
function NullBlock(): null {
  return null
}

/** Pass-through stand-in for `Tooltip`: keep the trigger, drop the chrome. */
function PassthroughTooltip({ children }: { readonly children?: unknown }) {
  return <>{children as never}</>
}

/** Whether this build ships the real markdown renderer the takeover needs. */
export const markdownAvailable = isRenderable(primitive('MarkdownText'))

export const MarkdownText = (
  markdownAvailable ? primitive('MarkdownText') : PlainTextFallback
) as Primitives['MarkdownText']

export const JsonBlock = (
  isRenderable(primitive('JsonBlock')) ? primitive('JsonBlock') : NullBlock
) as unknown as Primitives['JsonBlock']

export const Tooltip = (
  isRenderable(primitive('Tooltip')) ? primitive('Tooltip') : PassthroughTooltip
) as unknown as Primitives['Tooltip']

export const ImageGallery = (
  isRenderable(attachment.ImageGallery) ? attachment.ImageGallery : NullBlock
) as unknown as Attachment['ImageGallery']

/** Clipboard write with a `navigator.clipboard` fallback for older shapes. */
async function fallbackWriteClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export const writeClipboard = (
  typeof primitive('writeClipboard') === 'function'
    ? primitive('writeClipboard')
    : fallbackWriteClipboard
) as Primitives['writeClipboard']
