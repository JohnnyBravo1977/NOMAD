import { inject } from '@adonisjs/core'
import { HomeAssistantService } from '#services/home_assistant_service'

type HaTask =
  | { kind: 'list_entities' }
  | { kind: 'get_state'; entityRef: string }
  | { kind: 'get_light_brightness'; entityRef: string }
  | { kind: 'call_service'; domain: string; service: string; data: Record<string, any> }
  | { kind: 'call_service_group'; domain: string; service: string; entityRefs: string[] }
  | { kind: 'house_summary' }
  | { kind: 'house_attention' }

type HaState = {
  entity_id: string
  state: string
  attributes?: Record<string, any>
}

const UNAVAILABLE_HA_STATES = new Set(['unavailable', 'unknown'])
const GENERIC_ENTITY_TOKENS = new Set([
  'light',
  'lamp',
  'switch',
  'lock',
  'door',
  'fan',
  'cover',
  'scene',
  'script',
  'thermostat',
  'temperature',
  'mode',
  'target',
  'brightness',
])

@inject()
export class HomeAssistantWorkerService {
  constructor(private homeAssistantService: HomeAssistantService) {}

  async describeCapabilities(): Promise<string> {
    const available = await this.homeAssistantService.isAvailable()
    return [
      'Home Assistant worker capabilities:',
      available ? '- Home Assistant is currently reachable' : '- Home Assistant is currently not reachable',
      '- List entities',
      '- Read entity state by entity id or friendly name',
      '- Turn compatible entities on or off',
      '- Set compatible light brightness',
      '- Brighten or dim compatible lights and rooms',
      '- Set compatible light colors and white temperature',
      '- Apply simple lighting presets like movie, dinner, and night',
      '- Lock or unlock lock entities',
      '- Add items to the shopping list',
      '- Set thermostat-style target values for configured helpers',
      '- Set thermostat mode for configured helpers',
      '- Run grouped house actions such as lock all doors or turn off all lights',
      '- Generate house status and house attention summaries',
    ].join('\n')
  }

  private isEntityId(value: string): boolean {
    return /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(value.trim())
  }

  private isAmbiguousReference(value: string): boolean {
    const normalized = this.normalizeText(value)
    if (!normalized) return true

    const banned = new Set([
      'she', 'he', 'they', 'them', 'her', 'him', 'it', 'this', 'that', 'these', 'those',
      'there', 'here', 'someone', 'somebody', 'something', 'anything', 'everything',
      'thing', 'stuff', 'one', 'ones',
    ])

    return banned.has(normalized)
  }

