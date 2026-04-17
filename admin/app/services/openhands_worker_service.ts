import { inject } from '@adonisjs/core'
import KVStore from '#models/kv_store'
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { promisify } from 'node:util'

const DEFAULT_INTERNAL_URL = 'http://nomad_openhands:3000'
const DEFAULT_EXTERNAL_URL = 'http://127.0.0.1:3001'
const DEFAULT_HOST_URL = 'http://host.docker.internal:3001'
const OPENHANDS_SESSIONS_DIR = '/openhands-data/sessions'
const OPENHANDS_PREWARM_GOAL =
  'Prewarm the isolated workspace runtime. Run pwd && ls once inside /workspace, do not modify files, then wait for further instruction.'
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
    id?: number
    source?: string
    message?: string
    content?: string
    observation?: string
    extras?: {
      agent_state?: string
      reason?: string
    }
  }>
}

@inject()
export class OpenHandsWorkerService {
  private isWarmConversationActive(status: {
    ok: boolean
    conversationStatus?: string
    agentState?: string
  }): boolean {
    if (!status.ok) return false

    const conversationStatus = (status.conversationStatus || '').toLowerCase()
    const agentState = (status.agentState || '').toLowerCase()

    return (
      conversationStatus === 'starting' ||
      conversationStatus === 'running' ||
      agentState === 'loading' ||
      agentState === 'running' ||
      agentState === 'awaiting_user_input'
    )
  }

  private summarizeLatestUpdate(update?: string): string | null {
    const text = update?.trim()
    if (!text) return null

    if (/^Running command:/i.test(text)) {
      return text.replace(/^Running command:\s*/i, 'Latest action: ')
    }

    return text
      .replace(/\s+/g, ' ')
      .trim()
  }

  private formatAcceptedTaskMessage(goal: string, conversationId?: string, conversationStatus?: string): string {
    const lines = [
      `I handed that to OpenHands: ${goal}.`,
    ]

    if ((conversationStatus || '').toLowerCase() === 'starting') {
      lines.push('It is starting up now, so the first useful result may take a moment.')
    }

    if (conversationId) {
      lines.push(`Conversation ID: ${conversationId}`)
    }

    lines.push(`OpenHands UI: ${DEFAULT_EXTERNAL_URL}`)
    lines.push('Ask me to check OpenHands task status if you want the latest progress.')
    return lines.join('\n')
  }

  private formatConversationStatusMessage(status: {
    conversationId?: string
    conversationStatus?: string
    agentState?: string
    reason?: string
    latestUpdate?: string
  }): string {
    const state = (status.agentState || '').toLowerCase()
    const conversationStatus = status.conversationStatus || 'unknown'
    const latestUpdate = this.summarizeLatestUpdate(status.latestUpdate)

    const lines: string[] = []

    if (state === 'loading' || conversationStatus.toLowerCase() === 'starting') {
      lines.push('OpenHands is still starting up.')
    } else if (state === 'awaiting_user_input') {
      lines.push('OpenHands finished its latest step and is waiting for the next instruction.')
    } else if (state === 'running') {
      lines.push('OpenHands is working on the task now.')
    } else if (state === 'finished') {
      lines.push('OpenHands finished the task.')
    } else if (state === 'stopped') {
      lines.push('OpenHands stopped.')
    } else {
      lines.push(`OpenHands conversation status: ${conversationStatus}`)
    }

    if (latestUpdate) {
      lines.push(latestUpdate)
    }

    if (status.reason) {
      lines.push(`Reason: ${status.reason}`)
    }

    if (status.conversationId) {
      lines.push(`Conversation ID: ${status.conversationId}`)
    }

    lines.push(`OpenHands UI: ${DEFAULT_EXTERNAL_URL}`)
    return lines.join('\n')
  }

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

