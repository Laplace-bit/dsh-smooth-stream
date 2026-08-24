import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  IconCloseOutline16,
  IconCodeOutline16,
  IconCopyOutline16,
  IconQuestionOutline14,
  IconRefreshOutline16,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StreamDebugTuning } from '../settings.ts'
import type { DebugPanelFace, DebugRuntimeState } from './debugRuntime.ts'
import type { NS } from './locales.ts'
import css from './DebugPanel.module.css'

export type DebugPanelProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<DebugPanelFace>

type TuningKey = keyof StreamDebugTuning

interface TuningControl {
  key: TuningKey
  label: Parameters<DebugPanelProps['t']>[0]
  tip: Parameters<DebugPanelProps['t']>[0]
  min: number
  max: number
  step: number
  unit: string
}

const REVEAL_CONTROLS: readonly TuningControl[] = [
  { key: 'revealScale', label: 'debugRevealMultiplier', tip: 'debugTipRevealMultiplier', min: 0.25, max: 2, step: 0.05, unit: 'x' },
  { key: 'queuePressure', label: 'debugQueuePressure', tip: 'debugTipQueuePressure', min: 0, max: 2, step: 0.05, unit: 'x' },
  { key: 'maxRevealCps', label: 'debugMaxReveal', tip: 'debugTipMaxReveal', min: 120, max: 1000, step: 10, unit: 'cps' },
]

const FOLLOW_CONTROLS: readonly TuningControl[] = [
  { key: 'springStiffness', label: 'debugSpringStiffness', tip: 'debugTipSpringStiffness', min: 40, max: 320, step: 5, unit: '' },
  { key: 'springDamping', label: 'debugSpringDamping', tip: 'debugTipSpringDamping', min: 8, max: 80, step: 1, unit: '' },
  { key: 'springMass', label: 'debugSpringMass', tip: 'debugTipSpringMass', min: 0.5, max: 3, step: 0.05, unit: '' },
  { key: 'runwayPx', label: 'debugRunway', tip: 'debugTipRunway', min: 0, max: 120, step: 2, unit: 'px' },
  { key: 'reserveResponseMs', label: 'debugReserveResponse', tip: 'debugTipReserveResponse', min: 60, max: 600, step: 10, unit: 'ms' },
  { key: 'backpressureMinScale', label: 'debugBackpressureMin', tip: 'debugTipBackpressureMin', min: 0.25, max: 1, step: 0.05, unit: 'x' },
]

function fixed(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? '-' : value.toFixed(digits)
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | undefined }) {
  return (
    <div className={css.metric}>
      <dt>{label}</dt>
      <dd data-tone={tone}>{value}</dd>
    </div>
  )
}

function TuningField({
  control,
  state,
  edit,
  label,
  t,
}: {
  control: TuningControl
  state: DebugRuntimeState
  edit: DebugPanelFace['edit']
  label: string
  t: DebugPanelProps['t']
}) {
  const value = state.tuning[control.key]
  const labelId = `smooth-stream-debug-${control.key}`
  const update = (next: number) => {
    if (!Number.isFinite(next)) return
    const clamped = Math.min(control.max, Math.max(control.min, next))
    edit({ debugTuning: { ...state.tuning, [control.key]: clamped } })
  }
  return (
    <div className={css.control}>
      <span className={css.controlHead}>
        <span className={css.controlLabel}>
          <span id={labelId}>{label}</span>
          <Tooltip label={t(control.tip)} side="right" maxWidth={300}>
            <button
              className={css.infoButton}
              type="button"
              aria-label={label}
              title={t(control.tip)}
            >
              <IconQuestionOutline14 />
            </button>
          </Tooltip>
        </span>
        <span className={css.numberWrap}>
          <input
            className={css.number}
            type="number"
            aria-labelledby={labelId}
            min={control.min}
            max={control.max}
            step={control.step}
            value={value}
            disabled={!state.writable}
            onChange={event => { update(event.currentTarget.valueAsNumber) }}
          />
          {control.unit === '' ? null : <span className={css.unit}>{control.unit}</span>}
        </span>
      </span>
      <input
        className={css.range}
        type="range"
        aria-labelledby={labelId}
        min={control.min}
        max={control.max}
        step={control.step}
        value={value}
        disabled={!state.writable}
        onChange={event => { update(event.currentTarget.valueAsNumber) }}
      />
    </div>
  )
}

