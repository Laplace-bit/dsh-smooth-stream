/**
 * The smooth-stream plugin configuration card, rendered inside the Web
 * Settings "plugin configuration" page. One toggle, staged until the user
 * saves — the same shape as the Host-shipped cards, hand-drawn because the
 * Host cards' chrome is not exported for reuse.
 */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { IconChevronDownOutline14, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SmoothStreamCardFace } from './smooth-stream-card-controller.ts'
import css from './SmoothStreamCard.module.css'

/** Props the renderer binds for the smooth-stream card. */
export type SmoothStreamCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.smoothStream'>
  & InjectFace<SmoothStreamCardFace>

/** Render the smooth-stream card independently of the core settings namespace allowlist. */
export function SmoothStreamCard(props: SmoothStreamCardProps) {
  const { t } = props
  const [open, setOpen] = useState(false)
  const state = props.useSmoothStreamCard(snapshot => snapshot)
  const blocked = !state.dirty || state.saving || state.status !== 'ready'
  const versionLabel = state.version === undefined
    ? null
    : t(state.installation === 'development' ? 'developmentVersion' : 'version')
      .replace('{version}', state.version)

  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('title')}</span>
          <span className={css.description}>{t('description')}</span>
        </span>
        {versionLabel === null ? null : <span className={css.version}>{versionLabel}</span>}
        {state.dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
        <IconChevronDownOutline14 className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {state.status === 'loading' ? <p className={css.readOnly} role="status">{t('loading')}</p> : null}
            {state.status === 'unavailable' ? (
              <div className={css.failure}>
                <p className={css.readOnly} role="status">{t('unavailable')}</p>
                <button type="button" className={css.discard} onClick={props.reload}>{t('retry')}</button>
              </div>
            ) : null}
            {state.status === 'ready' ? (
              <>
                {!state.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
                <label className={css.field}>
                  <span className={css.fieldHead}>
                    <span className={css.label}>{t('thinkAutoExpand')}</span>
                    <input
                      type="checkbox"
                      className={css.toggle}
                      checked={state.thinkAutoExpand}
                      disabled={!state.writable}
                      onChange={(event) => { props.edit(event.target.checked) }}
                    />
                  </span>
                  <span className={css.hint}>{t('thinkAutoExpandHint')}</span>
                </label>
                <div className={css.updateRow}>
                  <span className={css.updateCopy}>
                    <span className={css.label}>{t('updates')}</span>
                    <span className={css.hint}>
                      {state.restartRequired
                        ? t('restartRequired')
                        : state.installation === 'npm' ? t('updateHint')
                          : state.installation === 'development' ? t('developmentBuild') : t('updateUnavailable')}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={css.update}
                    disabled={!state.canUpgrade || state.upgrading || state.restartRequired}
                    title={state.canUpgrade ? undefined : t('updateUnavailable')}
                    onClick={props.upgrade}
                  >
                    <span aria-hidden="true"><IconRefreshOutline14 /></span>
                    {t(state.upgrading ? 'updating' : 'update')}
                  </button>
                </div>
                {state.upgradeFailed ? <p className={css.failed} role="status">{t('updateFailed')}</p> : null}
                <div className={css.footer}>
                  {state.failed ? <p className={css.failed} role="status">{t('saveFailed')}</p> : null}
                  <button
                    type="button"
                    className={css.discard}
                    disabled={!state.dirty || state.saving}
                    onClick={props.discard}
                  >
                    {t('discard')}
                  </button>
                  <button
                    type="button"
                    className={css.save}
                    disabled={blocked}
                    onClick={props.save}
                  >
                    {t(state.saving ? 'saving' : 'save')}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )
        : null}
    </li>
  )
}
