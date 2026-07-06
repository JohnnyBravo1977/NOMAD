import { inject } from '@adonisjs/core'
import { DockerService } from '#services/docker_service'
import KVStore from '#models/kv_store'

type HaState = {
  entity_id: string
  state: string
  attributes?: Record<string, any>
}

type HaAreaRegistryEntry = {
  id: string
  name?: string
  aliases?: string[]
}

type HaDeviceRegistryEntry = {
  id: string
  area_id?: string | null
  name?: string | null
  name_by_user?: string | null
}

type HaEntityRegistryEntry = {
  entity_id: string
  device_id?: string | null
  area_id?: string | null
}

type HaRegistrySnapshot = {
  areas: HaAreaRegistryEntry[]
  devices: HaDeviceRegistryEntry[]
  entities: HaEntityRegistryEntry[]
}

type TimedCache<T> = {
  value: T
  expiresAt: number
}

@inject()
export class HomeAssistantService {
  private statesCache: TimedCache<HaState[]> | null = null
  private availabilityCache: TimedCache<boolean> | null = null
  private registrySnapshotCache: TimedCache<HaRegistrySnapshot> | null = null

  private static STATES_CACHE_MS = 2500
  private static AVAILABILITY_CACHE_MS = 5000
  private static REGISTRY_CACHE_MS = 60 * 1000

  constructor(private dockerService: DockerService) {}

  async getStates(): Promise<HaState[]> {
    const cached = this.getFreshCache(this.statesCache)
    if (cached) {
      return cached
    }

    const response = await this.request('GET', '/api/states')
    const states = Array.isArray(response) ? response : []
    this.statesCache = {
      value: states,
      expiresAt: Date.now() + HomeAssistantService.STATES_CACHE_MS,
    }
    this.availabilityCache = {
      value: true,
      expiresAt: Date.now() + HomeAssistantService.AVAILABILITY_CACHE_MS,
    }
    return states
  }

  async getState(entityId: string): Promise<HaState | null> {
    const cachedStates = this.getFreshCache(this.statesCache)
    if (cachedStates) {
      return cachedStates.find((state) => state.entity_id === entityId) || null
    }

    const response = await this.request('GET', `/api/states/${entityId}`)
    return response && typeof response === 'object' ? response as HaState : null
  }

  async callService(domain: string, service: string, serviceData: Record<string, any>): Promise<any> {
    const response = await this.request('POST', `/api/services/${domain}/${service}`, serviceData)
    this.invalidateStateCaches()
    return response
  }

  async isAvailable(): Promise<boolean> {
    const cached = this.getFreshCache(this.availabilityCache)
    if (typeof cached === 'boolean') {
      return cached
    }

    try {
      await this.getStates()
      this.availabilityCache = {
        value: true,
        expiresAt: Date.now() + HomeAssistantService.AVAILABILITY_CACHE_MS,
      }
      return true
    } catch {
      this.availabilityCache = {
        value: false,
        expiresAt: Date.now() + HomeAssistantService.AVAILABILITY_CACHE_MS,
      }
      return false
    }
  }

  async findAreaLightTargets(areaRef: string): Promise<{ areaName: string; entityIds: string[] } | null> {
    const normalizedRef = this.normalizeAreaReference(areaRef)
    if (!normalizedRef) return null

    const [registries, states] = await Promise.all([this.getRegistrySnapshot(), this.getStates()])
    const area = this.findBestAreaMatch(registries.areas, normalizedRef)
    if (!area) return null

    const deviceAreaById = new Map(
      registries.devices.map((device) => [device.id, device.area_id || null])
    )

    const lightEntityIds = registries.entities
      .filter((entity) => entity.entity_id.startsWith('light.'))
      .filter((entity) => {
        const entityAreaId = entity.area_id || deviceAreaById.get(entity.device_id || '') || null
        return entityAreaId === area.id
      })
      .map((entity) => entity.entity_id)

    if (!lightEntityIds.length) return null

    const liveEntityIds = new Set(states.map((state) => state.entity_id))
    const availableEntityIds = lightEntityIds.filter((entityId) => liveEntityIds.has(entityId))
    if (!availableEntityIds.length) return null

    return {
      areaName: area.name?.trim() || area.id,
      entityIds: availableEntityIds,
    }
  }

