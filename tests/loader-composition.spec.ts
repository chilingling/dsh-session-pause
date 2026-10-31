import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type {} from '../src/host/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('dsh-session-pause composition', () => {
  it('mounts by package name, persists a pause to the configured file, and leaves on dispose', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-pause-loader-'))
    const stateFile = join(root, 'session-pause.json')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: 'dsh-session-pause'",
      '  config:',
      `    stateFile: ${JSON.stringify(stateFile)}`,
      '',
    ].join('\n'))

    const ctx = context = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    // Without Node's internal loader the Loader imports each bare name through Vitest, which
    // resolves this package to source.
    ctx.loader.internal = undefined
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    await ctx.sessionPause.pause({ source: 'test' })
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ version: 2, host: { source: 'test' }, sessions: [] })

    await ctx.fiber.dispose()
    context = undefined
    expect(ctx.get('sessionPause')).toBeUndefined()
  })
})
