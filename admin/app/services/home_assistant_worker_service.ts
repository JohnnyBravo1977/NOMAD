import { inject } from '@adonisjs/core'
import { HomeAssistantService } from '#services/home_assistant_service'

type HaTask =
  | { kind: 'list_entities' }
  | { kind: 'get_state'; entityRef: string }
  | { kind: 'call_service'; domain: string; service: string; data: Record<string, any> }

@inject()
export class HomeAssistantWorkerService {
  constructor(private homeAssistantService: HomeAssistantService) {}

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
    const state = await this.homeAssistantService.getState(entityRef)
    if (state) {
      return this.describeState(state)
    }

    const states = await this.homeAssistantService.getStates()
    const fallback = states.find(
      (item) =>
        item.entity_id.toLowerCase() === entityRef.toLowerCase() ||
        item.entity_id.toLowerCase().endsWith(`.${entityRef.toLowerCase()}`)
    )
    if (!fallback) {
      return `I couldn't find a Home Assistant entity matching ${entityRef}.`
    }

    return this.describeState(fallback)
  }

  private async callService(domain: string, service: string, data: Record<string, any>): Promise<string> {
    await this.homeAssistantService.callService(domain, service, data)
    const entityId = typeof data.entity_id === 'string' ? data.entity_id : null
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
}
