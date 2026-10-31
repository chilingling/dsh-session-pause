/**
 * Pause status and request values shared by the host service, its Remote
 * contribution, and the browser bundle.
 * @module dsh-session-pause/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Where a held operation waits for resume. */
export type HoldPoint = 'pre-step' | 'request-error' | 'llm-stream'

/** One operation currently waiting for resume. */
export interface HeldOperation {
  /** Extension point the operation waits at. */
  readonly point: HoldPoint
  /** Session whose Agent owns the operation; absent for an `llm-stream` request that names no Session. */
  readonly sessionId?: SessionId
  /** ISO time the operation began waiting. */
  readonly since: string
}

/** Who requests a transition, and why. */
export interface PauseRequest {
  /** Caller label recorded with the pause, such as `command` or `web`. */
  readonly source: string
  /** Free-form note recorded with the pause. */
  readonly reason?: string
}

/** One pause in effect: when it began and the request that began it. */
export interface PauseEntry {
  /** ISO time the pause began. */
  readonly since: string
  /** Caller label of the request that began the pause. */
  readonly source: string
  /** Note of the request that began the pause. */
  readonly reason?: string
}

/** The pause of one Session; it also holds the subagents that Session started. */
export interface SessionPauseEntry extends PauseEntry {
  /** The paused Session. */
  readonly sessionId: SessionId
}

/** Current pauses with the operations they hold. The host-wide pause and each Session pause begin and end independently. */
export interface PauseStatus {
  /** Host-wide pause, or `null` while the host as a whole is not paused. */
  readonly host: PauseEntry | null
  /** Sessions paused one by one, in the order they were paused. */
  readonly sessions: readonly SessionPauseEntry[]
  /** Operations waiting for resume, oldest first. */
  readonly held: readonly HeldOperation[]
}
