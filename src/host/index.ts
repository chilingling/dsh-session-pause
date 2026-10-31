/**
 * Host-wide and per-Session pause of model activity for DeepSeek Harness.
 *
 * While the host is paused, every Agent on the host — main Sessions,
 * subagents, goal rounds, and turns woken by schedules or job notices — waits
 * before its next step instead of being cancelled. A Session pause holds the
 * same way only that Session and the subagents it started. Running model
 * streams and tools settle normally, and each held Agent continues its turn
 * once no pause covers it.
 *
 * @module dsh-session-pause
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { registerCommands } from './commands.ts'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { HeldOperation, PauseEntry, PauseRequest, PauseStatus } from './types.ts'
import { readPauseRecord, RUNNING, writePauseRecord, type PauseRecord } from './state-file.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPause: SessionPause
  }
  interface Events {
    /**
     * The host-wide pause or a Session pause began or ended; emitted after the transition is persisted.
     * @param status - status right after the transition.
     * @mode emit
     */
    'session-pause/changed'(status: PauseStatus): void
  }
}

interface Hold {
  readonly operation: HeldOperation
  release(resumed: boolean): void
}

/** Plugin configuration. */
export interface Config {
  /** JSON file holding the pause across host restarts; omission keeps the pause in this process only. */
  stateFile?: string
}

/**
 * The `ctx.sessionPause` service: owns the host-wide pause and the Session
 * pauses, holds Agent work at its extension points while a pause covers it,
 * and serves `pause`, `resume`, `pauseSession`, `resumeSession`, `status`, and
 * `follow` as Remote methods of the `sessionPause` namespace.
 */
export class SessionPause extends TypertRemoteService {
  static Config: z<Config> = z.object({
    stateFile: z.string()
      .description('JSON file holding the pause across host restarts; omit to keep the pause in this process only.'),
  })

