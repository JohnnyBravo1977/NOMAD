import { inject } from '@adonisjs/core'
import KVStore from '#models/kv_store'
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { promisify } from 'node:util'

const DEFAULT_INTERNAL_URL = 'http://nomad_openhands:3000'
const DEFAULT_EXTERNAL_URL = 'http://127.0.0.1:3001'
const DEFAULT_HOST_URL = 'http://host.docker.internal:3001'
const OPENHANDS_SESSIONS_DIR = '/openhands-data/sessions'
const execFileAsync = promisify(execFile)

type OpenHandsConversationResponse = {
  status?: string
  conversation_id?: string
  conversation_status?: string
  message?: string | null
}

type OpenHandsConversationInfo = {
  conversation_id?: string
  status?: string
  conversation_status?: string
  title?: string | null
}

type OpenHandsConversationEventsResponse = {
  events?: Array<{
    observation?: string
    extras?: {
      agent_state?: string
      reason?: string
    }
  }>
}

@inject()
export class OpenHandsWorkerService {
  private isDesktopShortcutGoal(goal: string): boolean {
    const cleaned = goal.trim().toLowerCase()
    if (!cleaned) return false
    return /\b(shortcut|launcher)\b/.test(cleaned) && /\b(create|make|add|put)\b/.test(cleaned)
  }

  private buildConversationInstructions(goal: string): string | undefined {
    if (!this.isDesktopShortcutGoal(goal)) return [
      'Use the isolated OpenHands workspace mounted at /workspace for any file changes.',
      'Do not assume access to the host home directory unless the task explicitly says that capability exists.',
    ].join('\n')

    return [
      'Host desktop shortcut creation is intentionally disabled right now.',
      'Do not attempt to write to the real host Desktop or the real host ~/.local/share/applications.',
      'If asked to create a host Ubuntu shortcut, explain that the missing capability is safe host-desktop access and stop there.',
      'Do not claim completion for a host-desktop launcher task.',
    ].join('\n')
  }

