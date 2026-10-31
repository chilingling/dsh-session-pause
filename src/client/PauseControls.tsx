/** Host-wide pause surfaces (sidebar button, status pill) and Session pause surfaces (composer button, dock strip). */

import type { ReactNode } from 'react'
import {
  IconPauseOutlineMedium, IconPauseOutlineRegular, IconPlayOutlineMedium, IconPlayOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PauseSource, SessionPauseView, ViewSource } from './controller.ts'
import css from './PauseControls.module.css'

/** Status source and actions injected into both surfaces. */
export interface PauseInjected {
  readonly hooks: {
    /** Latest host status, request state, and last failure. */
    readonly pause: PauseSource
  }
  readonly toggle: () => void
  readonly resume: () => void
}

/** Props of the sidebar footer button. */
export type PauseButtonProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<PauseInjected> & PropsLocale<'sessionPause'>

/** Props of the overlay pill. */
export type PausePillProps = InjectFace<PauseInjected> & PropsLocale<'sessionPause'>

/** Session view and actions bound to the Session a surface renders for. */
export interface SessionPauseInjected {
  readonly hooks: {
    /** This Session's pause, held count, request state, and last failure. */
    readonly sessionPause: ViewSource<SessionPauseView>
  }
  /** Pause this Session when it is not paused one by one, otherwise resume it. */
  readonly toggleSession: () => void
  /** Resume this Session. */
  readonly resumeSession: () => void
}

/** Props of the composer toolbar button. */
export type SessionPauseButtonProps = PropsRuntime<'conversation.input.right'> & InjectFace<SessionPauseInjected> & PropsLocale<'sessionPause'>

/** Props of the dock strip above the composer. */
export type SessionPauseDockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<SessionPauseInjected> & PropsLocale<'sessionPause'>

const classes = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(' ')

/**
 * Pause every session with one click, or resume them once paused.
 * @param props - sidebar width, status hook, toggle action, and copy.
 * @returns the footer row above Settings.
 */
export function PauseButton({ wide, usePause, toggle, t }: PauseButtonProps): ReactNode {
  const status = usePause(view => view.status)
  const pending = usePause(view => view.pending)
  const paused = status !== null && status.host !== null
  const label = status === null ? t('unavailable') : paused ? t('resume') : t('pause')
  const hint = status === null ? t('unavailable') : paused ? t('resume.hint') : t('pause.hint')
  const Icon = paused ? IconPlayOutlineMedium : IconPauseOutlineMedium
  return (
    <div className={classes(css.row, !wide && css.rail)}>
      <Tooltip label={hint}>
        <button
          type="button"
          className={classes(css.trigger, !wide && css.rail, paused && css.paused)}
          aria-label={label}
          aria-pressed={paused}
          disabled={status === null || pending}
          onClick={toggle}
        >
          <Icon size={wide ? 16 : 18} />
          {wide && <span className={css.label}>{label}</span>}
        </button>
      </Tooltip>
    </div>
  )
}

/**
 * Show that the host is paused, how long, and how much waits, with a resume action.
 * @param props - status hook, resume action, and copy.
 * @returns the pill while paused or while a request failed, otherwise nothing.
 */
export function PausePill({ usePause, resume, t }: PausePillProps): ReactNode {
  const view = usePause(current => current)
  const failure = view.failure === null || view.failure.sessionId !== undefined
    ? undefined
    : t(`error.${view.failure.action}`, { message: view.failure.message })
  const host = view.status?.host ?? null
  if (view.status === null || host === null) {
    return failure === undefined ? null : <div className={css.pill} role="alert"><span className={css.pillError}>{failure}</span></div>
  }
  const meta = describePause(t, host.since, view.status.held.length, host.reason)
  return (
    <div className={css.pill} role="status" aria-live="polite">
      <span className={css.pillIcon}><IconPauseOutlineMedium size={16} /></span>
      <span className={css.pillTitle}>{t('banner.title')}</span>
      <span className={css.pillMeta}>{meta}</span>
      {failure !== undefined && <span className={css.pillError}>{failure}</span>}
      <button type="button" className={css.pillAction} disabled={view.pending} onClick={resume}>
        {t('banner.resume')}
      </button>
    </div>
  )
}

/**
 * Pause or resume the Session in view, together with the subagents it starts.
 * @param props - Session view hook, toggle action, and copy.
 * @returns the toolbar icon button.
 */
export function SessionPauseButton({ useSessionPause, toggleSession, t }: SessionPauseButtonProps): ReactNode {
  const known = useSessionPause(view => view.known)
  const paused = useSessionPause(view => view.pause !== undefined)
  const pending = useSessionPause(view => view.pending)
  const label = !known ? t('unavailable') : paused ? t('session.resume') : t('session.pause')
  const hint = !known ? t('unavailable') : paused ? t('session.resume') : t('session.pause.hint')
  const Icon = paused ? IconPlayOutlineRegular : IconPauseOutlineRegular
  return (
    <Tooltip label={hint} side="top" delayMs={500}>
      <button
        type="button"
        className={classes(css.toolbarButton, paused && css.paused)}
        aria-label={label}
        aria-pressed={paused}
        disabled={!known || pending}
        onMouseDown={keepFocus}
        onClick={toggleSession}
      >
        <Icon size={14} />
      </button>
    </Tooltip>
  )
}

/**
 * Show that the Session in view is paused one by one, with a resume action.
 * @param props - Session view hook, resume action, and copy.
 * @returns the strip while the Session is paused or its last request failed, otherwise nothing.
 */
export function SessionPauseDock({ useSessionPause, resumeSession, t }: SessionPauseDockProps): ReactNode {
  const view = useSessionPause(current => current)
  const failure = view.failure === null ? undefined : t(`error.${view.failure.action}`, { message: view.failure.message })
  if (view.pause === undefined && failure === undefined) return null
  return (
    <div className={css.dock}>
      <div className={css.dockBar} role={view.pause === undefined ? 'alert' : 'status'}>
        <span className={css.dockGlyph}><IconPauseOutlineRegular size={14} /></span>
        {view.pause !== undefined && <span className={css.dockTitle}>{t('dock.title')}</span>}
        {view.pause !== undefined && (
          <span className={css.dockMeta}>{describePause(t, view.pause.since, view.held, view.pause.reason)}</span>
        )}
        {failure !== undefined && <span className={css.dockError}>{failure}</span>}
        {view.pause !== undefined && (
          <button type="button" className={css.dockAction} disabled={view.pending} onClick={resumeSession}>
            {t('banner.resume')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Keep the composer editor focused when a toolbar button is pressed. */
function keepFocus(event: { preventDefault(): void }): void {
  event.preventDefault()
}

function describePause(t: PausePillProps['t'], since: string, held: number, reason: string | undefined): string {
  const time = new Date(since).toLocaleTimeString(t('locale'), { hour: '2-digit', minute: '2-digit' })
  return [t('banner.since', { time }), t('banner.held', { count: String(held) }), reason]
    .filter(part => part !== undefined && part !== '')
    .join(' · ')
}