  private buildPrewarmConversationInstructions(): string {
    return [
      'This is a runtime prewarm task for future delegated work.',
      'Use the isolated OpenHands workspace mounted at /workspace.',
      'Run one lightweight inspection command in /workspace to force the runtime and tools to initialize.',
      'Do not modify files, do not ask the user a question unless something is actually broken, and stop after the initial inspection.',
      'After the inspection, wait for further instruction so the sandbox can remain warm for later tasks.',
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

  private async createConversationWithFallback(
    goal: string,
    conversationInstructions: string | undefined,
    options?: {
      requestTimeoutSeconds?: number
      sessionWaitTimeoutMs?: number
    }
  ): Promise<{
    ok: boolean
    url: string
    conversationId?: string
    conversationStatus?: string
    message?: string
  }> {
    const knownSessionIds = await this.listSessionIds()
    const candidateUrls = [await this.getInternalUrl(), DEFAULT_HOST_URL]
    const requestTimeoutSeconds = options?.requestTimeoutSeconds ?? 8
    const sessionWaitTimeoutMs = options?.sessionWaitTimeoutMs ?? 12000
    let lastError = ''

    for (const url of candidateUrls) {
      const response = await this.curlJson([
        '--max-time',
        String(requestTimeoutSeconds),
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
          initial_user_msg: goal,
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

      const fallbackConversationId = await this.waitForNewSessionId(knownSessionIds, sessionWaitTimeoutMs)
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
    const conversationInstructions =
      normalizedGoal === OPENHANDS_PREWARM_GOAL
        ? this.buildPrewarmConversationInstructions()
        : this.buildConversationInstructions(normalizedGoal)
    return this.createConversationWithFallback(normalizedGoal, conversationInstructions)
  }

  async ensureWarmRuntime(force: boolean = false): Promise<{
    ok: boolean
    url: string
    conversationId?: string
    conversationStatus?: string
    message?: string
    created?: boolean
  }> {
    const url = await this.getInternalUrl()
    const warmConversationId = await KVStore.getValue('ai.openhandsWarmConversationId')

    if (warmConversationId && !force) {
      const existingStatus = await this.getConversationStatus(warmConversationId)
      if (this.isWarmConversationActive(existingStatus)) {
        return {
          ok: true,
          url: existingStatus.url,
          conversationId: existingStatus.conversationId,
          conversationStatus:
            existingStatus.agentState || existingStatus.conversationStatus || 'running',
          created: false,
        }
      }
    }

    const warmTask = await this.createConversationWithFallback(
      OPENHANDS_PREWARM_GOAL,
      this.buildPrewarmConversationInstructions(),
      {
        requestTimeoutSeconds: 20,
        sessionWaitTimeoutMs: 45000,
      }
    )
    if (!warmTask.ok) {
      return {
        ok: false,
        url: warmTask.url || url,
        message: warmTask.message || 'OpenHands prewarm could not be started.',
      }
    }

    if (warmTask.conversationId) {
      await KVStore.setValue('ai.openhandsWarmConversationId', warmTask.conversationId)
    }

    return {
      ok: true,
      url: warmTask.url,
      conversationId: warmTask.conversationId,
      conversationStatus: warmTask.conversationStatus,
      created: true,
    }
  }

  async getConversationStatus(conversationId?: string | null): Promise<{
    ok: boolean
    url: string
    conversationId?: string
    conversationStatus?: string
    agentState?: string
    reason?: string
    latestUpdate?: string
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
      let latestUpdate: string | undefined
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
          latestUpdate =
            [...events]
              .reverse()
              .find((event) => {
                const text = (event.message || event.content || '').trim()
                if (!text) return false
                if (event.source !== 'agent') return false
                if (text.startsWith('You are OpenHands agent')) return false
                return true
              })
              ?.message?.trim() ||
            [...events]
              .reverse()
              .find((event) => {
                const text = (event.message || event.content || '').trim()
                if (!text) return false
                if (event.source !== 'agent') return false
                if (text.startsWith('You are OpenHands agent')) return false
                return true
              })
              ?.content?.trim() ||
            undefined
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
        latestUpdate,
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

    return this.formatAcceptedTaskMessage(
      normalizedGoal,
      task.conversationId,
      task.conversationStatus
    )
  }

  async describeCapabilities(): Promise<string> {
    const { available, url } = await this.checkAvailable()
    const status = available ? 'available' : 'unavailable'
    const warmConversationId = await KVStore.getValue('ai.openhandsWarmConversationId')
    const warmStatus = warmConversationId
      ? await this.getConversationStatus(warmConversationId)
      : null

    return [
      'OpenHands worker capabilities:',
      '- Discover whether the OpenHands agent sidecar is reachable',
      '- Start an OpenHands conversation for explicit task handoff',
      '- Report the internal API/UI endpoint used for agent execution',
      'Current OpenHands status:',
      `- Status: ${status}`,
      `- Internal URL: ${url}`,
      `- External UI: ${DEFAULT_EXTERNAL_URL}`,
      `- Warm runtime: ${
        warmStatus && this.isWarmConversationActive(warmStatus)
          ? `ready (${warmStatus.conversationId})`
          : 'not ready'
      }`,
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

        return this.formatConversationStatusMessage(status)
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
