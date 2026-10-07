/** Reuse the settings controls inside the sidebar's bundle detail page. */
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

/** Render the expanded form; the Harness page supplies its own heading. */
export function SmoothStreamPluginsPage(props: SmoothStreamPluginsPageProps): ReactElement {
  if (props.view === 'summary') {
    const t = typeof props.t === 'function' ? props.t : fallbackTranslator
    return <>{t('description')}</>
  }
  return <SmoothStreamCard {...props} variant="page" />
}
