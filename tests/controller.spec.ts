import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createPauseController, sessionPauseSource, type PauseRemote, type StatusItem } from '../src/client/controller.ts'
import type { PauseStatus } from '../src/host/types.ts'

const PAUSED: PauseStatus = { host: { since: '2026-10-31T07:00:00.000Z', source: 'web' }, sessions: [], held: [] }
const RUNNING: PauseStatus = { host: null, sessions: [], held: [] }
const MAIN = SessionId('main')
const MAIN_PAUSED: PauseStatus = { host: null, sessions: [{ sessionId: MAIN, since: '2026-10-31T07:00:00.000Z', source: 'web' }], held: [] }

/** A status stream the test feeds item by item and ends on demand. */
function feed() {
  const queue: StatusItem[] = []
  let wake: (() => void) | undefined
  let ended = false
  const follow: AsyncIterable<StatusItem> = {
    async * [Symbol.asyncIterator]() {
      while (true) {
        const item = queue.shift()
        if (item !== undefined) { yield item; continue }
        if (ended) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
  }
  return {
    follow,
    push(value: PauseStatus) { queue.push({ value, accept: () => {} }); wake?.() },
    end() { ended = true; wake?.() },
  }
}

const ok = (value: PauseStatus): RemoteResult<PauseStatus> => ({ ok: true, value })

describe('pause controller', () => {
  it('mirrors the streamed status and forgets it when the stream ends', async () => {
    const stream = feed()
    const controller = createPauseController({ follow: stream.follow, pause: vi.fn(), resume: vi.fn(), pauseSession: vi.fn(), resumeSession: vi.fn() }, () => {})
    expect(controller.view.getSnapshot().status).toBeNull()

    stream.push(PAUSED)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().status).toEqual(PAUSED) })

    stream.end()
    await controller.observing
    expect(controller.view.getSnapshot().status).toBeNull()
  })

  it('toggles by the current status and ignores clicks while a request is in flight', async () => {
    const stream = feed()
    let settle!: (result: RemoteResult<PauseStatus>) => void
    const remote: PauseRemote = {
      follow: stream.follow,
      pause: vi.fn(() => new Promise<RemoteResult<PauseStatus>>((resolve) => { settle = resolve })),
      resume: vi.fn(async () => ok(RUNNING)),
      pauseSession: vi.fn(),
      resumeSession: vi.fn(),
    }
    const controller = createPauseController(remote, () => {})
    controller.toggle()
    expect(remote.pause).not.toHaveBeenCalled()

    stream.push(RUNNING)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().status).toEqual(RUNNING) })
    controller.toggle()
    controller.toggle()
    expect(remote.pause).toHaveBeenCalledTimes(1)
    expect(controller.view.getSnapshot().pending).toBe(true)

    settle(ok(PAUSED))
    await vi.waitFor(() => { expect(controller.view.getSnapshot()).toMatchObject({ pending: false, status: PAUSED }) })
    controller.toggle()
    await vi.waitFor(() => { expect(controller.view.getSnapshot().status).toEqual(RUNNING) })
    expect(remote.resume).toHaveBeenCalledTimes(1)
    stream.end()
  })

  it('keeps the failure message of a refused request until the next request', async () => {
    const stream = feed()
    const remote: PauseRemote = {
      follow: stream.follow,
      pause: vi.fn(),
      pauseSession: vi.fn(),
      resumeSession: vi.fn(),
      resume: vi.fn(async (): Promise<RemoteResult<PauseStatus>> => ({
        ok: false,
        error: { code: 'gateway/internal', message: 'state file is read-only', details: {} },
      } as RemoteResult<PauseStatus>)),
    }
    const controller = createPauseController(remote, () => {})
    stream.push(PAUSED)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().status).toEqual(PAUSED) })

    controller.resume()
    await vi.waitFor(() => {
      expect(controller.view.getSnapshot()).toMatchObject({
        pending: false, status: PAUSED, failure: { action: 'resume', message: 'state file is read-only' },
      })
    })
    stream.end()
  })

  it('toggles one session by whether the status lists it, and ties a refused request to that session', async () => {
    const stream = feed()
    const remote: PauseRemote = {
      follow: stream.follow,
      pause: vi.fn(),
      resume: vi.fn(),
      pauseSession: vi.fn(async () => ok(MAIN_PAUSED)),
      resumeSession: vi.fn(async (): Promise<RemoteResult<PauseStatus>> => ({
        ok: false,
        error: { code: 'gateway/internal', message: 'state file is read-only', details: {} },
      } as RemoteResult<PauseStatus>)),
    }
    const controller = createPauseController(remote, () => {})
    stream.push(PAUSED)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().status).toEqual(PAUSED) })

    const main = sessionPauseSource(controller.view, MAIN)
    const other = sessionPauseSource(controller.view, SessionId('other'))
    controller.toggleSession(MAIN)
    await vi.waitFor(() => { expect(controller.view.getSnapshot().status).toEqual(MAIN_PAUSED) })
    expect(remote.pauseSession).toHaveBeenCalledWith(MAIN)
    expect(main.getSnapshot()).toMatchObject({ known: true, pause: { sessionId: 'main' }, failure: null })
    expect(main.getSnapshot()).toBe(main.getSnapshot())
    expect(other.getSnapshot().pause).toBeUndefined()

    controller.toggleSession(MAIN)
    await vi.waitFor(() => {
      expect(controller.view.getSnapshot()).toMatchObject({
        pending: false, failure: { action: 'resume-session', sessionId: MAIN, message: 'state file is read-only' },
      })
    })
    expect(remote.resumeSession).toHaveBeenCalledWith(MAIN)
    expect(main.getSnapshot().failure).toEqual({ action: 'resume-session', message: 'state file is read-only' })
    expect(other.getSnapshot().failure).toBeNull()
    stream.end()
  })
})
