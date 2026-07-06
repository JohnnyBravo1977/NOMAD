import { inject } from '@adonisjs/core'
import { DesktopShortcutService } from '#services/desktop_shortcut_service'
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
  | 'remove_shortcut'
  | 'run_safe_command'

export type DirectToolMatch =
  | { tool: 'list_containers' }
  | { tool: 'inspect_docker_container'; containerName: string }
  | { tool: 'inspect_files'; filePath: string }
  | { tool: 'read_files'; filePath: string }
  | { tool: 'write_file'; filePath: string; content: string }
  | { tool: 'edit_file'; filePath: string; search: string; replace: string }
  | { tool: 'create_shortcut'; targetName: string }
  | { tool: 'remove_shortcut'; targetName: string }
  | {
      tool: 'run_safe_command'
      command: string
      target?: 'runtime' | 'host_user'
      source?: 'shell_request' | 'sidebar_request'
      explicitlyAllowsPrivilegeChanges?: boolean
      brokerAction?: {
        action: string
        params: Record<string, string>
      }
    }

export type DirectToolExecutionResult = {
  kind: 'direct_tool_execution'
  tool: DirectToolName
  input: Record<string, any>
  rawText: string
}

@inject()
export class DirectToolRegistryService {
  constructor(
    private readWorkerService: ReadWorkerService,
    private editWorkerService: EditWorkerService,
    private terminalWorkerService: TerminalWorkerService,
    private desktopShortcutService: DesktopShortcutService
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
      '- remove_shortcut',
      '- run_safe_command',
      'Direct tool limits:',
      '- Direct tools perform one bounded action at a time and return a deterministic result.',
      '- create_shortcut writes only approved launchers to the Desktop bridge.',
      '- File reads are limited to allowed read roots, and file writes are limited to allowed write roots.',
      '- run_safe_command stays inside the current runtime and blocks destructive or system-admin commands.',
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<DirectToolExecutionResult | null> {
    const match = this.classify(userText)
    if (!match) return null

    switch (match.tool) {
      case 'list_containers':
        return {
          kind: 'direct_tool_execution',
          tool: match.tool,
          input: {},
          rawText: await this.readWorkerService.listContainers(),
        }
      case 'inspect_docker_container':
        return {
          kind: 'direct_tool_execution',
          tool: match.tool,
          input: { containerName: match.containerName },
          rawText: await this.readWorkerService.inspectContainer(match.containerName),
        }
      case 'inspect_files':
        return {
          kind: 'direct_tool_execution',
          tool: match.tool,
          input: { filePath: match.filePath },
          rawText: await this.readWorkerService.inspectPath(match.filePath),
        }
      case 'read_files':
        return {
          kind: 'direct_tool_execution',
          tool: match.tool,
          input: { filePath: match.filePath },
          rawText: await this.readWorkerService.readTextFile(match.filePath),
        }
      case 'write_file':
        return {
          kind: 'direct_tool_execution',
          tool: match.tool,
          input: { filePath: match.filePath, content: match.content },
          rawText: await this.editWorkerService.writeTextFile(match.filePath, match.content),
        }
      case 'edit_file':
        return {
          kind: 'direct_tool_execution',
          tool: match.tool,
          input: { filePath: match.filePath, search: match.search, replace: match.replace },
          rawText: await this.editWorkerService.replaceInTextFile(
            match.filePath,
            match.search,
            match.replace
          ),
        }
      case 'create_shortcut':
        return {
          kind: 'direct_tool_execution',
          tool: match.tool,
          input: { targetName: match.targetName },
          rawText: await this.desktopShortcutService.createApprovedShortcut(match.targetName),
        }
      case 'remove_shortcut':
        return {
          kind: 'direct_tool_execution',
          tool: match.tool,
          input: { targetName: match.targetName },
          rawText: await this.desktopShortcutService.removeApprovedShortcut(match.targetName),
        }
      case 'run_safe_command':
        return {
          kind: 'direct_tool_execution',
          tool: match.tool,
          input: {
            command: match.command,
            target: match.target,
            source: match.source,
            explicitlyAllowsPrivilegeChanges:
              match.explicitlyAllowsPrivilegeChanges ?? allowsPrivilegeChanges(userText, match.command),
            brokerAction: match.brokerAction,
          },
          rawText: await this.terminalWorkerService.runCommand(match.command, {
            explicitlyAllowsPrivilegeChanges:
              match.explicitlyAllowsPrivilegeChanges ?? allowsPrivilegeChanges(userText, match.command),
            target: match.target,
            source: match.source,
            brokerAction: match.brokerAction,
          }),
        }
      default:
        return null
    }
  }

  classify(userText: string): DirectToolMatch | null {
    return this.matchTool(userText)
  }

  private matchTool(userText: string): DirectToolMatch | null {
    const text = userText.trim()
    let match: RegExpMatchArray | null

    const parsedTerminalTask = this.terminalWorkerService.parseRequestedCommand(text)
    if (parsedTerminalTask?.source === 'shell_request') {
      return {
        tool: 'run_safe_command',
        command: parsedTerminalTask.command,
        target: parsedTerminalTask.target,
        source: parsedTerminalTask.source,
        explicitlyAllowsPrivilegeChanges: parsedTerminalTask.explicitlyAllowsPrivilegeChanges,
        brokerAction: parsedTerminalTask.brokerAction,
      }
    }

    if (/\b(?:list|show)\s+(?:all\s+)?containers\b/i.test(text) || /\bwhat containers\b/i.test(text)) {
      return { tool: 'list_containers' }
    }

    match =
      text.match(/^\s*(?:inspect|check|show)\s+(?:the\s+)?docker\s+container\s+([a-zA-Z0-9._-]+)\s*$/i) ||
      text.match(/\b(?:inspect|check|show)\s+(?:the\s+)?(?:docker\s+)?container\s+([a-zA-Z0-9._-]+)/i) ||
      text.match(/\binspect_docker_container\s+([a-zA-Z0-9._-]+)/i)
    if (match) {
      return { tool: 'inspect_docker_container', containerName: match[1] }
    }

    match =
      text.match(/\b(?:inspect|check|show)\s+(?:the\s+)?files?\s+in\s+(.+)$/i) ||
      text.match(/\b(?:inspect|check|show)\s+(?:the\s+)?directory\s+(.+)$/i) ||
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

    const shortcutTarget = extractShortcutTarget(text)
    if (shortcutTarget) {
      return {
        tool: 'create_shortcut',
        targetName: shortcutTarget,
      }
    }

    const removeShortcutTarget = extractShortcutRemovalTarget(text)
    if (removeShortcutTarget) {
      return {
        tool: 'remove_shortcut',
        targetName: removeShortcutTarget,
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
}

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function extractShortcutTarget(text: string): string | null {
  let match =
    text.match(/\b(?:create|make|add)\s+(?:a\s+)?shortcut\s+(?:for\s+)?(.+)$/i) ||
    text.match(/\bcreate_shortcut\s+(.+)$/i) ||
    text.match(/\b(?:create|make|add)\s+(?:us\s+|me\s+)?a?\s*(.+?)\s+shortcut(?:\s+on\s+the\s+desktop|\s+to\s+the\s+desktop|\s+for\s+the\s+desktop)?$/i) ||
    text.match(/\b(?:create|make|add)\s+(?:a\s+)?desktop\s+shortcut\s+(?:for\s+)?(.+)$/i)

  if (!match) return null

  const target = stripWrappingQuotes(match[1])
  if (/^(?:on|in)\s+ubuntu$/i.test(target) || /^ubuntu$/i.test(target)) {
    return null
  }

  return target
}

function extractShortcutRemovalTarget(text: string): string | null {
  const match =
    text.match(/\b(?:remove|delete|erase)\s+(?:the\s+)?(?:shortcut|launcher)\s+(?:for\s+)?(.+?)\s+(?:from|off)\s+(?:the\s+)?desktop$/i) ||
    text.match(/\b(?:remove|delete|erase)\s+(.+?)\s+(?:shortcut|launcher)\s+(?:from|off)\s+(?:the\s+)?desktop$/i) ||
    text.match(/\b(?:remove|delete|erase)\s+(?:the\s+)?(.+?)\s+(?:shortcut|launcher)$/i) ||
    text.match(/\b(?:remove|delete|erase)\s+(?:the\s+)?(?:shortcut|launcher)\s+(?:for\s+)?(.+?)$/i)

  if (!match) return null

  const target = stripWrappingQuotes(match[1])
    .replace(/\s+(?:from|off)\s+(?:the\s+)?desktop$/i, '')
    .trim()
  // Follow-up phrasing like "remove the shortcut you just created" needs prior context.
  // Hermes should handle that as a follow-up, not a direct-tool target.
  if (/\b(you just created|just created|that|it|this|same one)\b/i.test(target)) {
    return null
  }
  return target
}

function allowsPrivilegeChanges(userText: string, command: string): boolean {
  if (!/\b(?:sudo|chmod|chown|chgrp|setfacl|getfacl|install\s+-m|umask|usermod|groupmod)\b/i.test(command)) {
    return false
  }

  return [
    /\b--allow-permissions\b/i,
    /\bwith explicit permission approval\b/i,
    /\bi explicitly (?:want|need|am asking you) to change (?:the )?(?:permissions|ownership)\b/i,
    /\bexplicitly change (?:the )?(?:permissions|ownership)\b/i,
    /\bchange (?:the )?(?:permissions|ownership)\b.*\bexplicitly\b/i,
  ].some((pattern) => pattern.test(userText))
}
