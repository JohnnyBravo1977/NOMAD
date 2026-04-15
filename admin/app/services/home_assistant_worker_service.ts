import { inject } from '@adonisjs/core'
import { HomeAssistantService } from '#services/home_assistant_service'

type HaTask =
  | { kind: 'list_entities' }
  | { kind: 'get_state'; entityRef: string }
  | { kind: 'call_service'; domain: string; service: string; data: Record<string, any> }
  | { kind: 'call_service_group'; domain: string; service: string; entityRefs: string[] }
  | { kind: 'house_summary' }

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
      case 'call_service_group':
        return this.callGroupService(task.domain, task.service, task.entityRefs)
      case 'house_summary':
        return this.getHouseSummary()
      default:
        return null
    }
  }

  private parseTask(userText: string): HaTask | null {
    const text = userText.trim()
    let match: RegExpMatchArray | null

    if (/\b(home assistant|ha)\b/i.test(text) && /\b(list|show).*(entities|devices|states)\b/i.test(text)) {
      return { kind: 'list_entities' }
    }

    if (
      /\b(house status|status of the house|status of house|house summary|summary of the house)\b/i.test(text)
    ) {
      return { kind: 'house_summary' }
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

    match = text.match(/\bset\s+(.+?)\s+to\s+(-?\d+(?:\.\d+)?)\b/i)
    if (match) {
      let target = this.cleanEntityReference(match[1])
      if (/\bthermostat\b/i.test(target) && !/\btarget temperature\b/i.test(target)) {
        target = `${target} target temperature`
      }
      return {
        kind: 'call_service',
        domain: 'input_number',
        service: 'set_value',
        data: { entity_ref: target, value: Number(match[2]) },
      }
    }

    match = text.match(/\bset\s+(.+?)\s+mode\s+to\s+(off|heat|cool|auto)\b/i)
    if (match) {
      const target = this.cleanEntityReference(`${match[1]} mode`)
      return {
        kind: 'call_service',
        domain: 'input_select',
        service: 'select_option',
        data: { entity_ref: target, option: match[2].toLowerCase() },
      }
    }

    match = text.match(/\bset\s+(?:the\s+)?(?:thermostat|mock thermostat)\s+mode\s+to\s+(off|heat|cool|auto)\b/i)
    if (match) {
      return {
        kind: 'call_service',
        domain: 'input_select',
        service: 'select_option',
        data: { entity_ref: 'mock thermostat mode', option: match[1].toLowerCase() },
      }
    }

    match =
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
      if (action === 'lock' && /\bhouse\b/i.test(target)) {
        return { kind: 'call_service_group', domain: 'lock', service: 'lock', entityRefs: ['mock front door'] }
      }
      if (action === 'unlock' && /\bhouse\b/i.test(target)) {
        return { kind: 'call_service_group', domain: 'lock', service: 'unlock', entityRefs: ['mock front door'] }
      }
      if ((action === 'turn on' || action === 'turn off') && /\ball\b.*\bmock light/.test(this.normalizeText(target))) {
        return {
          kind: 'call_service_group',
          domain: 'homeassistant',
          service: action === 'turn on' ? 'turn_on' : 'turn_off',
          entityRefs: ['mock porch light'],
        }
      }
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

  private async callGroupService(
    domain: string,
    service: string,
    entityRefs: string[]
  ): Promise<string> {
    const resolved = await Promise.all(
      entityRefs.map(async (entityRef) => ({
        entityRef,
        entityId: await this.resolveEntityIdForService(domain, { entity_ref: entityRef }),
      }))
    )

    const entityIds = resolved
      .map((entry) => entry.entityId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)

    if (!entityIds.length) {
      return `I couldn't find any matching Home Assistant entities for that request.`
    }

    await this.homeAssistantService.callService(domain, service, { entity_id: entityIds })

    const states = await Promise.all(entityIds.map((entityId) => this.homeAssistantService.getState(entityId)))
    const descriptions = states.filter(Boolean).map((state) => this.describeState(state!))

    return `Home Assistant service ${domain}.${service} completed for ${entityIds.length} entr${entityIds.length === 1 ? 'y' : 'ies'}.\n${descriptions.join('\n\n')}`
  }

  private async getHouseSummary(): Promise<string> {
    const targets = [
      'mock front door',
      'mock porch light',
      'mock sprinklers',
      'mock thermostat target temperature',
      'mock thermostat mode',
      'mock living room temperature',
      'mock living room humidity',
      'mock water pressure',
      'mock tank level',
      'mock water main open',
      'mock water supply alert',
    ]

    const states = await Promise.all(targets.map((target) => this.findBestEntityMatch(target)))
    const lines = states.filter(Boolean).map((state) => this.describeState(state!))

    if (!lines.length) {
      return `I couldn't build a house summary because the mock Home Assistant entities are missing.`
    }

    return `House status summary:\n${lines.join('\n\n')}`
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
        : domain === 'input_number'
          ? ['input_number']
          : domain === 'input_select'
            ? ['input_select']
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
