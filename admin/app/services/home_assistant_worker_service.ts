import { inject } from '@adonisjs/core'
import { HomeAssistantService } from '#services/home_assistant_service'

type HaTask =
  | { kind: 'list_entities' }
  | { kind: 'get_state'; entityRef: string }
  | { kind: 'call_service'; domain: string; service: string; data: Record<string, any> }

type HaState = {
  entity_id: string
  state: string
  attributes?: Record<string, any>
}

@inject()
export class HomeAssistantWorkerService {
  constructor(private homeAssistantService: HomeAssistantService) {}

  private isEntityId(value: string): boolean {
    return /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(value.trim())
  }

  async tryHandle(userText: string): Promise<string | null> {
    const task = this.parseTask(userText)
    if (!task) return null

    const available = await this.homeAssistantService.isAvailable()
    if (!available) {
      return `Home Assistant is not reachable yet.`
    }

    switch (task.kind) {
      case 'list_entities':
        return this.listEntities()
      case 'get_state':
        return this.getEntityState(task.entityRef)
      case 'call_service':
        return this.callService(task.domain, task.service, task.data)
      default:
        return null
    }
  }

  private parseTask(userText: string): HaTask | null {
    const text = userText.trim()

    if (/\b(home assistant|ha)\b/i.test(text) && /\b(list|show).*(entities|devices|states)\b/i.test(text)) {
      return { kind: 'list_entities' }
    }

    if (/\bshopping list\b/i.test(text) && /\badd\b/i.test(text)) {
      const match = text.match(/\badd\s+["']?(.+?)["']?\s+to\s+(?:the\s+)?shopping list\b/i)
      if (match) {
        return {
          kind: 'call_service',
          domain: 'todo',
          service: 'add_item',
          data: { entity_id: 'todo.shopping_list', item: match[1] },
        }
      }
    }

    let match =
      text.match(/\b(?:state|status) of (?:entity )?([a-z0-9_]+\.[a-z0-9_]+)\b/i) ||
      text.match(/\bwhat(?:'s| is) the state of (?:entity )?([a-z0-9_]+\.[a-z0-9_]+)\b/i)
    if (match) {
      return { kind: 'get_state', entityRef: match[1].toLowerCase() }
    }

    match =
      text.match(/\b(?:state|status) of (.+)\b/i) ||
      text.match(/\bwhat(?:'s| is) the state of (.+)\b/i) ||
      text.match(/\bwhat(?:'s| is) the status of (.+)\b/i)
    if (match) {
      return { kind: 'get_state', entityRef: this.cleanEntityReference(match[1]) }
    }

    match = text.match(/\b(?:turn on|turn off|lock|unlock)\s+([a-z0-9_]+\.[a-z0-9_]+)\b/i)
    if (match) {
      const entityId = match[1].toLowerCase()
      const action = text.toLowerCase()
      if (action.includes('turn on')) {
        return {
          kind: 'call_service',
          domain: entityId.split('.')[0],
          service: 'turn_on',
          data: { entity_id: entityId },
        }
      }
      if (action.includes('turn off')) {
        return {
          kind: 'call_service',
          domain: entityId.split('.')[0],
          service: 'turn_off',
          data: { entity_id: entityId },
        }
      }
      if (action.includes('lock')) {
        return {
          kind: 'call_service',
          domain: 'lock',
          service: 'lock',
          data: { entity_id: entityId },
        }
      }
      if (action.includes('unlock')) {
        return {
          kind: 'call_service',
          domain: 'lock',
          service: 'unlock',
          data: { entity_id: entityId },
        }
      }
    }

    match = text.match(/\b(turn on|turn off|lock|unlock)\s+(.+)\b/i)
    if (match) {
      const action = match[1].toLowerCase()
      const target = this.cleanEntityReference(match[2])
      if (!target) return null
      if (action === 'turn on') {
        return { kind: 'call_service', domain: 'homeassistant', service: 'turn_on', data: { entity_ref: target } }
      }
      if (action === 'turn off') {
        return { kind: 'call_service', domain: 'homeassistant', service: 'turn_off', data: { entity_ref: target } }
      }
      if (action === 'lock') {
        return { kind: 'call_service', domain: 'lock', service: 'lock', data: { entity_ref: target } }
      }
      if (action === 'unlock') {
        return { kind: 'call_service', domain: 'lock', service: 'unlock', data: { entity_ref: target } }
      }
    }

    return null
  }

  private async listEntities(): Promise<string> {
    const states = await this.homeAssistantService.getStates()
    const entities = states
      .filter((state) => state.entity_id)
      .slice(0, 30)
      .map((state) => `${state.entity_id}: ${state.state}`)

    if (entities.length === 0) {
      return `Home Assistant is up, but I don't see any entities yet.`
    }

    return `Home Assistant entities:\n${entities.join('\n')}`
  }

  private async getEntityState(entityRef: string): Promise<string> {
    const state = await this.findBestEntityMatch(entityRef)
    if (state) {
      return this.describeState(state)
    }
    return `I couldn't find a Home Assistant entity matching ${entityRef}.`
  }

  private async callService(domain: string, service: string, data: Record<string, any>): Promise<string> {
    const entityId = await this.resolveEntityIdForService(domain, data)
    const serviceData = { ...data }
    delete serviceData.entity_ref
    if (entityId) {
      serviceData.entity_id = entityId
    }

    await this.homeAssistantService.callService(domain, service, serviceData)
    if (!entityId) {
      return `Home Assistant service ${domain}.${service} completed.`
    }

    const state = await this.homeAssistantService.getState(entityId)
    if (!state) {
      return `Home Assistant service ${domain}.${service} completed for ${entityId}.`
    }

    return `Home Assistant service ${domain}.${service} completed.\n${this.describeState(state)}`
  }

  private describeState(state: { entity_id: string; state: string; attributes?: Record<string, any> }): string {
    const friendlyName = state.attributes?.friendly_name ? ` (${state.attributes.friendly_name})` : ''
    const parts = [`${state.entity_id}${friendlyName}: ${state.state}`]
    if (typeof state.attributes?.temperature !== 'undefined') {
      parts.push(`temperature=${state.attributes.temperature}`)
    }
    if (typeof state.attributes?.current_temperature !== 'undefined') {
      parts.push(`current_temperature=${state.attributes.current_temperature}`)
    }
    return parts.join('\n')
  }

  private cleanEntityReference(value: string): string {
    return value
      .trim()
      .replace(/[?.!,]+$/g, '')
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/\s+(?:please|for me)$/i, '')
      .trim()
  }

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[_./-]+/g, ' ')
      .replace(/\b(the|a|an|my)\b/g, ' ')
      .replace(/\b(lights)\b/g, 'light')
      .replace(/\b(doors)\b/g, 'door')
      .replace(/\b(locks)\b/g, 'lock')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private async resolveEntityIdForService(domain: string, data: Record<string, any>): Promise<string | null> {
    if (typeof data.entity_id === 'string') {
      return data.entity_id
    }

    const entityRef = typeof data.entity_ref === 'string' ? data.entity_ref : null
    if (!entityRef) return null

    const domainHints =
      domain === 'lock'
        ? ['lock']
        : domain === 'homeassistant'
          ? ['light', 'switch', 'fan', 'cover', 'script', 'scene', 'input_boolean']
          : [domain]

    const match = await this.findBestEntityMatch(entityRef, domainHints)
    if (!match) {
      throw new Error(`I couldn't find a Home Assistant entity matching ${entityRef}.`)
    }

    return match.entity_id
  }

  private async findBestEntityMatch(entityRef: string, domainHints?: string[]): Promise<HaState | null> {
    if (this.isEntityId(entityRef)) {
      try {
        const direct = await this.homeAssistantService.getState(entityRef)
        if (direct) return direct
      } catch {
        // Fall back to friendly-name matching below.
      }
    }

    const states = await this.homeAssistantService.getStates()
    const normalizedNeedle = this.normalizeText(entityRef)
    if (!normalizedNeedle) return null

    const filteredStates = domainHints?.length
      ? states.filter((state) => domainHints.includes(state.entity_id.split('.')[0]))
      : states

    let best: { state: HaState; score: number } | null = null
    for (const state of filteredStates) {
      const score = this.scoreEntityMatch(state, normalizedNeedle)
      if (score <= 0) continue
      if (!best || score > best.score) {
        best = { state, score }
      }
    }

    return best?.state || null
  }

  private scoreEntityMatch(state: HaState, normalizedNeedle: string): number {
    const entityId = state.entity_id.toLowerCase()
    const friendlyName =
      typeof state.attributes?.friendly_name === 'string' ? state.attributes.friendly_name : ''
    const normalizedEntityId = this.normalizeText(entityId)
    const normalizedFriendlyName = this.normalizeText(friendlyName)
    const haystacks = [normalizedEntityId, normalizedFriendlyName].filter(Boolean)

    if (haystacks.includes(normalizedNeedle)) return 100
    if (haystacks.some((haystack) => haystack.endsWith(normalizedNeedle))) return 90
    if (haystacks.some((haystack) => haystack.includes(normalizedNeedle))) return 80

    const needleTokens = normalizedNeedle.split(' ').filter(Boolean)
    if (!needleTokens.length) return 0

    let bestScore = 0
    for (const haystack of haystacks) {
      const haystackTokens = new Set(haystack.split(' ').filter(Boolean))
      const matchedTokens = needleTokens.filter((token) => haystackTokens.has(token)).length
      if (!matchedTokens) continue

      const score = matchedTokens === needleTokens.length ? 70 : matchedTokens * 10
      if (score > bestScore) {
        bestScore = score
      }
    }

    return bestScore
  }
}
