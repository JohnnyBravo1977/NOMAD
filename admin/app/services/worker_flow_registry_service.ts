import { inject } from '@adonisjs/core'
import { EditWorkerService } from '#services/edit_worker_service'
import { ReadWorkerService } from '#services/read_worker_service'
import { SystemWorkerService } from '#services/system_worker_service'

export type WorkerFlowToolName =
  | 'diagnose_container'
  | 'patch_file_and_verify'

type WorkerFlowMatch =
  | { tool: 'diagnose_container'; containerName: string }
  | { tool: 'patch_file_and_verify'; filePath: string; search: string; replace: string; serviceName?: string }

@inject()
export class WorkerFlowRegistryService {
  constructor(
    private readWorkerService: ReadWorkerService,
    private editWorkerService: EditWorkerService,
    private systemWorkerService: SystemWorkerService
  ) {}

  describeTools(): string {
    return [
      'Worker-flow tools:',
      '- diagnose_container',
      '- patch_file_and_verify',
      'Worker-flow tool model:',
      '- A worker-flow tool runs a bounded multi-step job using sub-tools, then returns one grounded result.',
      '- This is the execution lane where a CrewAI-based subagent can live later without affecting direct tools.',
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<{ tool: WorkerFlowToolName; result: string } | null> {
    const match = this.matchTool(userText)
    if (!match) return null

    switch (match.tool) {
      case 'diagnose_container':
        return {
          tool: match.tool,
          result: await this.diagnoseContainer(match.containerName),
        }
      case 'patch_file_and_verify':
        return {
          tool: match.tool,
          result: await this.patchFileAndVerify(
            match.filePath,
            match.search,
            match.replace,
            match.serviceName
          ),
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

  private async diagnoseContainer(containerName: string): Promise<string> {
    const steps: string[] = []

    const containerInfo = await this.readWorkerService.inspectContainer(containerName)
    steps.push(`Step 1 — container inspection:\n${containerInfo}`)

    const logs = await this.readWorkerService.tailContainerLogs(containerName)
    steps.push(`Step 2 — recent logs:\n${logs}`)

    if (/homeassistant/i.test(containerName)) {
      const directories = await this.readWorkerService.listHomeAssistantDirectories()
      steps.push(`Step 3 — config structure:\n${directories}`)
    }

    return [
      `I ran the diagnose_container worker flow for ${containerName}.`,
      'Here is the grounded result from the inspection steps:',
      steps.join('\n\n'),
    ].join('\n')
  }

  private async patchFileAndVerify(
    filePath: string,
    search: string,
    replace: string,
    serviceName?: string
  ): Promise<string> {
    const steps: string[] = []

    const before = await this.readWorkerService.readTextFile(filePath)
    steps.push(`Step 1 — file before patch:\n${before}`)

    const patch = await this.editWorkerService.replaceInTextFile(filePath, search, replace)
    steps.push(`Step 2 — patch result:\n${patch}`)

    const after = await this.readWorkerService.readTextFile(filePath)
    steps.push(`Step 3 — file after patch:\n${after}`)

    if (serviceName) {
      const restart = await this.systemWorkerService.tryHandle(`restart service ${serviceName}`)
      steps.push(`Step 4 — restart result:\n${restart || `I couldn't restart ${serviceName}.`}`)

      const status = await this.systemWorkerService.tryHandle(`status of service ${serviceName}`)
      steps.push(`Step 5 — verification status:\n${status || `I couldn't verify ${serviceName}.`}`)
    }

    return [
      `I ran the patch_file_and_verify worker flow for ${filePath}.`,
      'Here is the grounded result from each step:',
      steps.join('\n\n'),
    ].join('\n')
  }
}
