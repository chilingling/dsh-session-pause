/**
 * Host Typert manifest discovered by `@deepseek-ai/dsh-typert-loader` through
 * this package's `./typert` export. It registers the `sessionPause` endpoints
 * with the Host registry so the API Gateway can claim them.
 * @module dsh-session-pause/typert
 */

import TYPERT_REMOTE, { PACKAGE } from './remote.ts'

/** Host-face contribution; the loader validates every field at import. */
export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: TYPERT_REMOTE.descriptors,
  model: { services: [], events: [], objects: [] },
} as const