  private async listSessionIds(): Promise<string[]> {
    try {
      const entries = await readdir(OPENHANDS_SESSIONS_DIR, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  private async waitForNewSessionId(beforeIds: string[], timeoutMs: number = 30000): Promise<string | null> {
    const known = new Set(beforeIds)
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const currentIds = await this.listSessionIds()
      const newIds = currentIds.filter((id) => !known.has(id))

      if (newIds.length > 0) {
        const withTimes = await Promise.all(
          newIds.map(async (id) => {
            try {
              const entryStat = await stat(`${OPENHANDS_SESSIONS_DIR}/${id}`)
              return { id, mtimeMs: entryStat.mtimeMs }
            } catch {
              return { id, mtimeMs: 0 }
            }
          })
        )

        withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs)
        return withTimes[0]?.id || null
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    return null
  }

  private normalizeGoal(goal: string): string {
    return goal
      .replace(/^\s*(?:ok(?:ay)?|well|alright|all right|hey|hi|hello)\b[\s,!.:-]*/i, '')
      .replace(/^\s*(?:quinn|assistant)\b[\s,!.:-]*/i, '')
      .replace(/^\s*(?:can you|could you|would you|will you|please|i need you to)\b[\s,!.:-]*/i, '')
      .replace(/^\s*(?:please)\b[\s,!.:-]*/i, '')
      .trim()
  }

  private async curlJson(args: string[]): Promise<{ ok: boolean; stdout: string; statusCode: number | null }> {
    try {
      const { stdout } = await execFileAsync('curl', args, {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      })

      const lines = stdout.split('\n')
      const statusLine = lines.pop() || ''
      const statusCode = /^\d+$/.test(statusLine.trim()) ? Number(statusLine.trim()) : null
      return {
        ok: !!statusCode && statusCode >= 200 && statusCode < 300,
        stdout: lines.join('\n'),
        statusCode,
      }
    } catch (error: any) {
      const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
      const lines = stdout.split('\n')
      const statusLine = lines.pop() || ''
      const statusCode = /^\d+$/.test(statusLine.trim()) ? Number(statusLine.trim()) : null
      return {
        ok: false,
        stdout: lines.join('\n'),
        statusCode,
      }
    }
  }

  async getInternalUrl(): Promise<string> {
    const stored = await KVStore.getValue('ai.openhandsUrl')
    const value = typeof stored === 'string' ? stored.trim() : ''
    return value || DEFAULT_INTERNAL_URL
  }

  async checkAvailable(): Promise<{ available: boolean; url: string }> {
    const candidateUrls = [await this.getInternalUrl(), DEFAULT_HOST_URL]

    for (const url of candidateUrls) {
      const response = await this.curlJson([
        '--max-time',
        '15',
        '-sS',
        '-o',
        '-',
        '-w',
        '\n%{http_code}',
        `${url}/openapi.json`,
      ])

      if (response.ok) {
        return { available: true, url }
      }
    }

    return { available: false, url: candidateUrls[0] }
  }

  async startTask(goal: string): Promise<{
    ok: boolean
    url: string
    conversationId?: string
    conversationStatus?: string
    message?: string
  }> {
    const normalizedGoal = this.normalizeGoal(goal)
    if (this.isDesktopShortcutGoal(normalizedGoal)) {
      return {
        ok: false,
        url: await this.getInternalUrl(),
        message: [
          'Missing capability: verified host Ubuntu desktop shortcut creation is intentionally disabled right now.',
          'Current status:',
          '- OpenHands is isolated from the real host home directory for safety.',
          '- To do this again safely, we would need a narrower approved host-action bridge instead of direct home-directory access.',
        ].join('\n'),
      }
    }
    const conversationInstructions = this.buildConversationInstructions(normalizedGoal)
    const knownSessionIds = await this.listSessionIds()
    const candidateUrls = [await this.getInternalUrl(), DEFAULT_HOST_URL]
    let lastError = ''

    for (const url of candidateUrls) {
      const response = await this.curlJson([
        '--max-time',
        '8',
        '-sS',
        '-X',
        'POST',
        '-H',
        'Content-Type: application/json',
        '-o',
        '-',
        '-w',
        '\n%{http_code}',
        `${url}/api/conversations`,
        '--data',
        JSON.stringify({
          initial_user_msg: normalizedGoal,
          conversation_instructions: conversationInstructions,
        }),
      ])

      try {
        const data = JSON.parse(response.stdout) as OpenHandsConversationResponse
        if (response.ok && data.status === 'ok' && data.conversation_id) {
          return {
            ok: true,
            url,
            conversationId: data.conversation_id,
            conversationStatus: data.conversation_status,
          }
        }

        lastError =
          data.message ||
          `OpenHands returned ${response.statusCode ?? 'an unknown'} status when starting the task.`
      } catch (error) {
        if (response.stdout.trim()) {
          lastError = response.stdout.trim()
        } else if (error instanceof Error) {
          lastError = error.message
        }
      }

      const fallbackConversationId = await this.waitForNewSessionId(knownSessionIds, 12000)
      if (fallbackConversationId) {
        const fallbackStatus = await this.getConversationStatus(fallbackConversationId)
        return {
          ok: true,
          url,
          conversationId: fallbackConversationId,
          conversationStatus:
            fallbackStatus.conversationStatus || fallbackStatus.agentState || 'starting',
        }
      }
    }

    return {
      ok: false,
      url: candidateUrls[0],
      message: lastError || `OpenHands is not reachable at ${candidateUrls[0]}.`,
    }
  }

  async getConversationStatus(conversationId?: string | null): Promise<{
    ok: boolean
    url: string
    conversationId?: string
    conversationStatus?: string
    agentState?: string
    reason?: string
    message?: string
  }> {
    const { available, url } = await this.checkAvailable()
    if (!available) {
      return {
        ok: false,
        url,
        message: `OpenHands is not reachable at ${url}.`,
      }
    }

    const id = conversationId?.trim() || (await KVStore.getValue('ai.openhandsLastConversationId')) || ''
    if (!id) {
      return {
        ok: false,
        url,
        message: 'There is no recorded OpenHands conversation to check right now.',
      }
    }

    const response = await this.curlJson([
      '--max-time',
      '20',
      '-sS',
      '-o',
      '-',
      '-w',
      '\n%{http_code}',
      `${url}/api/conversations/${id}`,
    ])

    try {
      const data = JSON.parse(response.stdout) as OpenHandsConversationInfo
      if (!response.ok) {
        return {
          ok: false,
          url,
          conversationId: id,
          message:
            `OpenHands returned ${response.statusCode ?? 'an unknown'} status when checking conversation ${id}.`,
        }
      }

      let agentState: string | undefined
      let reason: string | undefined
      const eventsResponse = await this.curlJson([
        '--max-time',
        '20',
        '-sS',
        '-o',
        '-',
        '-w',
        '\n%{http_code}',
        `${url}/api/conversations/${id}/events`,
      ])
      if (eventsResponse.ok) {
        try {
          const eventsData = JSON.parse(eventsResponse.stdout) as OpenHandsConversationEventsResponse
          const events = eventsData.events || []
          const latestStateEvent = [...events]
            .reverse()
            .find((event) => event.observation === 'agent_state_changed' && event.extras?.agent_state)
          agentState = latestStateEvent?.extras?.agent_state
          reason =
            [...events]
              .reverse()
              .find(
              (event) => event.observation === 'agent_state_changed' && event.extras?.reason
              )?.extras?.reason || undefined
        } catch {
          // Ignore event parse issues and fall back to coarse conversation status.
        }
      }

      return {
        ok: true,
        url,
        conversationId: data.conversation_id || id,
        conversationStatus: data.conversation_status || data.status,
        agentState,
        reason,
      }
    } catch (error) {
      return {
        ok: false,
        url,
        conversationId: id,
        message:
          response.stdout.trim() ||
          (error instanceof Error ? error.message : `Could not read OpenHands conversation ${id}.`),
      }
    }
  }

  async delegateTask(goal: string): Promise<string> {
    const normalizedGoal = this.normalizeGoal(goal)
    const task = await this.startTask(normalizedGoal)
    if (!task.ok) {
      return task.message || 'OpenHands could not accept the task.'
    }

    if (task.conversationId) {
      await KVStore.setValue('ai.openhandsLastConversationId', task.conversationId)
    }

    return [
      `OpenHands accepted the task: ${normalizedGoal}`,
      `Conversation ID: ${task.conversationId}`,
      `Conversation status: ${task.conversationStatus || 'starting'}`,
      `Internal URL: ${task.url}`,
      `External UI: ${DEFAULT_EXTERNAL_URL}`,
    ].join('\n')
  }

  async describeCapabilities(): Promise<string> {
    const { available, url } = await this.checkAvailable()
    const status = available ? 'available' : 'unavailable'

    return [
      'OpenHands worker capabilities:',
      '- Discover whether the OpenHands agent sidecar is reachable',
      '- Start an OpenHands conversation for explicit task handoff',
      '- Report the internal API/UI endpoint used for agent execution',
      'Current OpenHands status:',
      `- Status: ${status}`,
      `- Internal URL: ${url}`,
      `- External UI: ${DEFAULT_EXTERNAL_URL}`,
      'Current limits:',
      '- Quinn only hands off tasks to OpenHands when explicitly asked to use OpenHands',
      '- Quinn can check the latest delegated OpenHands conversation status, but does not yet stream its intermediate events back into chat',
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<string | null> {
    const text = userText.trim()
    if (!/\b(?:openhands|open hands)\b/i.test(text)) return null

    if (/\b(?:status|available|availability|reachable|health|check)\b/i.test(text)) {
      const idMatch = text.match(/\b([a-f0-9]{32})\b/i)
      const wantsConversationStatus = /\b(?:conversation|task|run|job)\b/i.test(text) || !!idMatch
      if (wantsConversationStatus) {
        const status = await this.getConversationStatus(idMatch?.[1] || null)
        if (!status.ok) {
          return status.message || 'OpenHands conversation status is unavailable right now.'
        }

        const lines = [
          `OpenHands conversation status: ${status.conversationStatus || 'unknown'}`,
        ]
        if (status.agentState) {
          lines.push(`Agent state: ${status.agentState.toUpperCase()}`)
        }
        if (status.reason) {
          lines.push(`Reason: ${status.reason}`)
        }

        return [
          ...lines,
          `Conversation ID: ${status.conversationId}`,
          `Internal URL: ${status.url}`,
          `External UI: ${DEFAULT_EXTERNAL_URL}`,
        ].join('\n')
      }

      const { available, url } = await this.checkAvailable()

      if (!available) {
        return `OpenHands is not reachable right now at ${url}. External UI is expected on ${DEFAULT_EXTERNAL_URL} once the service is running.`
      }

      return `OpenHands is reachable at ${url}, and the external UI is available at ${DEFAULT_EXTERNAL_URL}.`
    }

    const explicitDelegation =
      text.match(/\b(?:use|run|send|hand\s*off|delegate|have)\s+(?:this\s+)?(?:task\s+)?(?:to\s+)?(?:openhands|open hands)\b[\s:,-]*(.+)$/i) ||
      text.match(/\b(?:openhands|open hands)\b[\s:,-]*(?:please\s+)?(?:can\s+you\s+)?(?:handle|do|work on|take|run|inspect|solve|fix|create)\b[\s:,-]*(.+)$/i)

    const delegatedGoal = explicitDelegation?.[1]?.trim()
    if (!delegatedGoal) return null

    return this.delegateTask(delegatedGoal)
  }
}
