/** Persona catalog and per-session assignment, persisted as one JSON document. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { formatTimestamp } from '@dsh-plugins-xz/time-utils'

/** Persona lifecycle flags persisted on every record. */
const STATUS_ACTIVE = 1
const STATUS_DELETED = 0

/** One reusable persona. */
export interface Persona {
  /** Stable identifier referenced by a session assignment. */
  readonly id: string
  /** Display name shown in the UI and tool output. */
  readonly name: string
  /** Text injected into the session's system prompt. */
  readonly content: string
  /** Creation time, formatted as ISO-8601 UTC, e.g. `2026-09-17T08:30:00.000Z`. */
  readonly createTime: string
  /** Last update or soft-delete time, formatted as ISO-8601 UTC; empty until the first mutation. */
  readonly updateTime: string
  /** 1 = active and listed, 0 = soft-deleted and hidden from listings. */
  readonly status: number
}

/** The persisted document. */
interface StoredState {
  personas: Persona[]
  sessionAssignments: Record<string, string>
}

/** Always-available persona that injects nothing; selecting it is how a session returns to the default. */
const DEFAULT_PERSONA: Persona = {
  id: 'default',
  name: '默认人格',
  content: '',
  createTime: formatTimestamp(),
  updateTime: '',
  status: STATUS_ACTIVE,
}

/** Fresh installations start with only the always-available default persona; users add their own. */
const SEED_PERSONAS: readonly Persona[] = [DEFAULT_PERSONA]

/**
 * Coerce a stored record (which may predate the time/status fields) into a
 * complete {@link Persona}, defaulting missing metadata so older documents load.
 * @param raw - Record read from disk.
 * @returns A fully-populated persona.
 */
function normalizePersona(raw: Persona): Persona {
  return {
    id: raw.id,
    name: raw.name,
    content: raw.content,
    createTime: typeof raw.createTime === 'string' ? raw.createTime : formatTimestamp(raw.createTime),
    updateTime: typeof raw.updateTime === 'string'
      ? raw.updateTime
      : (typeof raw.updateTime === 'number' && raw.updateTime > 0 ? formatTimestamp(raw.updateTime) : ''),
    status: typeof raw.status === 'number' ? raw.status : STATUS_ACTIVE,
  }
}

/**
 * Read/write the persona document, keeping it in memory so the synchronous
 * system-prompt hook never touches the filesystem.
 */
export class PersonaStore {
  private readonly path: string
  private state: StoredState

  /**
   * Load the document, seeding a fresh installation.
   * @param path - Absolute document path; defaults to `$DSH_HOME/storages/<plugin>/personas.json`.
   */
  constructor(path: string = dshHomePath('storages', 'session-persona-manager', 'personas.json')) {
    this.path = path
    this.state = this.load()
  }

  /** @returns Every active persona, in insertion order. Soft-deleted records are excluded. */
  list(): readonly Persona[] {
    return this.state.personas.filter(persona => persona.status === STATUS_ACTIVE)
  }

  /**
   * Find one persona.
   * @param personaId - Identifier to look up.
   * @returns The persona, or undefined when it is not defined.
   */
  find(personaId: string): Persona | undefined {
    return this.state.personas.find(persona => persona.id === personaId && persona.status === STATUS_ACTIVE)
  }

  /**
   * Resolve the persona bound to one session.
   * @param sessionId - Session identifier.
   * @returns The bound persona, or undefined when the session uses the default.
   */
  forSession(sessionId: string): Persona | undefined {
    const personaId = this.state.sessionAssignments[sessionId]
    return personaId === undefined ? undefined : this.find(personaId)
  }

  /**
   * Bind a persona to one session, clearing the binding when the persona is unknown.
   * @param sessionId - Session identifier.
   * @param personaId - Identifier of the persona to bind.
   * @returns The bound persona, or undefined when nothing was bound.
   */
  assign(sessionId: string, personaId: string): Persona | undefined {
    const persona = this.find(personaId)
    if (persona === undefined) {
      delete this.state.sessionAssignments[sessionId]
    } else {
      this.state.sessionAssignments[sessionId] = personaId
    }
    this.persist()
    return persona
  }

  /**
   * Bind a persona to one session, clearing the binding when the persona is unknown.
   * @param sessionId - Session identifier.
   * @param personaId - Identifier of the persona to bind.
   * @returns The bound persona, or undefined when nothing was bound.
   */

  /**
   * Create a new persona with a generated id.
   * @param name - Display name.
   * @param content - Text injected into the session system prompt.
   * @returns The created persona.
   * @throws when `name` is empty.
   */
  create(name: string, content: string): Persona {
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('persona name is required')
    const persona: Persona = {
      id: randomUUID(),
      name: trimmed,
      content,
      createTime: formatTimestamp(),
      updateTime: '',
      status: STATUS_ACTIVE,
    }
    this.state.personas = [...this.state.personas, persona]
    this.persist()
    return persona
  }

  /**
   * Replace a persona's name and content. The reserved default persona cannot be edited.
   * @returns The updated persona, or undefined when the id is unknown or reserved.
   */
  update(id: string, name: string, content: string): Persona | undefined {
    if (id === DEFAULT_PERSONA.id) return undefined
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('persona name is required')
    const existing = this.state.personas.find(persona => persona.id === id)
    if (existing === undefined || existing.status !== STATUS_ACTIVE) return undefined
    const updated: Persona = {
      id,
      name: trimmed,
      content,
      createTime: existing.createTime,
      updateTime: formatTimestamp(),
      status: STATUS_ACTIVE,
    }
    this.state.personas = this.state.personas.map(persona => persona.id === id ? updated : persona)
    this.persist()
    return updated
  }

  /**
   * Remove a persona. The reserved default persona cannot be removed.
   * @returns true when removed, false when the id is unknown or reserved.
   */
  remove(id: string): boolean {
    if (id === DEFAULT_PERSONA.id) return false
    const existing = this.state.personas.find(persona => persona.id === id)
    if (existing === undefined || existing.status !== STATUS_ACTIVE) return false
    const softDeleted: Persona = { ...existing, updateTime: formatTimestamp(), status: STATUS_DELETED }
    this.state.personas = this.state.personas.map(persona => persona.id === id ? softDeleted : persona)
    this.persist()
    return true
  }

  private load(): StoredState {
    let personas: Persona[] = [...SEED_PERSONAS]
    let sessionAssignments: Record<string, string> = {}
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredState>
      // Map so records written before these fields existed still load cleanly.
      personas = (parsed.personas ?? personas).map(normalizePersona)
      sessionAssignments = parsed.sessionAssignments ?? {}
    } catch {
      // Missing or unreadable document: start from the seed without failing the plugin.
    }
    // Guarantee the always-available default appears even for documents seeded before it existed.
    if (!personas.some(persona => persona.id === DEFAULT_PERSONA.id)) {
      personas = [DEFAULT_PERSONA, ...personas]
    }
    return { personas, sessionAssignments }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, `${JSON.stringify(this.state, undefined, 2)}\n`)
  }
}