  private async getRawSetting(key: string): Promise<string | null> {
    const row = await KVStore.query().where('key', key).first()
    const value = row?.value
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

  private async request(method: 'GET' | 'POST', endpoint: string, body?: Record<string, any>) {
    const remoteUrl = await this.getRawSetting('ai.homeAssistantUrl')
    const remoteToken = await this.getRawSetting('ai.homeAssistantToken')

    if (remoteUrl && remoteToken) {
      const response = await fetch(`${remoteUrl.replace(/\/$/, '')}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${remoteToken}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!response.ok) {
        throw new Error(`Home Assistant request failed with HTTP ${response.status}`)
      }
      return await response.json()
    }

    return await this.requestViaLocalContainer(method, endpoint, body)
  }

  private async requestViaLocalContainer(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: Record<string, any>
  ) {
    const haContainer = await this.getHaContainer()
    if (!haContainer) {
      throw new Error('Home Assistant container is not available.')
    }

    const script = `
import json, sys, urllib.request, urllib.parse

METHOD = sys.argv[1]
ENDPOINT = sys.argv[2]
BODY = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None

with open('/config/.storage/auth', 'r', encoding='utf-8') as f:
    auth = json.load(f)['data']

owner = next((u for u in auth.get('users', []) if u.get('is_owner')), None)
if owner is None:
    raise SystemExit('No Home Assistant owner user found')

tokens = [t for t in auth.get('refresh_tokens', []) if t.get('user_id') == owner.get('id')]
if not tokens:
    raise SystemExit('No Home Assistant refresh token found for owner user')

token = next((t for t in tokens if t.get('token_type') == 'normal'), tokens[0])
refresh_token = token.get('token')
client_id = token.get('client_id') or 'http://localhost:8123/'

token_payload = urllib.parse.urlencode({
    'grant_type': 'refresh_token',
    'client_id': client_id,
    'refresh_token': refresh_token,
}).encode('utf-8')

token_req = urllib.request.Request(
    'http://127.0.0.1:8123/auth/token',
    data=token_payload,
    headers={'Content-Type': 'application/x-www-form-urlencoded'},
    method='POST'
)
with urllib.request.urlopen(token_req, timeout=10) as token_res:
    access_token = json.loads(token_res.read().decode('utf-8'))['access_token']

req_headers = {
    'Authorization': f'Bearer {access_token}',
    'Content-Type': 'application/json',
}

request_body = json.dumps(BODY).encode('utf-8') if BODY is not None else None
req = urllib.request.Request(
    f'http://127.0.0.1:8123{ENDPOINT}',
    data=request_body,
    headers=req_headers,
    method=METHOD
)
with urllib.request.urlopen(req, timeout=10) as res:
    text = res.read().decode('utf-8')
    print(text)
`.trim()

    const exec = await this.dockerService.docker.getContainer(haContainer.Id).exec({
      Cmd: ['python3', '-c', script, method, endpoint, body ? JSON.stringify(body) : ''],
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    })

    const stream = await exec.start({ Tty: true })
    const output = await new Promise<string>((resolve, reject) => {
      let data = ''
      stream.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf-8')
      })
      stream.on('end', () => resolve(data.trim()))
      stream.on('error', reject)
    })

    if (!output) return null
    try {
      return JSON.parse(output)
    } catch {
      throw new Error(output)
    }
  }

  private async getRegistrySnapshot(): Promise<HaRegistrySnapshot> {
    const cached = this.getFreshCache(this.registrySnapshotCache)
    if (cached) {
      return cached
    }

    const haContainer = await this.getHaContainer()
    if (!haContainer) {
      throw new Error('Home Assistant container is not available.')
    }

    const script = `
import json

def read_json(filename):
    with open(filename, 'r', encoding='utf-8') as f:
        return json.load(f)

areas = read_json('/config/.storage/core.area_registry')['data'].get('areas', [])
devices = read_json('/config/.storage/core.device_registry')['data'].get('devices', [])
entities = read_json('/config/.storage/core.entity_registry')['data'].get('entities', [])

print(json.dumps({
    'areas': areas,
    'devices': devices,
    'entities': entities,
}))
`.trim()

    const exec = await this.dockerService.docker.getContainer(haContainer.Id).exec({
      Cmd: ['python3', '-c', script],
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    })

    const stream = await exec.start({ Tty: true })
    const output = await new Promise<string>((resolve, reject) => {
      let data = ''
      stream.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf-8')
      })
      stream.on('end', () => resolve(data.trim()))
      stream.on('error', reject)
    })

    const snapshot = !output
      ? { areas: [], devices: [], entities: [] }
      : (JSON.parse(output) as HaRegistrySnapshot)

    this.registrySnapshotCache = {
      value: snapshot,
      expiresAt: Date.now() + HomeAssistantService.REGISTRY_CACHE_MS,
    }

    return snapshot
  }

  private async getHaContainer() {
    const containers = await this.dockerService.docker.listContainers({ all: true })
    return containers.find((container) =>
      container.Names.some((name) => name.replace(/^\//, '') === 'homeassistant')
    )
  }

  private findBestAreaMatch(
    areas: HaAreaRegistryEntry[],
    normalizedRef: string
  ): HaAreaRegistryEntry | null {
    let best: { area: HaAreaRegistryEntry; score: number } | null = null

    for (const area of areas) {
      const candidates = [area.name || '', ...(area.aliases || [])]
        .map((value) => this.normalizeAreaReference(value))
        .filter(Boolean)

      for (const candidate of candidates) {
        let score = 0
        if (candidate === normalizedRef) {
          score = 100
        } else if (normalizedRef.includes(candidate) || candidate.includes(normalizedRef)) {
          score = 85
        } else {
          const needleTokens = new Set(normalizedRef.split(' ').filter(Boolean))
          const matchedTokens = candidate
            .split(' ')
            .filter((token) => needleTokens.has(token)).length
          if (matchedTokens > 0) {
            score = matchedTokens * 10
          }
        }

        if (score > 0 && (!best || score > best.score)) {
          best = { area, score }
        }
      }
    }

    return best?.area || null
  }

  private normalizeAreaReference(value: string): string {
    return value
      .toLowerCase()
      .replace(/[_./-]+/g, ' ')
      .replace(/\b(the|a|an|my|all)\b/g, ' ')
      .replace(/\b(lights|light|lamps|lamp)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private getFreshCache<T>(cache: TimedCache<T> | null): T | null {
    if (!cache) return null
    if (cache.expiresAt <= Date.now()) return null
    return cache.value
  }

  private invalidateStateCaches() {
    this.statesCache = null
    this.availabilityCache = null
  }
}
