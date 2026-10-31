/**
 * Slash commands that control the host-wide pause from any Session, and the
 * pause of the Session that receives them.
 *
 * @module dsh-session-pause/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionPause } from './index.ts'
import type { HeldOperation, PauseEntry, PauseStatus } from './types.ts'

const HOLD_LABELS: Record<HeldOperation['point'], string> = {
  'pre-step': 'waiting before its next step',
  'request-error': 'waiting to retry a failed model request',
  'llm-stream': 'model call waiting to start',
}

/**
 * Register `/pause-all`, `/resume-all`, and `/pause-status`, which act on the
 * whole host regardless of the Session that receives them, and
 * `/pause-session` and `/resume-session`, which act on the receiving Session.
 * @param ctx - context carrying the `commands` service.
 * @param pause - the pause service the commands control.
 */
export function registerCommands(ctx: Context, pause: SessionPause): void {
  ctx.commands.register({
    name: 'pause-all',
    description: 'Pause model activity of every session on this host, including subagents and goals',
    input: { hint: '[reason]' },
    handler: async ({ rawInput }) => {
      const reason = rawInput.trim()
      return report(await pause.pause({ source: 'command', ...reason === '' ? {} : { reason } }))
    },
  })
  ctx.commands.register({
    name: 'resume-all',
    description: 'Resume model activity paused by /pause-all',
    handler: async () => report(await pause.resume()),
  })
  ctx.commands.register({
    name: 'pause-session',
    description: 'Pause model activity of this session and the subagents it starts',
    input: { hint: '[reason]' },
    handler: async ({ agent, rawInput }) => {
      const reason = rawInput.trim()
      return report(await pause.pauseSession(agent.id, { source: 'command', ...reason === '' ? {} : { reason } }))
    },
  })
  ctx.commands.register({
    name: 'resume-session',
    description: 'Resume model activity of this session paused by /pause-session',
    handler: async ({ agent }) => report(await pause.resumeSession(agent.id)),
  })
  ctx.commands.register({
    name: 'pause-status',
    description: 'Show the pauses of this host and its sessions, and what they hold',
    handler: () => report(pause.status()),
  })
}

function report(status: PauseStatus): CommandResult {
  return { kind: 'success', text: renderStatus(status) }
}

/**
 * Render the status as command output.
 * @param status - status to render.
 * @returns one line for the host, one per paused Session, and one per held operation.
 */
export function renderStatus(status: PauseStatus): string {
  const lines = [status.host === null
    ? 'Model activity on this host is running.'
    : `Model activity on this host is paused ${describe(status.host)}.`]
  for (const entry of status.sessions) lines.push(`Session ${entry.sessionId} is paused ${describe(entry)}.`)
  if (status.host !== null || status.sessions.length > 0) lines.push(`Held operations: ${status.held.length}.`)
  for (const held of status.held) lines.push(`- ${held.sessionId ?? 'model call'}: ${HOLD_LABELS[held.point]}`)
  return lines.join('\n')
}

function describe(entry: PauseEntry): string {
  return `since ${entry.since}${entry.reason === undefined ? '' : ` (${entry.reason})`}`
}
