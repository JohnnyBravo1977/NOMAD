import { inject } from '@adonisjs/core'
import { CrewAIWorkerService } from '#services/crewai_worker_service'

export type WorkerFlowToolName =
  | 'diagnose_container'
  | 'patch_file_and_verify'
  | 'restart_and_verify_service'
  | 'inspect_logs_config_and_files'
  | 'diagnose_home_assistant'
  | 'repair_service_from_logs'

export type WorkerFlowMatch =
  | { tool: 'diagnose_container'; containerName: string }
  | { tool: 'patch_file_and_verify'; filePath: string; search: string; replace: string; serviceName?: string }
  | { tool: 'restart_and_verify_service'; serviceName: string }
  | { tool: 'inspect_logs_config_and_files'; containerName: string }
  | { tool: 'diagnose_home_assistant' }
  | { tool: 'repair_service_from_logs'; serviceName: string }

export type WorkerFlowExecutionResult = {
  kind: 'worker_flow_execution'
  tool: WorkerFlowToolName
  input: Record<string, any>
  rawText: string
}

@inject()
export class WorkerFlowRegistryService {
  constructor(private crewAIWorkerService: CrewAIWorkerService) {}

  async describeTools(): Promise<string> {
    const crewai = await this.crewAIWorkerService.describeCapabilities()
    return [
      'Worker-flow tools:',
      '- diagnose_container',
      '- patch_file_and_verify',
      '- restart_and_verify_service',
      '- inspect_logs_config_and_files',
      '- diagnose_home_assistant',
      '- repair_service_from_logs',
      'Worker-flow tool model:',
      '- A worker-flow tool runs a bounded multi-step job using sub-tools, then returns one grounded result.',
      '- This is the execution lane where CrewAI lives without affecting direct tools.',
      '',
      crewai,
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<WorkerFlowExecutionResult | null> {
    const match = this.classify(userText)
    if (!match) return null

    const available = await this.crewAIWorkerService.isAvailable()
    if (!available) {
      return {
        kind: 'worker_flow_execution',
        tool: match.tool,
        input: { ...match },
        rawText: [
          `Missing capability: the CrewAI worker-flow engine is not reachable right now for ${match.tool}.`,
          'Current status:',
          '- Direct deterministic tools are still available.',
          '- The bounded multi-step worker-flow lane is currently offline.',
        ].join('\n'),
      }
    }

    switch (match.tool) {
      case 'diagnose_container':
        return {
          kind: 'worker_flow_execution',
          tool: match.tool,
          input: { containerName: match.containerName },
          rawText: await this.crewAIWorkerService.runTool({
            tool: 'diagnose_container',
            input: { container_name: match.containerName },
          }),
        }
      case 'patch_file_and_verify':
        return {
          kind: 'worker_flow_execution',
          tool: match.tool,
          input: {
            filePath: match.filePath,
            search: match.search,
            replace: match.replace,
            serviceName: match.serviceName,
          },
          rawText: await this.crewAIWorkerService.runTool({
            tool: 'patch_file_and_verify',
            input: {
              file_path: match.filePath,
              search: match.search,
              replace: match.replace,
              service_name: match.serviceName,
            },
          }),
        }
      case 'restart_and_verify_service':
        return {
          kind: 'worker_flow_execution',
          tool: match.tool,
          input: { serviceName: match.serviceName },
          rawText: await this.crewAIWorkerService.runTool({
            tool: 'restart_and_verify_service',
            input: {
              service_name: match.serviceName,
            },
          }),
        }
      case 'inspect_logs_config_and_files':
        return {
          kind: 'worker_flow_execution',
          tool: match.tool,
          input: { containerName: match.containerName },
          rawText: await this.crewAIWorkerService.runTool({
            tool: 'inspect_logs_config_and_files',
            input: {
              container_name: match.containerName,
            },
          }),
        }
      case 'diagnose_home_assistant':
        return {
          kind: 'worker_flow_execution',
          tool: match.tool,
          input: {},
          rawText: await this.crewAIWorkerService.runTool({
            tool: 'diagnose_home_assistant',
            input: {},
          }),
        }
      case 'repair_service_from_logs':
        return {
          kind: 'worker_flow_execution',
          tool: match.tool,
          input: { serviceName: match.serviceName },
          rawText: await this.crewAIWorkerService.runTool({
            tool: 'repair_service_from_logs',
            input: {
              service_name: match.serviceName,
            },
          }),
        }
      default:
        return null
    }
  }

  classify(userText: string): WorkerFlowMatch | null {
    return this.matchTool(userText)
  }

  private matchTool(userText: string): WorkerFlowMatch | null {
    const text = userText.trim()
    let match: RegExpMatchArray | null

    match =
      text.match(/\b(?:diagnose|debug|inspect)\s+(?:the\s+)?container\s+([a-zA-Z0-9._-]+)/i) ||
      text.match(/\bdiagnose_container\s+([a-zA-Z0-9._-]+)/i)
    if (match) {
      return { tool: 'diagnose_container', containerName: match[1] }
    }

    match =
      text.match(/\bpatch\s+(?:the\s+)?file\s+([^\s]+)\s+replace\s+["']([\s\S]+?)["']\s+with\s+["']([\s\S]+?)["'](?:\s+and\s+restart\s+([a-zA-Z0-9._-]+))?/i) ||
      text.match(/\bpatch_file_and_verify\s+([^\s]+)\s+["']([\s\S]+?)["']\s+["']([\s\S]+?)["'](?:\s+([a-zA-Z0-9._-]+))?/i)
    if (match) {
      return {
        tool: 'patch_file_and_verify',
        filePath: match[1],
        search: match[2],
        replace: match[3],
        serviceName: match[4] || undefined,
      }
    }

    match =
      text.match(/\b(?:restart|bounce|reboot)\s+(?:the\s+)?service\s+([a-zA-Z0-9._-]+)(?:\s+and\s+verify)?/i) ||
      text.match(/\brestart_and_verify_service\s+([a-zA-Z0-9._-]+)/i) ||
      text.match(/\brestart\s+([a-zA-Z0-9._-]+)\s+and\s+verify\b/i)
    if (match) {
      return {
        tool: 'restart_and_verify_service',
        serviceName: match[1],
      }
    }

    match =
      text.match(/\binspect\s+logs,\s*config,\s*(?:and\s+)?files\s+(?:for\s+)?([a-zA-Z0-9._-]+)/i) ||
      text.match(/\binspect_logs_config_and_files\s+([a-zA-Z0-9._-]+)/i) ||
      text.match(/\binspect\s+([a-zA-Z0-9._-]+)\s+logs,\s*config,\s*(?:and\s+)?files/i)
    if (match) {
      return {
        tool: 'inspect_logs_config_and_files',
        containerName: match[1],
      }
    }

    if (
      /\bdiagnose\s+(?:home assistant|homeassistant)\b/i.test(text) ||
      /\bdiagnose_home_assistant\b/i.test(text)
    ) {
      return { tool: 'diagnose_home_assistant' }
    }

    match =
      text.match(/\b(?:repair|fix|recover)\s+(?:the\s+)?service\s+([a-zA-Z0-9._-]+)\s+from\s+logs\b/i) ||
      text.match(/\brepair_service_from_logs\s+([a-zA-Z0-9._-]+)/i)
    if (match) {
      return {
        tool: 'repair_service_from_logs',
        serviceName: match[1],
      }
    }

    return null
  }
}
