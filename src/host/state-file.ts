/**
 * Durable pause record: one JSON file the plugin reads at load and replaces
 * on every transition.
 *
 * @module dsh-session-pause/state-file
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseEntry, SessionPauseEntry } from './types.ts'

/**
 * Format version the plugin writes. Version 1, which held only the host-wide
 * pause, is still read; any other version fails the load.
 */
export const PAUSE_RECORD_VERSION = 2

/** The persisted pause state. */
export interface PauseRecord {
  readonly version: typeof PAUSE_RECORD_VERSION
  /** Host-wide pause, or `null` while the host as a whole is not paused. */
  readonly host: PauseEntry | null
  /** Sessions paused one by one, in the order they were paused. */
  readonly sessions: readonly SessionPauseEntry[]
}

/** The record of a host with no pause in effect. */
export const RUNNING: PauseRecord = Object.freeze({ version: PAUSE_RECORD_VERSION, host: null, sessions: Object.freeze([]) })

/**
 * Read the pause record; a missing file means not paused.
 * @param path - state file path.
 * @returns the validated record.
 * @throws when the file cannot be read, is not JSON, or does not hold a supported record.
 */
export function readPauseRecord(path: string): PauseRecord {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return RUNNING
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new Error(`session-pause: state file ${path} is not JSON: ${(error as Error).message}`)
  }
  return parsePauseRecord(value, path)
}

/**
 * Replace the state file atomically, creating its directory when missing.
 * @param path - state file path.
 * @param record - record to persist.
 */
export async function writePauseRecord(path: string, record: PauseRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

function parsePauseRecord(value: unknown, path: string): PauseRecord {
  const invalid = (detail: string): Error => new Error(`session-pause: state file ${path} ${detail}; fix or delete it`)
  if (typeof value !== 'object' || value === null) throw invalid('does not hold an object')
  const record = value as Record<string, unknown>
  switch (record['version']) {
    case 1: {
      if (record['paused'] === false) return RUNNING
      if (record['paused'] !== true) throw invalid('has no boolean "paused"')
      return { version: PAUSE_RECORD_VERSION, host: parseEntry(record, 'the host pause', invalid), sessions: [] }
    }
    case PAUSE_RECORD_VERSION: {
      const { host, sessions } = record
      if (host !== null && typeof host !== 'object') throw invalid('has no object or null "host"')
      if (!Array.isArray(sessions)) throw invalid('has no array "sessions"')
      return {
        version: PAUSE_RECORD_VERSION,
        host: host === null ? null : parseEntry(host as Record<string, unknown>, '"host"', invalid),
        sessions: sessions.map((item: unknown, index) => {
          const where = `"sessions[${index}]"`
          if (typeof item !== 'object' || item === null) throw invalid(`has a non-object ${where}`)
          const entry = item as Record<string, unknown>
          if (typeof entry['sessionId'] !== 'string') throw invalid(`has no string sessionId in ${where}`)
          return { sessionId: SessionId(entry['sessionId']), ...parseEntry(entry, where, invalid) }
        }),
      }
    }
    default:
      throw invalid(`has unsupported version ${JSON.stringify(record['version'])} (expected 1 or ${PAUSE_RECORD_VERSION})`)
  }
}

function parseEntry(entry: Record<string, unknown>, where: string, invalid: (detail: string) => Error): PauseEntry {
  const { since, source, reason } = entry
  if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) throw invalid(`has no ISO "since" time in ${where}`)
  if (typeof source !== 'string') throw invalid(`has no string "source" in ${where}`)
  if (reason !== undefined && typeof reason !== 'string') throw invalid(`has a non-string "reason" in ${where}`)
  return { since, source, ...reason === undefined ? {} : { reason } }
}
