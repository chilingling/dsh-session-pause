/**
 * Typert Remote contribution of the `sessionPause` namespace.
 *
 * The DSH Typert generator only runs inside the deepseek-harness workspace, so
 * this out-of-tree package maintains the descriptors and their Zod codecs by
 * hand. Each descriptor mirrors what the generator emits for the matching
 * `@Remote` method of `SessionPause`; the codecs must accept exactly the fields
 * declared in `./types.ts`. The Host Typert loader registers them through
 * `./typert`, and the browser plugin mounts them with `ctx.remote.$mount()`.
 * @module dsh-session-pause/remote
 */

import { z } from 'zod'
import type { RemoteResult, RemoteStreamHandle, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseRequest, PauseStatus } from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  /** Client signatures of the `sessionPause` namespace. */
  interface SessionPauseRemoteNamespace {
    pause: (request: PauseRequest) => Promise<RemoteResult<PauseStatus>>
    resume: () => Promise<RemoteResult<PauseStatus>>
    pauseSession: (sessionId: SessionId, request: PauseRequest) => Promise<RemoteResult<PauseStatus>>
    resumeSession: (sessionId: SessionId) => Promise<RemoteResult<PauseStatus>>
    status: () => Promise<RemoteResult<PauseStatus>>
    follow: (signal?: AbortSignal) => RemoteStreamHandle<PauseStatus, never>
  }
  interface TypertRemoteMap {
    'sessionPause/pause': (request: PauseRequest) => Promise<RemoteResult<PauseStatus>>
    'sessionPause/resume': () => Promise<RemoteResult<PauseStatus>>
    'sessionPause/pauseSession': (sessionId: SessionId, request: PauseRequest) => Promise<RemoteResult<PauseStatus>>
    'sessionPause/resumeSession': (sessionId: SessionId) => Promise<RemoteResult<PauseStatus>>
    'sessionPause/status': () => Promise<RemoteResult<PauseStatus>>
    'sessionPause/follow': (signal?: AbortSignal) => RemoteStreamHandle<PauseStatus, never>
  }
  interface TypertRemoteNamespaceMap {
    sessionPause: SessionPauseRemoteNamespace
  }
}

/** Package name the Typert loader requires the manifest to carry. */
export const PACKAGE = 'dsh-session-pause'

let sessionIdSchema: z.ZodType<SessionId> | undefined
/** Codec of the `sessionId` parameter of `pauseSession` and `resumeSession`. */
export const sessionIdCodec = (): z.ZodType<SessionId> => (sessionIdSchema ??= z.string().min(1).transform(id => id as SessionId))

let requestSchema: z.ZodType<PauseRequest> | undefined
/** Request codec of `pause`. */
export const requestCodec = (): z.ZodType<PauseRequest> => (requestSchema ??= z.object({
  source: z.string().readonly(),
  reason: z.string().readonly().optional(),
}) as z.ZodType<PauseRequest>)

let statusSchema: z.ZodType<PauseStatus> | undefined
/** Result codec of every unary method, and item codec of `follow`. */
export const statusCodec = (): z.ZodType<PauseStatus> => (statusSchema ??= (() => {
  const entry = {
    since: z.string().readonly(),
    source: z.string().readonly(),
    reason: z.string().readonly().optional(),
  }
  return z.object({
    host: z.object(entry).readonly().nullable(),
    sessions: z.array(z.object({ sessionId: sessionIdCodec(), ...entry })).readonly(),
    held: z.array(z.object({
      point: z.union([z.literal('pre-step'), z.literal('request-error'), z.literal('llm-stream')]).readonly(),
      sessionId: sessionIdCodec().optional(),
      since: z.string().readonly(),
    })).readonly(),
  }) as z.ZodType<PauseStatus>
})())

const sessionIdParameter = {
  name: 'sessionId',
  wire: 'sessionId',
  source: 'json',
  codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: sessionIdCodec },
} as const
const requestParameter = {
  name: 'request',
  wire: 'request',
  source: 'json',
  codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#PauseRequest`, create: requestCodec },
} as const

const status = { mode: 'strict', typeSymbol: `${PACKAGE}/types#PauseStatus`, create: statusCodec } as const

/** Remote contribution shared by the Host manifest and the browser mount. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors: [
    {
      id: `${PACKAGE}#sessionPause/pause`,
      service: 'sessionPause',
      namespace: 'sessionPause',
      method: 'pause',
      invocation: { kind: 'direct' },
      parameters: [requestParameter],
      result: status,
    },
    {
      id: `${PACKAGE}#sessionPause/resume`,
      service: 'sessionPause',
      namespace: 'sessionPause',
      method: 'resume',
      invocation: { kind: 'direct' },
      parameters: [],
      result: status,
    },
    {
      id: `${PACKAGE}#sessionPause/pauseSession`,
      service: 'sessionPause',
      namespace: 'sessionPause',
      method: 'pauseSession',
      invocation: { kind: 'direct' },
      parameters: [sessionIdParameter, requestParameter],
      result: status,
    },
    {
      id: `${PACKAGE}#sessionPause/resumeSession`,
      service: 'sessionPause',
      namespace: 'sessionPause',
      method: 'resumeSession',
      invocation: { kind: 'direct' },
      parameters: [sessionIdParameter],
      result: status,
    },
    {
      id: `${PACKAGE}#sessionPause/status`,
      service: 'sessionPause',
      namespace: 'sessionPause',
      method: 'status',
      invocation: { kind: 'direct' },
      parameters: [],
      result: status,
    },
    {
      id: `${PACKAGE}#sessionPause/follow`,
      service: 'sessionPause',
      namespace: 'sessionPause',
      method: 'follow',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [],
      cancellation: { parameter: 'signal' },
      result: status,
    },
  ],
}

export default TYPERT_REMOTE
