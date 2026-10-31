import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionPause from '../src/host/index.ts'
import TYPERT_REMOTE, { requestCodec, statusCodec } from '../src/host/remote.ts'
import { TYPERT } from '../src/host/typert.ts'
import type { PauseStatus } from '../src/host/types.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function service(): Promise<SessionPause> {
  const ctx = context = new Context()
  await ctx.plugin(SessionPause)
  return ctx.sessionPause
}

/** Read the next item of a stream iterator, failing instead of hanging. */
async function nextOf(iterator: AsyncIterator<PauseStatus>): Promise<PauseStatus> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => { reject(new Error('no item within 1s')) }, 1000))
  const result = await Promise.race([iterator.next(), timeout])
  if (result.done === true) throw new Error('stream ended')
  return result.value
}

describe('follow stream', () => {
  it('yields the current status, then each transition and each change of held operations', async () => {
    const pause = await service()
    const observation = new AbortController()
    const items = pause.follow(observation.signal)[Symbol.asyncIterator]()

    expect(await nextOf(items)).toEqual({ host: null, sessions: [], held: [] })

    await pause.pause({ source: 'web', reason: 'train' })
    expect(await nextOf(items)).toMatchObject({ host: { source: 'web', reason: 'train' }, held: [] })

    const step = new AbortController()
    const held = pause.waitForResume(step.signal, { point: 'pre-step', sessionId: SessionId('main') })
    expect(await nextOf(items)).toMatchObject({ held: [{ point: 'pre-step', sessionId: 'main' }] })

    await pause.resume()
    expect(await held).toBe(true)
    expect(await nextOf(items)).toEqual({ host: null, sessions: [], held: [] })

    await pause.pauseSession(SessionId('main'), { source: 'web' })
    expect(await nextOf(items)).toMatchObject({ host: null, sessions: [{ sessionId: 'main', source: 'web' }] })

    observation.abort()
    expect(await items.next()).toEqual({ done: true, value: undefined })
  })

  it('ends when the plugin unloads', async () => {
    const pause = await service()
    const items = pause.follow(new AbortController().signal)[Symbol.asyncIterator]()
    await nextOf(items)

    await context!.fiber.dispose()
    context = undefined

    expect(await items.next()).toEqual({ done: true, value: undefined })
  })
})

describe('remote contribution', () => {
  it('declares one descriptor per Remote method, all in the sessionPause namespace', () => {
    expect(TYPERT_REMOTE.descriptors.map(descriptor => [descriptor.method, descriptor.mode ?? 'unary'])).toEqual([
      ['pause', 'unary'], ['resume', 'unary'], ['pauseSession', 'unary'], ['resumeSession', 'unary'],
      ['status', 'unary'], ['follow', 'stream'],
    ])
    expect(new Set(TYPERT_REMOTE.descriptors.map(descriptor => descriptor.namespace))).toEqual(new Set(['sessionPause']))
    expect(TYPERT).toMatchObject({ package: 'dsh-session-pause', face: 'host', invocations: TYPERT_REMOTE.descriptors })
  })

  it('accepts every status the service reports and rejects a malformed one', async () => {
    const pause = await service()
    const step = new AbortController()
    const running = pause.status()
    await pause.pause({ source: 'web' })
    await pause.pauseSession(SessionId('other'), { source: 'web', reason: 'review' })
    void pause.waitForResume(step.signal, { point: 'request-error', sessionId: SessionId('main') })
    const paused = pause.status()

    expect(statusCodec().parse(running)).toEqual(running)
    expect(statusCodec().parse(paused)).toEqual(paused)
    expect(statusCodec().safeParse({ host: { since: 'now' }, sessions: [], held: [] }).success).toBe(false)
    expect(statusCodec().safeParse({ host: null, sessions: [{ sessionId: '', since: 'now', source: 'web' }], held: [] }).success).toBe(false)
    expect(requestCodec().parse({ source: 'web', reason: 'train' })).toEqual({ source: 'web', reason: 'train' })
    step.abort()
  })
})
