import KVStore from '#models/kv_store'
import { UserSpaceService } from '#services/user_space_service'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'

const DOME_STATE_KEY = 'planner.domeState' as const
const DOME_AI_LOG_KEY = 'planner.aiLog' as const

interface DomePlannerDome {
  id: string
  name: string
  x: number
  y: number
  diameterFt: number
  heightFt: number
  notes: string
}

interface DomePlannerState {
  version: number
  projectName: string
  units: 'feet'
  domes: DomePlannerDome[]
  updatedAt: string
}

interface DomePlannerLogEntry {
  id: string
  actor: string
  kind: 'plan' | 'edit' | 'review' | 'note'
  summary: string
  expectedOutcome: string
  actualOutcome: string
  correction: string
  createdAt: string
}

function buildDefaultState(): DomePlannerState {
  return {
    version: 1,
    projectName: 'Dome House',
    units: 'feet',
    domes: [
      {
        id: 'main-dome',
        name: 'Main Dome',
        x: 0,
        y: 0,
        diameterFt: 24,
        heightFt: 16,
        notes: 'Primary central dome',
      },
    ],
    updatedAt: new Date().toISOString(),
  }
}

function buildDefaultLog(): DomePlannerLogEntry[] {
  return [
    {
      id: 'seed-log',
      actor: 'system',
      kind: 'plan',
      summary: 'Initialized Dome Planner with a starter main dome.',
      expectedOutcome: 'Give the design work a concrete starting point inside NOMAD.',
      actualOutcome: 'Main dome seeded at 24 ft diameter and 16 ft height.',
      correction: '',
      createdAt: new Date().toISOString(),
    },
  ]
}

function safeParseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

@inject()
export default class DomePlannerController {
  constructor(private userSpaceService: UserSpaceService) {}

  private async readState() {
    const rawState = await KVStore.getValue(DOME_STATE_KEY)
    const rawLog = await KVStore.getValue(DOME_AI_LOG_KEY)

    const state = safeParseJson<DomePlannerState>(rawState, buildDefaultState())
    const aiLog = safeParseJson<DomePlannerLogEntry[]>(rawLog, buildDefaultLog())

    return { state, aiLog }
  }

  async page({ inertia }: HttpContext) {
    const planner = await this.readState()
    return inertia.render('dome-planner', { planner })
  }

  async show({ response }: HttpContext) {
    return response.ok(await this.readState())
  }

  async saveState({ request, response }: HttpContext) {
    const body = request.body() as { state?: Partial<DomePlannerState> }
    const incoming = body?.state

    if (!incoming || typeof incoming !== 'object') {
      return response.badRequest({ error: 'A planner state payload is required.' })
    }

    const domes = Array.isArray(incoming.domes) ? incoming.domes : []
    const normalized: DomePlannerState = {
      version: 1,
      projectName: String(incoming.projectName || 'Dome House').trim() || 'Dome House',
      units: 'feet',
      domes: domes.map((dome: any, index: number) => ({
        id: String(dome?.id || `dome-${index + 1}`),
        name: String(dome?.name || `Dome ${index + 1}`),
        x: Number(dome?.x || 0),
        y: Number(dome?.y || 0),
        diameterFt: Number(dome?.diameterFt || 0),
        heightFt: Number(dome?.heightFt || 0),
        notes: String(dome?.notes || ''),
      })),
      updatedAt: new Date().toISOString(),
    }

    await KVStore.setValue(DOME_STATE_KEY, JSON.stringify(normalized))
    return response.ok({ success: true, state: normalized })
  }

  async addLogEntry({ request, response }: HttpContext) {
    const userSpace = await this.userSpaceService.resolveRequestSpace(request)
    const body = request.body() as { entry?: Partial<DomePlannerLogEntry> }
    const incoming = body?.entry

    if (!incoming || typeof incoming !== 'object') {
      return response.badRequest({ error: 'A log entry payload is required.' })
    }

    const current = await this.readState()
    const actorFromUser = userSpace?.user.displayName || 'user'
    const normalized: DomePlannerLogEntry = {
      id: `log-${Date.now()}`,
      actor: String(incoming.actor || actorFromUser),
      kind: ['plan', 'edit', 'review', 'note'].includes(String(incoming.kind))
        ? (incoming.kind as DomePlannerLogEntry['kind'])
        : 'note',
      summary: String(incoming.summary || '').trim(),
      expectedOutcome: String(incoming.expectedOutcome || '').trim(),
      actualOutcome: String(incoming.actualOutcome || '').trim(),
      correction: String(incoming.correction || '').trim(),
      createdAt: new Date().toISOString(),
    }

    if (!normalized.summary) {
      return response.badRequest({ error: 'Log summary is required.' })
    }

    const nextLog = [normalized, ...current.aiLog].slice(0, 200)
    await KVStore.setValue(DOME_AI_LOG_KEY, JSON.stringify(nextLog))
    return response.ok({ success: true, entry: normalized, aiLog: nextLog })
  }
}