  async tryHandle(userText: string): Promise<string | null> {
    const task = this.classify(userText)
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
      case 'get_light_brightness':
        return this.getLightBrightness(task.entityRef)
      case 'call_service':
        return this.callService(task.domain, task.service, task.data)
      case 'call_service_group':
        return this.callGroupService(task.domain, task.service, task.entityRefs)
      case 'house_summary':
        return this.getHouseSummary()
      case 'house_attention':
        return this.getHouseAttentionSummary()
      default:
        return null
    }
  }

  classify(userText: string): HaTask | null {
    return this.parseTask(userText)
  }

  private parseTask(userText: string): HaTask | null {
    const text = userText.trim()
    let match: RegExpMatchArray | null

    if (/\b(home assistant|ha)\b/i.test(text) && /\b(list|show).*(entities|devices|states)\b/i.test(text)) {
      return { kind: 'list_entities' }
    }

    if (
      /\b(house status|status of the house|status of house|status on the house|house summary|summary of the house)\b/i.test(text)
    ) {
      return { kind: 'house_summary' }
    }

    if (/\b(what needs attention in the house|house attention|what needs attention at home)\b/i.test(text)) {
      return { kind: 'house_attention' }
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

    match = text.match(/\bwhat(?:['’]?s| is)\s+the\s+(.+?)\s+brightness\s+(?:set\s+to|at)\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      if (!target || this.isAmbiguousReference(target)) return null
      return { kind: 'get_light_brightness', entityRef: target }
    }

    match =
      text.match(/\bwhat(?:['’]?s| is)\s+the\s+(.+?)(?:\s*\?|$)/i) ||
      text.match(/\bwhat\s+is\s+the\s+(.+?)(?:\s*\?|$)/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      if (!target || this.isAmbiguousReference(target)) return null
      if (
        /\b(water pressure|tank level|living room temperature|living room humidity|thermostat target temperature|thermostat mode|front door|porch light|sprinklers|water main|water supply alert)\b/i.test(
          target
        )
      ) {
        return { kind: 'get_state', entityRef: target }
      }
    }

    match = text.match(/\bset\s+(.+?)\s+to\s+(\d{1,3})(?:\s*%|\s+percent)\s*$/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      if (!target || this.isAmbiguousReference(target)) return null
      const brightness = Math.max(1, Math.min(100, Number(match[2])))
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, brightness_pct: brightness },
      }
    }

    match = text.match(/\bset\s+(.+?)\s+brightness\s+to\s+(\d{1,3})(?:\s*%|\s+percent)?\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      if (!target || this.isAmbiguousReference(target)) return null
      const brightness = Math.max(1, Math.min(100, Number(match[2])))
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, brightness_pct: brightness },
      }
    }

    match = text.match(/\bdim\s+(.+?)\s+to\s+(\d{1,3})(?:\s*%|\s+percent)?\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      if (!target || this.isAmbiguousReference(target)) return null
      const brightness = Math.max(1, Math.min(100, Number(match[2])))
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, brightness_pct: brightness },
      }
    }

    match = text.match(/\b(?:make|turn)\s+(.+?)\s+(brighter|dimmer)\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      const direction = match[2].toLowerCase()
      if (!target || this.isAmbiguousReference(target)) return null
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: {
          entity_ref: target,
          brightness_step_pct: direction === 'brighter' ? 20 : -20,
        },
      }
    }

    match = text.match(/\bbrighten\s+(.+)\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      if (!target || this.isAmbiguousReference(target)) return null
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, brightness_step_pct: 20 },
      }
    }

    match = text.match(/\b(?:dim|darken)\s+(.+)\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      if (!target || this.isAmbiguousReference(target)) return null
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, brightness_step_pct: -20 },
      }
    }

    match = text.match(/\bset\s+(.+?)\s+color\s+to\s+(.+)\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      const colorValue = this.cleanEntityReference(match[2])
      if (!target || !colorValue || this.isAmbiguousReference(target)) return null
      const lightData = this.buildLightColorData(colorValue)
      if (!lightData) return null
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, ...lightData },
      }
    }

    match = text.match(/\bset\s+(.+?)\s+to\s+(movie|dinner|night)\s+mode\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      const preset = match[2].toLowerCase()
      if (!target || this.isAmbiguousReference(target)) return null
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, ...this.buildLightPresetData(preset) },
      }
    }

    match = text.match(/\bset\s+(.+?)\s+to\s+(movie|dinner|night)\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      const preset = match[2].toLowerCase()
      if (!target || this.isAmbiguousReference(target)) return null
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, ...this.buildLightPresetData(preset) },
      }
    }

    match = text.match(/\bmake\s+(.+?)\s+(movie|dinner|night)\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      const preset = match[2].toLowerCase()
      if (!target || this.isAmbiguousReference(target)) return null
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, ...this.buildLightPresetData(preset) },
      }
    }

    match = text.match(/\bmake\s+(.+?)\s+(warm daylight|warm white|soft white|neutral white|cool white|daylight|red|green|blue|purple|orange|yellow|pink|white)\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      const colorValue = this.cleanEntityReference(match[2])
      if (!target || !colorValue || this.isAmbiguousReference(target)) return null
      const lightData = this.buildLightColorData(colorValue)
      if (!lightData) return null
      return {
        kind: 'call_service',
        domain: 'light',
        service: 'turn_on',
        data: { entity_ref: target, ...lightData },
      }
    }

    match = text.match(/\bset\s+(.+?)\s+to\s+(-?\d+(?:\.\d+)?)\b/i)
    if (match) {
      let target = this.cleanEntityReference(match[1])
      if (this.isAmbiguousReference(target)) return null
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
      if (this.isAmbiguousReference(target)) return null
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
      text.match(/\bwhat(?:['’]?s| is) the state of (?:entity )?([a-z0-9_]+\.[a-z0-9_]+)\b/i)
    if (match) {
      return { kind: 'get_state', entityRef: match[1].toLowerCase() }
    }

    match =
      text.match(/\b(?:state|status) of (.+)\b/i) ||
      text.match(/\bwhat(?:['’]?s| is) the state of (.+)\b/i) ||
      text.match(/\bwhat(?:['’]?s| is) the status of (.+)\b/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      if (this.isAmbiguousReference(target)) return null
      return { kind: 'get_state', entityRef: target }
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

    match = text.match(/^(.+?)\s+(on|off)$/i)
    if (match) {
      const target = this.cleanEntityReference(match[1])
      const action = match[2].toLowerCase()
      if (!target || this.isAmbiguousReference(target)) return null
      return {
        kind: 'call_service',
        domain: 'homeassistant',
        service: action === 'on' ? 'turn_on' : 'turn_off',
        data: { entity_ref: target },
      }
    }

    match = text.match(/\b(turn on|turn off|lock|unlock)\s+(.+)\b/i)
    if (match) {
      const action = match[1].toLowerCase()
      const target = this.cleanEntityReference(match[2])
      if (!target) return null
      if (this.isAmbiguousReference(target)) return null
      const normalizedTarget = this.normalizeText(target)
      if (action === 'lock' && (/\bhouse\b/i.test(target) || /\ball\b.*\bdoor\b/.test(normalizedTarget))) {
        return { kind: 'call_service_group', domain: 'lock', service: 'lock', entityRefs: ['mock front door'] }
      }
      if (action === 'unlock' && (/\bhouse\b/i.test(target) || /\ball\b.*\bdoor\b/.test(normalizedTarget))) {
        return { kind: 'call_service_group', domain: 'lock', service: 'unlock', entityRefs: ['mock front door'] }
      }
      if (
        (action === 'turn on' || action === 'turn off') &&
        (/\ball\b.*\blight\b/.test(normalizedTarget) || /\ball\b.*\bmock light\b/.test(normalizedTarget))
      ) {
        return {
          kind: 'call_service',
          domain: 'homeassistant',
          service: action === 'turn on' ? 'turn_on' : 'turn_off',
          data: { entity_ref: '__all_lights__' },
        }
      }
      if (
        action === 'turn off' &&
        (/\bwater\b/.test(normalizedTarget) || /\bwater main\b/.test(normalizedTarget))
      ) {
        return {
          kind: 'call_service',
          domain: 'homeassistant',
          service: 'turn_off',
          data: { entity_ref: 'mock water main open' },
        }
      }
      if (
        action === 'turn on' &&
        (/\bwater\b/.test(normalizedTarget) || /\bwater main\b/.test(normalizedTarget))
      ) {
        return {
          kind: 'call_service',
          domain: 'homeassistant',
          service: 'turn_on',
          data: { entity_ref: 'mock water main open' },
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
      if (this.isUnavailableState(state)) {
        return `${this.formatFriendlyName(state)} is currently unavailable in Home Assistant.`
      }
      const houseSummaryLine = this.describeHouseSummaryLine(state)
      if (houseSummaryLine) {
        return houseSummaryLine
      }
      return this.describeState(state)
    }
    return `I couldn't find a Home Assistant entity matching ${entityRef}.`
  }

  private async getLightBrightness(entityRef: string): Promise<string> {
    const state = await this.findBestEntityMatch(entityRef, ['light'])
    if (!state) {
      return `I couldn't find a light matching ${entityRef}.`
    }
    if (this.isUnavailableState(state)) {
      return `${this.formatFriendlyName(state)} is currently unavailable in Home Assistant.`
    }

    const rawBrightness = Number(state.attributes?.brightness)
    if (!Number.isFinite(rawBrightness)) {
      return `${this.formatFriendlyName(state)} does not report a brightness level.`
    }

    const brightnessPercent = Math.max(0, Math.min(100, Math.round((rawBrightness / 255) * 100)))
    return `${this.formatFriendlyName(state)} is set to ${brightnessPercent}% brightness.`
  }

  private async callService(domain: string, service: string, data: Record<string, any>): Promise<string> {
    const resolvedTargets = await this.resolveServiceTargets(domain, service, data)
    const summaryData = { ...data }
    const serviceData = { ...data }
    delete serviceData.entity_ref
    delete serviceData.quinn_preset
    const entityIds = resolvedTargets.entityIds
    if (entityIds.length === 1) {
      serviceData.entity_id = entityIds[0]
    } else if (entityIds.length > 1) {
      serviceData.entity_id = entityIds
    }

    if (entityIds.length > 0) {
      const stateMapBefore = await this.buildStateMap()
      const statesBefore = entityIds.map((entityId) => stateMapBefore.get(entityId) || null)
      const liveStatesBefore = statesBefore.filter((state): state is HaState => Boolean(state))
      const unavailableTargets = statesBefore
        .filter((state): state is HaState => Boolean(state))
        .filter((state) => this.isUnavailableState(state))

      if (unavailableTargets.length > 0) {
        if (unavailableTargets.length === 1) {
          return `${this.formatFriendlyName(unavailableTargets[0])} is currently unavailable in Home Assistant, so I did not send that command.`
        }
        return `${unavailableTargets.length} Home Assistant targets are currently unavailable, so I did not send that command.`
      }

      if (domain === 'input_number' && service === 'set_value' && typeof serviceData.value === 'number') {
        const rangeError = this.describeInputNumberRangeError(liveStatesBefore, serviceData.value)
        if (rangeError) {
          return rangeError
        }
      }
    }

    try {
      await this.homeAssistantService.callService(domain, service, serviceData)
    } catch (error) {
      if (domain === 'input_number' && service === 'set_value' && typeof serviceData.value === 'number') {
        return `I couldn't set that value in Home Assistant. It looks outside the allowed range.`
      }
      throw error
    }
    if (!entityIds.length) {
      return `Home Assistant service ${domain}.${service} completed.`
    }

    const stateMapAfter = await this.buildStateMap()
    const states = entityIds.map((entityId) => stateMapAfter.get(entityId) || null)
    const liveStates = states.filter((state): state is HaState => Boolean(state))
    if (!liveStates.length) {
      return entityIds.length === 1
        ? `I completed ${domain}.${service} for ${entityIds[0]}.`
        : `I completed ${domain}.${service} for ${entityIds.length} items.`
    }

    return this.describeServiceOutcome(domain, service, liveStates, summaryData, resolvedTargets.label)
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

    const stateMap = await this.buildStateMap()
    const states = entityIds.map((entityId) => stateMap.get(entityId) || null)
    return this.describeServiceOutcome(
      domain,
      service,
      states.filter((state): state is HaState => Boolean(state)),
      { entity_id: entityIds }
    )
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
    const lines = states
      .filter((state): state is HaState => Boolean(state))
      .map((state) => this.describeHouseSummaryLine(state))
      .filter(Boolean)

    if (!lines.length) {
      return `I couldn't build a house summary because the mock Home Assistant entities are missing.`
    }

    return [
      `Here’s the current house status:`,
      ...lines.map((line) => `- ${line}`),
    ].join('\n')
  }

  private describeServiceOutcome(
    domain: string,
    service: string,
    states: HaState[],
    data?: Record<string, any>,
    targetLabel?: string
  ): string {
    const summary = this.describeActionSummary(domain, service, states, data, targetLabel)
    return summary
  }

  private describeActionSummary(
    domain: string,
    service: string,
    states: HaState[],
    data?: Record<string, any>,
    targetLabel?: string
  ): string {
    const count = states.length
    const targetName = this.formatTargetLabel(targetLabel, states, count)
    if (domain === 'lock' && service === 'lock') {
      return count === 1 ? `I locked ${this.formatFriendlyName(states[0])}.` : `I locked ${count} doors.`
    }
    if (domain === 'lock' && service === 'unlock') {
      return count === 1 ? `I unlocked ${this.formatFriendlyName(states[0])}.` : `I unlocked ${count} doors.`
    }
    if ((domain === 'homeassistant' || domain === 'light' || domain === 'switch' || domain === 'input_boolean') && service === 'turn_off') {
      return count === 1 ? `I turned off ${targetName}.` : `I turned off ${targetName}.`
    }
    if ((domain === 'homeassistant' || domain === 'light' || domain === 'switch' || domain === 'input_boolean') && service === 'turn_on') {
      if (states[0] && typeof data?.quinn_preset === 'string') {
        return `I set ${targetName} to ${data.quinn_preset} mode.`
      }
      if (states[0] && typeof data?.brightness_pct === 'number') {
        return `I set ${targetName} to ${Math.round(data.brightness_pct)}% brightness.`
      }
      if (states[0] && typeof data?.brightness_step_pct === 'number') {
        return data.brightness_step_pct > 0
          ? `I made ${targetName} brighter.`
          : `I dimmed ${targetName}.`
      }
      if (states[0] && typeof data?.color_name === 'string') {
        return `I set ${targetName} to ${data.color_name}.`
      }
      if (states[0] && typeof data?.color_temp_kelvin === 'number') {
        return `I set ${targetName} to ${this.describeKelvinLabel(data.color_temp_kelvin)}.`
      }
      return count === 1 ? `I turned on ${targetName}.` : `I turned on ${targetName}.`
    }
    if (domain === 'input_number' && service === 'set_value' && states[0]) {
      return `I set ${this.formatFriendlyName(states[0])} to ${this.formatNumberState(states[0].state)}.`
    }
    if (domain === 'input_select' && service === 'select_option' && states[0]) {
      return `I set ${this.formatFriendlyName(states[0])} to ${states[0].state}.`
    }
    if (domain === 'todo' && service === 'add_item') {
      return 'I added that to the shopping list.'
    }
    return `I completed ${domain}.${service}.`
  }

  private async getHouseAttentionSummary(): Promise<string> {
    const watchedTargets = [
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

    const states = await Promise.all(watchedTargets.map((target) => this.findBestEntityMatch(target)))
    const stateMap = new Map(
      states.filter(Boolean).map((state) => [state!.entity_id, state!])
    )

    const issues: string[] = []

    const frontDoor = stateMap.get('lock.mock_front_door')
    if (frontDoor?.state !== 'locked') {
      issues.push('Front door is unlocked.')
    }

    const porchLight = stateMap.get('light.mock_porch_light') || stateMap.get('input_boolean.mock_porch_light')
    if (porchLight?.state === 'on') {
      issues.push('Porch light is on.')
    }

    const sprinklers = stateMap.get('switch.mock_sprinklers') || stateMap.get('input_boolean.mock_sprinklers')
    if (sprinklers?.state === 'on') {
      issues.push('Sprinklers are running.')
    }

    const waterAlert =
      stateMap.get('binary_sensor.mock_water_supply_alert') ||
      stateMap.get('input_boolean.mock_water_supply_alert')
    if (waterAlert?.state === 'on') {
      issues.push('Water supply alert is active.')
    }

    const waterMain =
      stateMap.get('binary_sensor.mock_water_main_open') || stateMap.get('input_boolean.mock_water_main_open')
    if (waterMain?.state === 'off') {
      issues.push('Water main is shut off.')
    }

    const temp = Number(
      stateMap.get('sensor.mock_living_room_temperature')?.state ||
        stateMap.get('input_number.mock_living_room_temperature')?.state
    )
    if (Number.isFinite(temp) && (temp < 60 || temp > 80)) {
      issues.push(`Living room temperature is ${this.formatNumberState(String(temp))} degrees Fahrenheit.`)
    }

    const humidity = Number(
      stateMap.get('sensor.mock_living_room_humidity')?.state ||
        stateMap.get('input_number.mock_living_room_humidity')?.state
    )
    if (Number.isFinite(humidity) && (humidity < 25 || humidity > 65)) {
      issues.push(`Living room humidity is ${this.formatNumberState(String(humidity))}%.`)
    }

    const waterPressure = Number(
      stateMap.get('sensor.mock_water_pressure')?.state ||
        stateMap.get('input_number.mock_water_pressure')?.state
    )
    if (Number.isFinite(waterPressure) && waterPressure < 20) {
      issues.push(`Water pressure is low at ${this.formatNumberState(String(waterPressure))} psi.`)
    }

    const tankLevel = Number(
      stateMap.get('sensor.mock_tank_level')?.state || stateMap.get('input_number.mock_tank_level')?.state
    )
    if (Number.isFinite(tankLevel) && tankLevel < 25) {
      issues.push(`Tank level is low at ${this.formatNumberState(String(tankLevel))}%.`)
    }

    if (!issues.length) {
      return 'Nothing urgent needs attention in the house right now.'
    }

    return [
      'Here is what needs attention in the house:',
      ...issues.map((issue) => `- ${issue}`),
    ].join('\n')
  }

  private describeHouseSummaryLine(state: HaState): string | null {
    switch (state.entity_id) {
      case 'lock.mock_front_door':
        return `The front door is ${state.state}.`
      case 'input_boolean.mock_porch_light':
      case 'light.mock_porch_light':
        return `The porch light is ${state.state}.`
      case 'input_boolean.mock_sprinklers':
      case 'switch.mock_sprinklers':
        return `The sprinklers are ${state.state}.`
      case 'input_number.mock_thermostat_target_temperature':
      case 'sensor.mock_thermostat_target_temperature':
        return `The thermostat target is ${this.formatNumberState(state.state)} degrees Fahrenheit.`
      case 'input_select.mock_thermostat_mode':
      case 'sensor.mock_thermostat_mode':
        return `The thermostat mode is ${state.state}.`
      case 'input_number.mock_living_room_temperature':
      case 'sensor.mock_living_room_temperature':
        return `The living room temperature is ${this.formatNumberState(state.state)} degrees Fahrenheit.`
      case 'input_number.mock_living_room_humidity':
      case 'sensor.mock_living_room_humidity':
        return `The living room humidity is ${this.formatNumberState(state.state)}%.`
      case 'input_number.mock_water_pressure':
      case 'sensor.mock_water_pressure':
        return `The water pressure is ${this.formatNumberState(state.state)} psi.`
      case 'input_number.mock_tank_level':
      case 'sensor.mock_tank_level':
        return `The tank level is ${this.formatNumberState(state.state)}%.`
      case 'input_boolean.mock_water_main_open':
      case 'binary_sensor.mock_water_main_open':
        return `The water main is ${state.state === 'on' ? 'open' : 'closed'}.`
      case 'input_boolean.mock_water_supply_alert':
      case 'binary_sensor.mock_water_supply_alert':
        return `The water supply alert is ${state.state === 'on' ? 'active' : 'clear'}.`
      default:
        return `${this.formatFriendlyName(state)} is ${state.state}.`
    }
  }

  private formatNumberState(value: string): string {
    const number = Number(value)
    if (!Number.isFinite(number)) return value
    return Number.isInteger(number) ? String(number) : number.toFixed(1)
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

  private formatFriendlyName(state?: HaState | null): string {
    if (!state) return 'it'
    const friendlyName = state.attributes?.friendly_name
    return typeof friendlyName === 'string' && friendlyName.trim().length > 0
      ? friendlyName.trim().replace(/^mock\s+/i, '')
      : state.entity_id
  }

  private describeInputNumberRangeError(states: HaState[], value: number): string | null {
    const state = states[0]
    if (!state) return null

    const min = Number(state.attributes?.min)
    const max = Number(state.attributes?.max)
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return null
    }

    if (value < min || value > max) {
      return `I couldn't set ${this.formatFriendlyName(state)} to ${value}. Home Assistant allows values from ${this.formatNumberState(String(min))} to ${this.formatNumberState(String(max))}.`
    }

    return null
  }

  private formatTargetLabel(targetLabel: string | undefined, states: HaState[], count: number): string {
    if (targetLabel && targetLabel.trim()) {
      if (targetLabel.trim().toLowerCase() === 'all') {
        return 'all lights'
      }
      return count === 1 ? `the ${targetLabel} light` : `the ${targetLabel} lights`
    }

    if (count === 1) {
      return this.formatFriendlyName(states[0])
    }

    return `${count} items`
  }

  private buildLightColorData(value: string): Record<string, any> | null {
    const normalized = this.normalizeText(value)
    if (!normalized) return null

    const kelvinByLabel: Record<string, number> = {
      'warm white': 2700,
      'soft white': 3000,
      'neutral white': 4000,
      'cool white': 5000,
      'warm daylight': 6500,
      daylight: 6500,
    }

    if (normalized in kelvinByLabel) {
      return { color_temp_kelvin: kelvinByLabel[normalized] }
    }

    const allowedColorNames = new Set([
      'red',
      'green',
      'blue',
      'purple',
      'orange',
      'yellow',
      'pink',
      'white',
    ])

    if (allowedColorNames.has(normalized)) {
      return { color_name: normalized }
    }

    return null
  }

  private buildLightPresetData(value: string): Record<string, any> {
    const normalized = this.normalizeText(value)
    if (normalized === 'movie') {
      return { brightness_pct: 20, color_temp_kelvin: 2700, quinn_preset: 'movie' }
    }
    if (normalized === 'dinner') {
      return { brightness_pct: 45, color_temp_kelvin: 2700, quinn_preset: 'dinner' }
    }
    return { brightness_pct: 10, color_temp_kelvin: 2200, quinn_preset: 'night' }
  }

  private describeKelvinLabel(kelvin: number): string {
    if (kelvin <= 3000) return 'warm white'
    if (kelvin <= 4500) return 'neutral white'
    if (kelvin <= 5700) return 'cool white'
    return 'daylight'
  }

  private cleanEntityReference(value: string): string {
    return value
      .trim()
      .replace(/[?.!,]+$/g, '')
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/^(?:(?:oh|uh|um|well|please)\s+)+/i, '')
      .replace(/\s+(?:please|for me|thanks|thank you|okay|ok|oh|uh|um)$/i, '')
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

  private isUnavailableState(state?: HaState | null): boolean {
    return !!state && UNAVAILABLE_HA_STATES.has(String(state.state || '').toLowerCase())
  }

  private async resolveEntityIdForService(
    domain: string,
    data: Record<string, any>,
    options?: { requireAvailable?: boolean }
  ): Promise<string | null> {
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

    const match = await this.findBestEntityMatch(entityRef, domainHints, {
      preferAvailable: options?.requireAvailable === true,
    })
    if (!match) {
      throw new Error(`I couldn't find a Home Assistant entity matching ${entityRef}.`)
    }
    if (options?.requireAvailable === true && this.isUnavailableState(match)) {
      throw new Error(`${this.formatFriendlyName(match)} is currently unavailable in Home Assistant.`)
    }

    return match.entity_id
  }

  private async resolveServiceTargets(
    domain: string,
    service: string,
    data: Record<string, any>
  ): Promise<{ entityIds: string[]; label?: string }> {
    if (typeof data.entity_id === 'string') {
      return { entityIds: [data.entity_id] }
    }

    if (Array.isArray(data.entity_id)) {
      return { entityIds: data.entity_id.filter((value): value is string => typeof value === 'string' && value.length > 0) }
    }

    const entityRef = typeof data.entity_ref === 'string' ? data.entity_ref : null
    if (!entityRef) return { entityIds: [] }

    if (entityRef === '__all_lights__') {
      const states = await this.homeAssistantService.getStates()
      const entityIds = states
        .filter((state) => state.entity_id.startsWith('light.'))
        .map((state) => state.entity_id)

      return {
        entityIds,
        label: 'all',
      }
    }

    const isLightControl =
      (domain === 'light' || domain === 'homeassistant') &&
      (service === 'turn_on' || service === 'turn_off')

    if (isLightControl) {
      const areaTargets = await this.homeAssistantService.findAreaLightTargets(entityRef)
      if (areaTargets?.entityIds.length) {
        return {
          entityIds: areaTargets.entityIds,
          label: areaTargets.areaName,
        }
      }
    }

    const entityId = await this.resolveEntityIdForService(domain, data, {
      requireAvailable: true,
    })
    return entityId ? { entityIds: [entityId] } : { entityIds: [] }
  }

  private async findBestEntityMatch(
    entityRef: string,
    domainHints?: string[],
    options?: { preferAvailable?: boolean }
  ): Promise<HaState | null> {
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
      const baseScore = this.scoreEntityMatch(state, normalizedNeedle)
      if (baseScore <= 0) continue

      let score = baseScore
      if (options?.preferAvailable) {
        score += this.isUnavailableState(state) ? -25 : 5
      }
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
    const specificNeedleTokens = needleTokens.filter((token) => !GENERIC_ENTITY_TOKENS.has(token))

    let bestScore = 0
    for (const haystack of haystacks) {
      const haystackTokens = new Set(haystack.split(' ').filter(Boolean))
      if (
        specificNeedleTokens.length > 0 &&
        specificNeedleTokens.some((token) => !haystackTokens.has(token))
      ) {
        continue
      }

      const matchedTokens = needleTokens.filter((token) => haystackTokens.has(token)).length
      if (!matchedTokens) continue

      const score = matchedTokens === needleTokens.length ? 70 : matchedTokens * 10
      if (score > bestScore) {
        bestScore = score
      }
    }

    return bestScore
  }

  private async buildStateMap(): Promise<Map<string, HaState>> {
    const states = await this.homeAssistantService.getStates()
    return new Map(states.map((state) => [state.entity_id, state]))
  }
}
