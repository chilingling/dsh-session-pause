/** Browser-side mirror of the host pause status and the actions that change it. */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseStatus, SessionPauseEntry } from '../host/types.ts'

/** A pause or resume request of the host or of one Session. */
export type PauseAction = 'pause' | 'resume' | 'pause-session' | 'resume-session'

/** What the pause surfaces render. */
export interface PauseView {
  /** Latest host status; `null` until the first status arrives or while the status stream has failed. */
  readonly status: PauseStatus | null
  /** Whether a pause or resume request is in flight. */
  readonly pending: boolean
  /** Message of the last failed request, cleared by the next request; `sessionId` names the Session of a Session request. */
  readonly failure: { readonly action: PauseAction; readonly sessionId?: SessionId; readonly message: string } | null
}

/** One delivered stream item; `accept()` confirms the baseline to the reconnecting stream. */
export interface StatusItem {
  readonly value: PauseStatus
  accept(): void
}

/** Host operations the controller drives. */
export interface PauseRemote {
  /** Reconnecting status stream. */
  readonly follow: AsyncIterable<StatusItem>
  pause(): Promise<RemoteResult<PauseStatus>>
  resume(): Promise<RemoteResult<PauseStatus>>
  pauseSession(sessionId: SessionId): Promise<RemoteResult<PauseStatus>>
  resumeSession(sessionId: SessionId): Promise<RemoteResult<PauseStatus>>
}

/** Snapshot source the slot renderer binds as a selector hook. */
export interface ViewSource<View> {
  getSnapshot(): View
  subscribe(listener: () => void): () => void
}

/** Source of the host-wide surfaces. */
export type PauseSource = ViewSource<PauseView>

/** What the Session surfaces render for one Session. */
export interface SessionPauseView {
  /** Whether a host status has arrived; `false` before the first status and while the status stream has failed. */
  readonly known: boolean
  /** The Session's own pause; `undefined` while it is not paused one by one. */
  readonly pause: SessionPauseEntry | undefined
  /** Number of the Session's own operations waiting for resume. */
  readonly held: number
  /** Whether any pause or resume request is in flight. */
  readonly pending: boolean
  /** Last failed request of this Session, cleared by the next request. */
  readonly failure: { readonly action: PauseAction; readonly message: string } | null
}

/** The mirror, its actions, and its teardown. */
export interface PauseController {
  readonly view: PauseSource
  /** Pause the host when it is not paused as a whole, otherwise resume it; ignored while a request is in flight or the status is unknown. */
  toggle(): void
  /** Resume the host; ignored while a request is in flight. */
  resume(): void
  /** Pause the Session when the status does not list it, otherwise resume it; ignored like {@link toggle}. */
  toggleSession(sessionId: SessionId): void
  /** Resume the Session; ignored while a request is in flight. */
  resumeSession(sessionId: SessionId): void
  /** Wait for the status observation to end after its stream is disposed. */
  readonly observing: Promise<void>
}

/**
 * Find the pause of one Session.
 * @param status - host status.
 * @param sessionId - Session to look up.
 * @returns the Session's own pause, or `undefined` when the status does not list it.
 */
export function sessionPauseOf(status: PauseStatus, sessionId: SessionId): SessionPauseEntry | undefined {
  return status.sessions.find(entry => entry.sessionId === sessionId)
}

/**
 * Derive the view of one Session. Its snapshot keeps its identity until the host view changes.
 * @param source - host-wide source.
 * @param sessionId - Session the view describes.
 * @returns the Session's source.
 */
export function sessionPauseSource(source: PauseSource, sessionId: SessionId): ViewSource<SessionPauseView> {
  let base: PauseView | undefined
  let derived!: SessionPauseView
  return {
    getSnapshot: () => {
      const view = source.getSnapshot()
      if (view === base) return derived
      base = view
      const failure = view.failure?.sessionId === sessionId ? view.failure : null
      derived = {
        known: view.status !== null,
        pause: view.status === null ? undefined : sessionPauseOf(view.status, sessionId),
        held: view.status?.held.filter(held => held.sessionId === sessionId).length ?? 0,
        pending: view.pending,
        failure: failure === null ? null : { action: failure.action, message: failure.message },
      }
      return derived
    },
    subscribe: listener => source.subscribe(listener),
  }
}

/**
 * Mirror the host status and serialize pause and resume requests.
 * @param remote - status stream and Remote actions of the `sessionPause` namespace.
 * @param warn - diagnostic sink for a status stream that ended with a failure.
 * @returns the controller; disposing `remote.follow` ends `observing`.
 */
export function createPauseController(remote: PauseRemote, warn: (message: string) => void): PauseController {
  let view: PauseView = { status: null, pending: false, failure: null }
  const listeners = new Set<() => void>()
  const publish = (next: Partial<PauseView>): void => {
    view = { ...view, ...next }
    for (const listener of [...listeners]) listener()
  }

  const observing = (async () => {
    try {
      for await (const item of remote.follow) {
        item.accept()
        publish({ status: item.value })
      }
    } catch (error: unknown) {
      warn(`session pause status stream failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    publish({ status: null })
  })()

  const request = (action: PauseAction, call: () => Promise<RemoteResult<PauseStatus>>, sessionId?: SessionId): void => {
    if (view.pending) return
    publish({ pending: true, failure: null })
    void (async () => {
      const result = await call()
      if (result.ok) publish({ pending: false, status: result.value })
      else publish({ pending: false, failure: { action, ...sessionId === undefined ? {} : { sessionId }, message: result.error.message } })
    })()
  }
  const pauseSession = (sessionId: SessionId): void => { request('pause-session', () => remote.pauseSession(sessionId), sessionId) }
  const resumeSession = (sessionId: SessionId): void => { request('resume-session', () => remote.resumeSession(sessionId), sessionId) }

  return {
    view: {
      getSnapshot: () => view,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    toggle: () => {
      if (view.status === null) return
      if (view.status.host === null) request('pause', () => remote.pause())
      else request('resume', () => remote.resume())
    },
    resume: () => { request('resume', () => remote.resume()) },
    toggleSession: (sessionId) => {
      if (view.status === null) return
      if (sessionPauseOf(view.status, sessionId) === undefined) pauseSession(sessionId)
      else resumeSession(sessionId)
    },
    resumeSession,
    observing,
  }
}