export function DebugPanel(props: DebugPanelProps) {
  const { t } = props
  const state = props.useDebugRuntime(snapshot => snapshot)
  const [open, setOpen] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => { setCopied(false) }, 1400)
    return () => { clearTimeout(timer) }
  }, [copied])

  useEffect(() => {
    if (state.enabled) setOpen(true)
  }, [state.enabled])

  if (!state.available || !state.enabled || !open) return null
  const metrics = state.metrics
  const live = metrics.streamActive || metrics.followActive
  const progress = metrics.streamTargetChars <= 0
    ? '-'
    : `${String(metrics.streamDisplayedChars)} / ${String(metrics.streamTargetChars)}`
  const copyDiagnostics = async () => {
    const accepted = await writeClipboard(JSON.stringify({
      tuning: state.tuning,
      metrics: state.metrics,
    }, null, 2))
    if (accepted) setCopied(true)
  }

  const panel = !state.enabled || !open ? null : (
    <aside className={css.panel} role="complementary" aria-label={t('debugPanelTitle')}>
      <header className={css.panelHeader}>
        <span className={live ? `${css.statusDot} ${css.statusLive}` : css.statusDot} aria-hidden />
        <span className={css.title}>{t('debugPanelTitle')}</span>
        <span className={css.state}>{t(live ? 'debugLive' : 'debugIdle')}</span>
        {state.dirty ? <span className={css.unsaved}>{t('debugUnsaved')}</span> : null}
        <button className={css.iconButton} type="button" title={t('debugCopy')} aria-label={t('debugCopy')} onClick={() => { void copyDiagnostics() }}>
          <IconCopyOutline16 />
        </button>
        <button
          className={css.iconButton}
          type="button"
          title={t('debugPanelClose')}
          aria-label={t('debugPanelClose')}
          disabled={!state.writable}
          onClick={() => {
            setOpen(false)
            props.edit({ debugEnabled: false })
            props.save()
          }}
        >
          <IconCloseOutline16 />
        </button>
        <span className={css.visuallyHidden} aria-live="polite">{copied ? t('debugCopied') : ''}</span>
      </header>

      <div className={css.scrollArea}>
        <p className={css.guide}>{t('debugGuide')}</p>
        <section className={css.section} aria-labelledby="smooth-stream-live-heading">
          <h2 id="smooth-stream-live-heading">{t('debugSectionLive')}</h2>
          <dl className={css.metrics}>
            <Metric label={t('debugFps')} value={fixed(metrics.fps, 0)} tone={(metrics.fps ?? 60) < 45 ? 'warn' : 'good'} />
            <Metric label={t('debugFrameTime')} value={`${fixed(metrics.frameMs)} ms`} />
            <Metric label={t('debugBacklog')} value={String(metrics.streamBacklog)} tone={metrics.streamBacklog > 32 ? 'warn' : undefined} />
            <Metric label={t('debugRevealSpeed')} value={`${fixed(metrics.streamSpeedCps, 0)} cps`} />
            <Metric label={t('debugProgress')} value={progress} />
            <Metric label={t('debugFollowState')} value={t(metrics.followFollowing ? 'debugFollowing' : 'debugReleased')} />
            <Metric label={t('debugLag')} value={`${fixed(metrics.followLagPx)} px`} tone={metrics.followConstrained ? 'warn' : undefined} />
            <Metric label={t('debugVelocity')} value={`${fixed(metrics.followVelocityPxPerSec, 0)} px/s`} />
            <Metric label={t('debugReserve')} value={`${fixed(metrics.followReservePx)} px`} />
            <Metric label={t('debugCapacity')} value={`${fixed(metrics.followCapacityPx)} px`} />
            <Metric label={t('debugAppliedScale')} value={`${fixed(metrics.followRevealScale, 2)}x`} />
          </dl>
        </section>

        <section className={css.section} aria-labelledby="smooth-stream-reveal-heading">
          <h2 id="smooth-stream-reveal-heading">{t('debugSectionReveal')}</h2>
          {REVEAL_CONTROLS.map(control => (
            <TuningField key={control.key} control={control} state={state} edit={props.edit} label={t(control.label)} t={t} />
          ))}
        </section>

        <section className={css.section} aria-labelledby="smooth-stream-follow-heading">
          <h2 id="smooth-stream-follow-heading">{t('debugSectionFollow')}</h2>
          {FOLLOW_CONTROLS.map(control => (
            <TuningField key={control.key} control={control} state={state} edit={props.edit} label={t(control.label)} t={t} />
          ))}
        </section>
      </div>

      <footer className={css.footer}>
        <button className={css.secondaryButton} type="button" disabled={!state.writable} onClick={props.reset}>
          <IconRefreshOutline16 />
          {t('debugReset')}
        </button>
        <span className={css.footerSpacer} />
        <button className={css.secondaryButton} type="button" disabled={!state.writable || !state.dirty} onClick={props.discard}>{t('debugDiscard')}</button>
        <button className={css.primaryButton} type="button" disabled={!state.writable || !state.dirty} onClick={props.save}>{t('debugSave')}</button>
      </footer>
    </aside>
  )

  return (
    <>
      <button
        type="button"
        className={state.enabled && open ? `${css.trigger} ${css.triggerActive}` : css.trigger}
        aria-expanded={state.enabled && open}
        aria-label={t('debugPanelToggle')}
        title={t('debugPanelToggle')}
        onClick={() => { setOpen(current => !current) }}
      >
        <IconCodeOutline16 />
      </button>
      {typeof document === 'undefined' || panel === null ? null : createPortal(panel, document.body)}
    </>
  )
}
