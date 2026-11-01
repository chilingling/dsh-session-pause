import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionPause, { type Config } from '../src/host/index.ts'

/** One scripted model call: answer with text, or wait for `drop` and fail as a lost connection. */
type Step = { text: string } | { dropAfter: Promise<void> }

/** Adapter whose retry policy allows no retries, so any recovery comes from the pause. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly policy: ResolvedRetryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 0,
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'session-pause test retryPolicy')

  constructor(private readonly script: Step[]) {
    super()
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.script.shift()
    if (step === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if ('dropAfter' in step) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await step.dropAfter
      throw new LlmError('fetch failed', 'TRANSPORT')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: step.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: step.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function host(adapter: ScriptedAdapter, config: Config = {}): Promise<Context> {
  const ctx = context = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRetry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SessionPause, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function agentOf(ctx: Context, id: string): Promise<Agent> {
  return ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function lastAssistantText(agent: Agent): unknown {
  return agent.session.deriveMessages().at(-1)
}

describe('host-wide pause', () => {
  it('sends no model request while paused and completes the turn after resume', async () => {
    const adapter = new ScriptedAdapter([{ text: 'done' }])
    const ctx = await host(adapter)
    const agent = await agentOf(ctx, 'main')

    await ctx.sessionPause.pause({ source: 'test' })
    send(agent, 'work')
    await vi.waitFor(() => {
      expect(ctx.sessionPause.status()).toMatchObject({ host: { source: 'test' }, held: [{ point: 'pre-step', sessionId: 'main' }] })
    })
    expect(adapter.requests).toHaveLength(0)
    expect(agent.status).toBe('running')

    await ctx.sessionPause.resume()
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(lastAssistantText(agent)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
    expect(ctx.sessionPause.status()).toEqual({ host: null, sessions: [], held: [] })
  })

  it('retries a request that fails while paused once resumed, without spending the retry budget', async () => {
    let drop!: () => void
    const adapter = new ScriptedAdapter([{ dropAfter: new Promise<void>((resolve) => { drop = resolve }) }, { text: 'recovered' }])
    const ctx = await host(adapter)
    const agent = await agentOf(ctx, 'main')

    send(agent, 'work')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    await ctx.sessionPause.pause({ source: 'test' })
    drop()
    await vi.waitFor(() => {
      expect(ctx.sessionPause.status()).toMatchObject({ held: [{ point: 'request-error', sessionId: 'main' }] })
    })
    expect(adapter.requests).toHaveLength(1)

    await ctx.sessionPause.resume()
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(lastAssistantText(agent)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'recovered' }] })
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
  })

  it('lets the stop button end a held turn while the host stays paused', async () => {
    const adapter = new ScriptedAdapter([])
    const ctx = await host(adapter)
    const agent = await agentOf(ctx, 'main')

    await ctx.sessionPause.pause({ source: 'test' })
    send(agent, 'work')
    await vi.waitFor(() => { expect(ctx.sessionPause.status()).toMatchObject({ held: [{ point: 'pre-step' }] }) })
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['aborted'])
    expect(ctx.sessionPause.status()).toMatchObject({ host: { source: 'test' }, held: [] })
  })

  it('holds model calls made outside an agent step, such as compaction, until resumed', async () => {
    const adapter = new ScriptedAdapter([{ text: 'summary' }])
    const ctx = await host(adapter)

    await ctx.sessionPause.pause({ source: 'test' })
    const collected = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [] })) chunks.push(chunk)
      return chunks
    })()
    await vi.waitFor(() => { expect(ctx.sessionPause.status()).toMatchObject({ held: [{ point: 'llm-stream' }] }) })
    expect(adapter.requests).toHaveLength(0)

    await ctx.sessionPause.resume()

    expect(await collected).toContainEqual({ type: 'text-delta', index: 0, text: 'summary' })
  })
})

describe('session pause', () => {
  it('holds only the paused session and continues its turn once that session resumes', async () => {
    const adapter = new ScriptedAdapter([{ text: 'other done' }, { text: 'paused done' }])
    const ctx = await host(adapter)
    const paused = await agentOf(ctx, 'paused')
    const other = await agentOf(ctx, 'other')

    await ctx.sessionPause.pauseSession(paused.id, { source: 'test', reason: 'review' })
    send(paused, 'work')
    send(other, 'work')
    await other.whenIdle()
    await vi.waitFor(() => {
      expect(ctx.sessionPause.status()).toMatchObject({
        host: null,
        sessions: [{ sessionId: 'paused', source: 'test', reason: 'review' }],
        held: [{ point: 'pre-step', sessionId: 'paused' }],
      })
    })
    expect(adapter.requests).toHaveLength(1)
    expect(lastAssistantText(other)).toMatchObject({ content: [{ type: 'text', text: 'other done' }] })

    await ctx.sessionPause.resumeSession(paused.id)
    await paused.whenIdle()

    expect(lastAssistantText(paused)).toMatchObject({ content: [{ type: 'text', text: 'paused done' }] })
    expect(ctx.sessionPause.status()).toEqual({ host: null, sessions: [], held: [] })
  })

  it('holds the subagents a paused session started', async () => {
    const adapter = new ScriptedAdapter([{ text: 'child done' }])
    const ctx = await host(adapter)
    const parent = await agentOf(ctx, 'parent')
    const { agent: child } = await ctx.agents.create({
      sessionId: SessionId('child'),
      meta: { parentSession: parent.id, origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    await ctx.sessionPause.pauseSession(parent.id, { source: 'test' })
    send(child, 'work')
    await vi.waitFor(() => {
      expect(ctx.sessionPause.status()).toMatchObject({ held: [{ point: 'pre-step', sessionId: 'child' }] })
    })
    expect(adapter.requests).toHaveLength(0)

    await ctx.sessionPause.resumeSession(parent.id)
    await child.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })

  it('keeps a paused session held when the host-wide pause ends', async () => {
    const adapter = new ScriptedAdapter([{ text: 'done' }])
    const ctx = await host(adapter)
    const agent = await agentOf(ctx, 'main')

    await ctx.sessionPause.pause({ source: 'test' })
    await ctx.sessionPause.pauseSession(agent.id, { source: 'test' })
    send(agent, 'work')
    await vi.waitFor(() => { expect(ctx.sessionPause.status()).toMatchObject({ held: [{ point: 'pre-step' }] }) })

    await ctx.sessionPause.resume()
    expect(ctx.sessionPause.status()).toMatchObject({ host: null, held: [{ point: 'pre-step', sessionId: 'main' }] })
    expect(adapter.requests).toHaveLength(0)

    await ctx.sessionPause.resumeSession(agent.id)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('state file', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('keeps a pause across a host restart until resumed', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-pause-'))
    const stateFile = join(root, 'nested', 'session-pause.json')
    const first = await host(new ScriptedAdapter([]), { stateFile })
    const paused = await first.sessionPause.pause({ source: 'test', reason: 'train' })
    await first.fiber.dispose()

    const adapter = new ScriptedAdapter([{ text: 'done' }])
    const second = await host(adapter, { stateFile })
    expect(second.sessionPause.status()).toEqual(paused)
    const agent = await agentOf(second, 'main')
    send(agent, 'work')
    await vi.waitFor(() => { expect(second.sessionPause.status()).toMatchObject({ held: [{ point: 'pre-step' }] }) })

    await second.sessionPause.resume()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ version: 2, host: null, sessions: [] })
  })

  it('fails the plugin load on a state file it cannot interpret', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-pause-'))
    const stateFile = join(root, 'session-pause.json')
    await writeFile(stateFile, JSON.stringify({ version: 3, host: null, sessions: [] }))

    await expect(host(new ScriptedAdapter([]), { stateFile })).rejects.toThrow(/unsupported version 3/)
  })

  it('keeps session pauses across a host restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-pause-'))
    const stateFile = join(root, 'session-pause.json')
    const first = await host(new ScriptedAdapter([]), { stateFile })
    await first.sessionPause.pauseSession(SessionId('main'), { source: 'test', reason: 'review' })
    await first.fiber.dispose()

    const second = await host(new ScriptedAdapter([]), { stateFile })
    expect(second.sessionPause.status()).toMatchObject({ host: null, sessions: [{ sessionId: 'main', source: 'test', reason: 'review' }] })
  })

  it('reads a version 1 file written before session pauses existed', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-pause-'))
    const stateFile = join(root, 'session-pause.json')
    await writeFile(stateFile, JSON.stringify({ version: 1, paused: true, since: '2026-10-31T07:00:00.000Z', source: 'web' }))

    const ctx = await host(new ScriptedAdapter([]), { stateFile })
    expect(ctx.sessionPause.status()).toEqual({ host: { since: '2026-10-31T07:00:00.000Z', source: 'web' }, sessions: [], held: [] })
  })
})

describe('commands', () => {
  it('pauses, reports, and resumes the whole host from any session', async () => {
    const adapter = new ScriptedAdapter([{ text: 'done' }])
    const ctx = await host(adapter)
    const worker = await agentOf(ctx, 'worker')
    const controller = await agentOf(ctx, 'console')
    const run = async (line: string) => (await ctx.commands.execute(controller, line, [], new AbortController().signal))?.result

    expect(await run('/pause-all  on the train ')).toMatchObject({ kind: 'success', text: expect.stringContaining('paused') })
    expect(ctx.sessionPause.status()).toMatchObject({ host: { source: 'command', reason: 'on the train' } })
    send(worker, 'work')
    await vi.waitFor(() => { expect(ctx.sessionPause.status()).toMatchObject({ held: [{ point: 'pre-step', sessionId: 'worker' }] }) })
    expect(await run('/pause-status')).toMatchObject({
      kind: 'success',
      text: expect.stringMatching(/on the train[\s\S]*worker: waiting before its next step/),
    })

    expect(await run('/resume-all')).toMatchObject({ kind: 'success', text: expect.stringContaining('running') })
    await worker.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })

  it('pauses and resumes the session that receives the command', async () => {
    const adapter = new ScriptedAdapter([{ text: 'done' }])
    const ctx = await host(adapter)
    const agent = await agentOf(ctx, 'main')
    const run = async (line: string) => (await ctx.commands.execute(agent, line, [], new AbortController().signal))?.result

    expect(await run('/pause-session review first')).toMatchObject({ kind: 'success', text: expect.stringContaining('Session main is paused') })
    expect(ctx.sessionPause.status()).toMatchObject({ host: null, sessions: [{ sessionId: 'main', source: 'command', reason: 'review first' }] })
    send(agent, 'work')
    await vi.waitFor(() => { expect(ctx.sessionPause.status()).toMatchObject({ held: [{ point: 'pre-step', sessionId: 'main' }] }) })
    expect(await run('/pause-status')).toMatchObject({
      kind: 'success',
      text: expect.stringMatching(/Session main is paused since .* \(review first\)[\s\S]*main: waiting before its next step/),
    })

    expect(await run('/resume-session')).toMatchObject({ kind: 'success', text: expect.not.stringContaining('Session main') })
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })
})
