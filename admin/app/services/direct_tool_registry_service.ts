import { inject } from '@adonisjs/core'
import { EditWorkerService } from '#services/edit_worker_service'
import { ReadWorkerService } from '#services/read_worker_service'
import { TerminalWorkerService } from '#services/terminal_worker_service'

export type DirectToolName =
  | 'list_containers'
  | 'inspect_docker_container'
  | 'inspect_files'
  | 'read_files'
  | 'write_file'
  | 'edit_file'
  | 'create_shortcut'
  | 'run_safe_command'

type DirectToolMatch =
  | { tool: 'list_containers' }
  | { tool: 'inspect_docker_container'; containerName: string }
  | { tool: 'inspect_files'; filePath: string }
  | { tool: 'read_files'; filePath: string }
  | { tool: 'write_file'; filePath: string; content: string }
  | { tool: 'edit_file'; filePath: string; search: string; replace: string }
  | { tool: 'create_shortcut'; targetName: string }
  | { tool: 'run_safe_command'; command: string }

@inject()
export class DirectToolRegistryService {
  constructor(
    private readWorkerService: ReadWorkerService,
    private editWorkerService: EditWorkerService,
    private terminalWorkerService: TerminalWorkerService
  ) {}

  describeTools(): string {
    return [
      'Direct deterministic tools:',
      '- list_containers',
      '- inspect_docker_container',
      '- inspect_files',
      '- read_files',
      '- write_file',
      '- edit_file',
      '- create_shortcut',
      '- run_safe_command',
      'Direct tool limits:',
      '- Direct tools perform one bounded action at a time and return a deterministic result.',
      '- create_shortcut is currently capability-gated and does not write to the host Desktop.',
      '- File reads are limited to allowed read roots, and file writes are limited to allowed write roots.',
      '- run_safe_command stays inside the current runtime and blocks destructive or system-admin commands.',
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<{ tool: DirectToolName; result: string } | null> {
    const match = this.matchTool(userText)
    if (!match) return null

    switch (match.tool) {
      case 'list_containers':
        return { tool: match.tool, result: await this.readWorkerService.listContainers() }
      case 'inspect_docker_container':
        return { tool: match.tool, result: await this.readWorkerService.inspectContainer(match.containerName) }
      case 'inspect_files':
        return { tool: match.tool, result: await this.readWorkerService.inspectPath(match.filePath) }
      case 'read_files':
        return { tool: match.tool, result: await this.readWorkerService.readTextFile(match.filePath) }
      case 'write_file':
        return { tool: match.tool, result: await this.editWorkerService.writeTextFile(match.filePath, match.content) }
      case 'edit_file':
        return {
          tool: match.tool,
          result: await this.editWorkerService.replaceInTextFile(
            match.filePath,
            match.search,
            match.replace
          ),
        }
      case 'create_shortcut':
        return { tool: match.tool, result: this.createShortcutCapabilityMessage(match.targetName) }
      case 'run_safe_command':
        return { tool: match.tool, result: await this.terminalWorkerService.runCommand(match.command) }
      default:
        return null
    }
  }

  private matchTool(userText: string): DirectToolMatch | null {
    const text = userText.trim()
    let match: RegExpMatchArray | null

    if (/\b(?:list|show)\s+(?:all\s+)?containers\b/i.test(text) || /\bwhat containers\b/i.test(text)) {
      return { tool: 'list_containers' }
    }

    match =
      text.match(/\b(?:inspect|check|show)\s+(?:the\s+)?(?:docker\s+)?container\s+([a-zA-Z0-9._-]+)/i) ||
      text.match(/\binspect_docker_container\s+([a-zA-Z0-9._-]+)/i)
    if (match) {
      return { tool: 'inspect_docker_container', containerName: match[1] }
    }

    match =
      text.match(/\b(?:inspect|check)\s+(?:the\s+)?file\s+(.+)$/i) ||
      text.match(/\binspect_files\s+(.+)$/i)
    if (match) {
      return { tool: 'inspect_files', filePath: stripWrappingQuotes(match[1]) }
    }

    match =
      text.match(/\b(?:read|show|open)\s+(?:the\s+)?file\s+(.+)$/i) ||
      text.match(/\bread_files\s+(.+)$/i)
    if (match) {
      return { tool: 'read_files', filePath: stripWrappingQuotes(match[1]) }
    }

    match =
      text.match(/\b(?:write|create)\s+(?:the\s+)?file\s+([^\s]+)\s+(?:with|containing)\s+([\s\S]+)$/i) ||
      text.match(/\bwrite_file\s+([^\s]+)\s+([\s\S]+)$/i)
    if (match) {
      return {
        tool: 'write_file',
        filePath: stripWrappingQuotes(match[1]),
        content: stripWrappingQuotes(match[2]),
      }
    }

    match =
      text.match(/\bedit\s+(?:the\s+)?file\s+([^\s]+)\s+replace\s+["']([\s\S]+?)["']\s+with\s+["']([\s\S]+?)["']/i) ||
      text.match(/\bedit_file\s+([^\s]+)\s+["']([\s\S]+?)["']\s+["']([\s\S]+?)["']/i)
    if (match) {
      return {
        tool: 'edit_file',
        filePath: stripWrappingQuotes(match[1]),
        search: match[2],
        replace: match[3],
      }
    }

    match =
      text.match(/\b(?:create|make|add)\s+(?:a\s+)?shortcut\s+(?:for\s+)?(.+)$/i) ||
      text.match(/\bcreate_shortcut\s+(.+)$/i)
    if (match) {
      return {
        tool: 'create_shortcut',
        targetName: stripWrappingQuotes(match[1]),
      }
    }

    match =
      text.match(/\b(?:run|execute)\s+(?:the\s+)?safe command\s+([\s\S]+)$/i) ||
      text.match(/\brun_safe_command\s+([\s\S]+)$/i)
    if (match) {
      return {
        tool: 'run_safe_command',
        command: stripWrappingQuotes(match[1]),
      }
    }

    return null
  }

  private createShortcutCapabilityMessage(targetName: string): string {
    const normalizedTargetName = this.normalizeShortcutTargetName(targetName)

    return [
      normalizedTargetName
        ? `Missing capability: create_shortcut is defined for ${normalizedTargetName}, but verified host Desktop shortcut creation is disabled right now.`
        : 'Missing capability: create_shortcut is available in principle, but verified host Desktop shortcut creation is disabled right now.',
      'Current status:',
      '- No host Desktop action bridge is available.',
      '- No direct host home-directory write access is available.',
      '- To enable this tool safely, we need a narrow host shortcut bridge instead of broad host writes.',
    ].join('\n')
  }

  private normalizeShortcutTargetName(value: string): string {
    const normalized = value
      .trim()
      .replace(/\s+(?:please|for me)$/i, '')
      .replace(/^(?:on|in)\s+ubuntu$/i, '')
      .replace(/\s+(?:on|in)\s+ubuntu$/i, '')
      .replace(/^(?:on|to)\s+the\s+desktop$/i, '')
      .replace(/\s+(?:on|to)\s+the\s+desktop$/i, '')
      .replace(/\s+and\s+put\s+it\s+on\s+the\s+desktop$/i, '')
      .replace(/\s+and\s+add\s+it\s+to\s+the\s+desktop$/i, '')
      .trim()

    if (!normalized || /^(ubuntu|desktop|the desktop)$/i.test(normalized)) {
      return ''
    }

    return normalized
  }
}

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}
