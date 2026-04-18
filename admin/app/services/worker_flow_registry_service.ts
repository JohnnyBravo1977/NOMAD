import { inject } from '@adonisjs/core'
import { CrewAIWorkerService } from '#services/crewai_worker_service'

export type WorkerFlowToolName =
  | 'diagnose_container'
  | 'patch_file_and_verify'

type WorkerFlowMatch =
  | { tool: 'diagnose_container'; containerName: string }
  | { tool: 'patch_file_and_verify'; filePath: string; search: string; replace: string; serviceName?: string }

@inject()
export class WorkerFlowRegistryService {
  constructor(private crewAIWorkerService: CrewAIWorkerService) {}

  async describeTools(): Promise<string> {
    const crewai = await this.crewAIWorkerService.describeCapabilities()
    return [
      'Worker-flow tools:',
      '- diagnose_container',
      '- patch_file_and_verify',
      'Worker-flow tool model:',
      '- A worker-flow tool runs a bounded multi-step job using sub-tools, then returns one grounded result.',
      '- This is the execution lane where CrewAI lives without affecting direct tools.',
      '',
      crewai,
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<{ tool: WorkerFlowToolName; result: string } | null> {
    const match = this.matchTool(userText)
    if (!match) return null

    const available = await this.crewAIWorkerService.isAvailable()
    if (!available) {
      return {
        tool: match.tool,
        result: [
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
          tool: match.tool,
          result: await this.crewAIWorkerService.runTool({
            tool: 'diagnose_container',
            input: { container_name: match.containerName },
          }),
        }
      case 'patch_file_and_verify':
        return {
          tool: match.tool,
          result: await this.crewAIWorkerService.runTool({
            tool: 'patch_file_and_verify',
            input: {
              file_path: match.filePath,
              search: match.search,
              replace: match.replace,
              service_name: match.serviceName,
            },
          }),
        }
      default:
        return null
    }
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

    return null
  }
}