  private record: PauseRecord
  private readonly holds = new Set<Hold>()
  private transitions: Promise<unknown> = Promise.resolve()
  private readonly observers = new Set<() => void>()
  private disposed = false

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'sessionPause')
    // Read before any listener runs, so a restarted host never steps before it knows it is paused.
    this.record = config.stateFile === undefined ? RUNNING : readPauseRecord(config.stateFile)
    ctx.on('agent/pre-step', async (payload, next) => {
      if (!this.covers(payload.agent.id)) return next()
      const resumed = await this.waitForResume(payload.signal, { point: 'pre-step', sessionId: payload.agent.id })
      // A cancelled wait returns without delegating; the loop then observes its aborted signal.
      return resumed ? next() : { kind: 'reject' }
    })
    // Ahead of dsh-llm-retry: a failure during the pause is retried at resume
    // without backoff and without counting against the provider's retry budget.
    ctx.on('agent/request-error', async (payload, next) => {
      if (!this.covers(payload.agent.id)) return next()
      const resumed = await this.waitForResume(payload.signal, { point: 'request-error', sessionId: payload.agent.id })
      return resumed ? { kind: 'retry' } : undefined
    }, { prepend: true })
    // Outermost, so no stream wrapper's own timers run while the call waits.
    ctx.on('llm/stream', (options, next) => this.covers(options.sessionId) ? this.heldStream(options, next) : next(), { prepend: true })
    // Unloading the plugin removes the pause: held work proceeds rather than waiting on listeners that are gone.
    ctx.effect(() => () => {
      this.disposed = true
      for (const hold of [...this.holds]) hold.release(true)
      this.notify()
    }, 'session-pause.release-holds')
    ctx.inject(['commands'], (commandsCtx) => { registerCommands(commandsCtx, this) })
  }

  private async * heldStream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const signal = options.signal ?? new AbortController().signal
    const operation = options.sessionId === undefined ? { point: 'llm-stream' as const } : { point: 'llm-stream' as const, sessionId: options.sessionId }
    if (!await this.waitForResume(signal, operation)) throw signal.reason
    yield * next()
  }

  /**
   * Whether a pause covers work of this Session: the host-wide pause, or a
   * pause of the Session or of a Session that started it as a subagent.
   */
  private covers(sessionId: SessionId | undefined): boolean {
    if (this.record.host !== null) return true
    if (sessionId === undefined || this.record.sessions.length === 0) return false
    const paused = new Set(this.record.sessions.map(entry => entry.sessionId))
    const agents = this.ctx.get('agents')
    // Lineage is read from live Agents; a parent whose Agent is gone ends the walk.
    for (let current: SessionId | undefined = sessionId; current !== undefined;) {
      if (paused.has(current)) return true
      const header: SessionHeader | undefined = agents?.get(current)?.session.header
      current = header?.origin === 'subagent' ? header.parentSession : undefined
    }
    return false
  }

  /**
   * Pause every Session on the host. Pausing an already paused host keeps its original start time and note.
   * @param request - caller label and note recorded with a new pause.
   * @returns the status after the call.
   * @throws when the state file cannot be written; the host then stays as it was.
   */
  @Remote('pause')
  pause(request: PauseRequest): Promise<PauseStatus> {
    return this.transition(current => current.host !== null ? undefined : { ...current, host: entryOf(request) })
  }

  /**
   * End the host-wide pause. Session pauses stay in effect; operations they cover keep waiting.
   * Resuming a host that is not paused does nothing.
   * @returns the status after the call.
   * @throws when the state file cannot be written; the host then stays paused.
   */
  @Remote('resume')
  resume(): Promise<PauseStatus> {
    return this.transition(current => current.host === null ? undefined : { ...current, host: null })
  }

  /**
   * Pause one Session and the subagents it starts. Pausing an already paused Session keeps its original start time and note.
   * @param sessionId - Session to pause; it need not have a live Agent.
   * @param request - caller label and note recorded with a new pause.
   * @returns the status after the call.
   * @throws when the state file cannot be written; the Session then stays as it was.
   */
  @Remote('pauseSession')
  pauseSession(sessionId: SessionId, request: PauseRequest): Promise<PauseStatus> {
    return this.transition(current => current.sessions.some(entry => entry.sessionId === sessionId) ? undefined : {
      ...current,
      sessions: [...current.sessions, { sessionId, ...entryOf(request) }],
    })
  }

  /**
   * End the pause of one Session. The host-wide pause, when in effect, keeps holding it.
   * Resuming a Session that is not paused does nothing.
   * @param sessionId - Session whose pause ends.
   * @returns the status after the call.
   * @throws when the state file cannot be written; the Session then stays paused.
   */
  @Remote('resumeSession')
  resumeSession(sessionId: SessionId): Promise<PauseStatus> {
    return this.transition(current => current.sessions.some(entry => entry.sessionId === sessionId)
      ? { ...current, sessions: current.sessions.filter(entry => entry.sessionId !== sessionId) }
      : undefined)
  }

  /** Apply one transition after earlier ones, persisting it before it takes effect. */
  private transition(compute: (current: PauseRecord) => PauseRecord | undefined): Promise<PauseStatus> {
    const run = this.transitions.then(async () => {
      const next = compute(this.record)
      if (next === undefined) return this.status()
      if (this.config.stateFile !== undefined) await writePauseRecord(this.config.stateFile, next)
      this.record = next
      for (const hold of [...this.holds]) if (!this.covers(hold.operation.sessionId)) hold.release(true)
      const status = this.status()
      this.ctx.emit('session-pause/changed', status)
      this.notify()
      return status
    })
    // A failed write rejects only its own caller; later transitions still run.
    this.transitions = run.then(() => undefined, () => undefined)
    return run
  }

  /** @returns the pauses in effect and the operations they hold. */
  @Remote('status')
  status(): PauseStatus {
    return { host: this.record.host, sessions: this.record.sessions, held: [...this.holds].map(hold => hold.operation) }
  }

  /**
   * Follow the status: yields it at once, then after every transition and
   * every change of the held operations. Changes that arrive before the
   * consumer reads the previous item collapse into one item.
   * @param signal - observation lifetime; aborting it ends the stream.
   * @returns the status stream, which also ends when the plugin unloads.
   */
  @Remote({ mode: 'stream' })
  async * follow(signal: AbortSignal): AsyncIterable<PauseStatus> {
    let changed = true
    let wake: (() => void) | undefined
    const observer = (): void => {
      changed = true
      wake?.()
    }
    this.observers.add(observer)
    signal.addEventListener('abort', observer)
    try {
      while (!signal.aborted && !this.disposed) {
        if (changed) {
          changed = false
          yield this.status()
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      this.observers.delete(observer)
      signal.removeEventListener('abort', observer)
    }
  }

  private notify(): void {
    for (const observer of [...this.observers]) observer()
  }

  /**
   * Wait until no pause covers the operation's Session; without a Session, until the host is not paused.
   * @param signal - the waiting operation's cancellation signal.
   * @param operation - what waits, reported by {@link status} while it waits.
   * @returns `true` once resumed (immediately when not paused), `false` when `signal` aborts first.
   */
  waitForResume(signal: AbortSignal, operation: Omit<HeldOperation, 'since'>): Promise<boolean> {
    if (!this.covers(operation.sessionId)) return Promise.resolve(true)
    if (signal.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const onAbort = (): void => { hold.release(false) }
      const hold: Hold = {
        operation: { ...operation, since: new Date().toISOString() },
        release: (resumed) => {
          signal.removeEventListener('abort', onAbort)
          this.holds.delete(hold)
          this.notify()
          resolve(resumed)
        },
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.holds.add(hold)
      this.notify()
    })
  }
}

function entryOf(request: PauseRequest): PauseEntry {
  return {
    since: new Date().toISOString(),
    source: request.source,
    ...request.reason === undefined ? {} : { reason: request.reason },
  }
}

export default SessionPause
