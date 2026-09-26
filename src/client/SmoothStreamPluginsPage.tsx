/**
 * dsh-smooth-stream client — the sidebar Plugins page face (dsh 0.1.7).
 *
 * 0.1.5 keeps a plugin's configuration in Settings → Plugins → Plugin
 * configuration, through the `settings.plugin.item` slot. 0.1.7 moved those
 * pages out of Settings: the sidebar's **Plugins** panel
 * (`dsh-client-ui-plugin-manager`) owns them now, through the `plugins.item`
 * list slot. The page asks one entry for two views:
 *
 * - `view: 'summary'` — the one-liner printed under the entry's title in the
 *   "official" group and again above the form on its page. The entry must
 *   return text, not null, or the card falls back to the package description.
 * - `view: 'page'` — the whole configuration, rendered once that card is
 *   opened. The page host draws the title, icon and breadcrumb itself, so the
 *   card arrives in its `page` variant.
 *
 * Both views are the same component the 0.1.5 card uses, so the switches have
 * exactly one implementation and one place to drift.
 */

import type { ReactElement } from 'react'

import { SmoothStreamCard, type SmoothStreamCardProps } from './SmoothStreamCard.tsx'
import { en, zh, type SmoothStreamLocaleKey } from './locales.ts'

/** Props the renderer binds for an entry of the sidebar Plugins page. */
export interface SmoothStreamPluginsPageProps extends SmoothStreamCardProps {
  /** Which face the Plugins page is asking for. */
  view?: 'summary' | 'page' | string
}

/**
 * Locale reader for the no-framework path: the offline verifier renders this
 * component directly, and the slot binding supplies `t` everywhere else.
 */
function fallbackTranslator(key: SmoothStreamLocaleKey): string {
  const englishDocument = typeof document !== 'undefined'
    && document.documentElement.lang.toLowerCase().startsWith('en')
  return (englishDocument ? en : zh)[key]
}

/**
 * Render the face the Plugins page asked for.
 *
 * Never throws: an unknown `view` is treated as `page`, the face that carries
 * the switches — showing them is strictly better than showing nothing.
 */
export function SmoothStreamPluginsPage(props: SmoothStreamPluginsPageProps): ReactElement {
  if (props.view === 'summary') {
    const t = typeof props.t === 'function' ? props.t : fallbackTranslator
    return <>{t('description')}</>
  }
  return <SmoothStreamCard {...props} variant="page" />
}
