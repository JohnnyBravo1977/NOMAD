import { inject } from '@adonisjs/core'
import { DockerService } from '#services/docker_service'
import KVStore from '#models/kv_store'

type HaState = {
  entity_id: string
  state: string
  attributes?: Record<string, any>
}

@inject()
export class HomeAssistantService {
  constructor(private dockerService: DockerService) {}

  async getStates(): Promise<HaState[]> {
    const response = await this.request('GET', '/api/states')
    return Array.isArray(response) ? response : []
  }

  async getState(entityId: string): Promise<HaState | null> {
    const response = await this.request('GET', `/api/states/${entityId}`)
    return response && typeof response === 'object' ? response as HaState : null
  }

  async callService(domain: string, service: string, serviceData: Record<string, any>): Promise<any> {
    return this.request('POST', `/api/services/${domain}/${service}`, serviceData)
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getStates()
      return true
    } catch {
      return false
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
    const containers = await this.dockerService.docker.listContainers({ all: true })
    const haContainer = containers.find((container) =>
      container.Names.some((name) => name.replace(/^\//, '') === 'homeassistant')
    )
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
}
