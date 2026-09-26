import { createElement, type ComponentType } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

type IconProps = {
  className?: string | undefined
  size?: number | undefined
  strokeWidth?: number | undefined
}
type IconExports = Record<string, ComponentType<IconProps> | undefined>

// Harness renamed size-suffixed icon exports to weight-suffixed names. Resolve
// at runtime so this plugin bundle works with both the older published
// primitive package used for development and current Harness module tables.
const icons = primitives as unknown as IconExports

/** True for anything React can render as an element type. */
function isRenderable(value: unknown): value is ComponentType<IconProps> {
  return typeof value === 'function'
    || (typeof value === 'object' && value !== null && '$$typeof' in (value as object))
}

/**
 * Neutral 14px placeholder, used only when a build ships none of the probed
 * icon names.
 *
 * Rendering a placeholder keeps the surrounding chrome intact; handing React
 * `undefined` instead throws minified error #130, and inside a slot entry that
 * throw *abdicates* the entry — the outlet falls back to the kernel's own
 * renderer, so the plugin keeps loading while its streaming takeover silently
 * disappears.
 */
function PlaceholderIcon({ className, size = 14 }: IconProps) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': true,
      className,
    },
    createElement('circle', { cx: 8, cy: 8, r: 2.25, stroke: 'currentColor', strokeWidth: 1.2 }),
  )
}

/** Weight-variant suffixes the newer icon generation appends to a base name. */
const MODERN_WEIGHTS = ['Medium', 'Regular', 'Artwork'] as const

/**
 * Resolve the first spelling of one glyph this build actually exports.
 *
 * The weight variants are probed before the size-suffixed legacy name because a
 * build ships one generation or the other, and `Medium` comes first among them
 * as the weight the newer kernel's own 14/16px chrome uses. The bare base name
 * is the last resort for a future rename, and the placeholder keeps a missing
 * export from turning into a React crash.
 * @param baseName - Export base name, e.g. `IconThinkOutline`.
 * @param legacyName - Size-suffixed spelling the older package ships.
 * @returns A renderable icon component; never `undefined`.
 */
function resolveIcon(baseName: string, legacyName: string): ComponentType<IconProps> {
  for (const name of [...MODERN_WEIGHTS.map(weight => `${baseName}${weight}`), legacyName, baseName]) {
    const icon = icons[name]
    if (isRenderable(icon)) return icon
  }
  return PlaceholderIcon
}

export const IconChevronDown = resolveIcon('IconChevronDownOutline', 'IconChevronDownOutline14')
export const IconClose = resolveIcon('IconCloseOutline', 'IconCloseOutline16')
export const IconCode = resolveIcon('IconCodeOutline', 'IconCodeOutline16')
export const IconCopy = resolveIcon('IconCopyOutline', 'IconCopyOutline16')
export const IconQuestion = resolveIcon('IconQuestionOutline', 'IconQuestionOutline14')
export const IconRefresh = resolveIcon('IconRefreshOutline', 'IconRefreshOutline14')
export const IconRefreshSmall = resolveIcon('IconRefreshOutline', 'IconRefreshOutline16')
export const IconThink = resolveIcon('IconThinkOutline', 'IconThinkOutline14')
