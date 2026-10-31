/**
 * Web surfaces of the pause: the sidebar button and frame-wide status pill of
 * the host-wide pause, and the composer button and dock strip of the pause of
 * the Session in view.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: types the Session-scope `sessionId` as the branded SessionId.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import sessionPauseRemote from '../host/remote.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseStatus } from '../host/types.ts'
import { createPauseController, sessionPauseSource } from './controller.ts'
import { en, NS, zh, type SessionPauseLocaleKey } from './locales.ts'
import {
  PauseButton, PausePill, SessionPauseButton, SessionPauseDock, type PauseInjected, type SessionPauseInjected,
} from './PauseControls.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Pause button and status pill copy. */
    sessionPause: SessionPauseLocaleKey
  }
}

/**
 * Services required before the Remote mount. `remote.sessionPause` exists only
 * after this plugin mounts its own contribution, so the surfaces wait for it
 * through a nested `ctx.inject`.
 */
export const inject = ['remote', 'slots', 'locale']

function registerSurfaces(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-pause: dictionaries')
  ctx.effect(() => {
    const stream = ctx.remote.$stream<PauseStatus>({
      name: 'Session pause status',
      open: signal => ctx.remote.sessionPause.follow(signal),
      // The host stream ends only when its plugin unloads, which also withdraws this namespace.
      ended: () => new Error('session pause status stream ended'),
    })
    const controller = createPauseController({
      follow: stream,
      pause: () => ctx.remote.sessionPause.pause({ source: 'web' }),
      resume: () => ctx.remote.sessionPause.resume(),
      pauseSession: sessionId => ctx.remote.sessionPause.pauseSession(sessionId, { source: 'web' }),
      resumeSession: sessionId => ctx.remote.sessionPause.resumeSession(sessionId),
    }, message => { ctx.logger.warn(message) })
    const injected = (): PauseInjected => ({
      hooks: { pause: controller.view },
      toggle: controller.toggle,
      resume: controller.resume,
    })
    const disposeButton = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action', id: 'session-pause', locale: NS, inject: injected,
    }, PauseButton))
    const disposePill = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'session-pause.status', locale: NS, inject: injected,
    }, PausePill))
    const injectedFor = (sessionId: SessionId): SessionPauseInjected => ({
      hooks: { sessionPause: sessionPauseSource(controller.view, sessionId) },
      toggleSession: () => { controller.toggleSession(sessionId) },
      resumeSession: () => { controller.resumeSession(sessionId) },
    })
    const disposeSessionButton = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right', id: 'session-pause', locale: NS, inject: injectedFor,
    }, SessionPauseButton))
    const disposeSessionDock = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock', id: 'session-pause', order: 5, locale: NS, inject: injectedFor,
    }, SessionPauseDock))
    return async () => {
      disposeSessionDock()
      disposeSessionButton()
      disposePill()
      disposeButton()
      await stream.dispose()
      await controller.observing
    }
  }, 'dsh-session-pause: surfaces')
}

/**
 * Mount the `sessionPause` Remote contribution, then contribute the host-wide and Session surfaces.
 * @param ctx - browser context carrying `remote`, `slots`, and `locale`.
 * @param contribution - the `sessionPause` Remote contribution to mount.
 * @returns the disposer that withdraws the surfaces and then the Remote mount.
 */
export async function mountPauseSurfaces(ctx: ClientContext, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const surfaces = ctx.inject(['remote.sessionPause', 'slots', 'locale'], registerSurfaces)
  try {
    await surfaces
  } catch (error) {
    await surfaces.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await surfaces.dispose()
    await disposeRemote()
  }
}

/**
 * Register the pause surfaces on the Client Context.
 * @param ctx - browser context with the declared `inject` services available.
 * @returns the disposer that withdraws the surfaces and the Remote mount.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mountPauseSurfaces(ctx, sessionPauseRemote)
}
