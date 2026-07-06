import { inject } from '@adonisjs/core'
import { spawn } from 'node:child_process'

type HostBrokerAction = {
  action: string
  params: Record<string, string>
}

type TerminalTask = {
  command: string
  explicitlyAllowsPrivilegeChanges: boolean
  target: 'runtime' | 'host_user'
  source: 'shell_request' | 'sidebar_request'
  brokerAction?: HostBrokerAction
}

const DEFAULT_CWD = '/app'
const HOST_USER_CWD = '/tmp'
const MAX_OUTPUT_BYTES = 16 * 1024
const COMMAND_TIMEOUT_MS = 15_000
const DEFAULT_HOST_SESSION_BROKER_URL = 'http://host.docker.internal:8765'
const DEFAULT_HOST_SESSION_BROKER_TOKEN = 'nomad-host-broker-2026-04-18'
const SAFE_HOST_USER_PATH_PATTERNS = [
  /^\/host-desktop(?:\/|$)/,
  /^\/host-applications(?:\/|$)/,
  /^\/host-config\/dconf(?:\/|$)/,
  /^\/host-user\/Desktop(?:\/|$)/,
  /^\/host-user\/\.local\/share\/applications(?:\/|$)/,
  /^\/host-user\/\.config\/dconf(?:\/|$)/,
  /^\/home\/nomad\/Desktop(?:\/|$)/,
  /^\/home\/nomad\/\.local\/share\/applications(?:\/|$)/,
  /^\/home\/nomad\/\.config\/dconf(?:\/|$)/,
  /^\/tmp(?:\/|$)/,
  /^~\/Desktop(?:\/|$)/,
  /^~\/\.local\/share\/applications(?:\/|$)/,
  /^\/run\/user\/1000\/bus(?:\/|$)/,
]
const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/($|\s)/i,
  /\bmkfs(\.| )/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\binit\s+0\b/i,
  /\buserdel\b/i,
  /\bgroupdel\b/i,
  /\bpasswd\b/i,
  /\bchsh\b/i,
  /\bmount\b/i,
  /\bumount\b/i,
  /\bapt(?:-get)?\s+/i,
  /\bdpkg\s+/i,
  /\bsnap\s+/i,
  /\bsystemctl\b/i,
  /\bservice\s+/i,
  /\bchmod\s+777\b/i,
  /\bgsettings\s+reset\b/i,
  /\bgsettings\s+writable\b/i,
  /\bdconf\s+write\b/i,
  /\bdconf\s+reset\b/i,
]

const PRIVILEGE_CHANGE_PATTERNS = [
  /\bsudo\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bsetfacl\b/i,
  /\bgetfacl\b/i,
  /\binstall\s+-m\b/i,
  /\bumask\b/i,
  /\busermod\b/i,
  /\bgroupmod\b/i,
]

const HOST_USER_MUTATION_PATTERNS = [
  /\brm\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\binstall\b/i,
  /\bln\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\btruncate\b/i,
  /\bsed\s+-i\b/i,
  /\bperl\s+-pi\b/i,
  /\bgsettings\s+set\b/i,
  /(^|[^\w])>\s*/,
  /(^|[^\w])>>\s*/,
]

const HIGH_RISK_HOST_PATH_PATTERNS = [
  /(^|[\s"'=])~(?=\/|$)/,
  /(^|[\s"'=])\$HOME(?=\/|$)/,
  /(^|[\s"'=])\/home\/nomad(?=\/|$)/,
  /(^|[\s"'=])\/etc(?=\/|$)/,
  /(^|[\s"'=])\/usr(?=\/|$)/,
  /(^|[\s"'=])\/bin(?=\/|$)/,
  /(^|[\s"'=])\/lib(?=\/|$)/,
  /(^|[\s"'=])\/var(?=\/|$)/,
]

@inject()
export class TerminalWorkerService {
  describeCapabilities(): string {
    return [
      'Terminal worker capabilities:',
      '- Run grounded shell commands inside the nomad_admin runtime',
      '- Return verified stdout, stderr, and exit status',
      '- Useful for inspection, searching, and controlled file/workflow tasks inside the runtime',
      '- Can run a narrow set of guarded host-user Desktop/session commands when explicitly routed there',
      'Terminal limits:',
      `- Working directory defaults to ${DEFAULT_CWD}`,
      `- Host-user commands use ${HOST_USER_CWD} with the GNOME session bridge when explicitly routed there`,
      `- Output is capped at ${MAX_OUTPUT_BYTES} bytes`,
      `- Commands time out after ${Math.floor(COMMAND_TIMEOUT_MS / 1000)} seconds`,
      '- Host-user writes are limited to the Desktop/session bridges, not the full home directory',
      '- Package manager and destructive system commands are blocked',
      '- Permission or ownership changes are blocked unless you explicitly ask for them',
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<string | null> {
    const task = this.parseRequestedCommand(userText)
    if (!task) return null

    this.assertCommandAllowed(task.command, {
      explicitlyAllowsPrivilegeChanges: task.explicitlyAllowsPrivilegeChanges,
      target: task.target,
      source: task.source,
    })
    return await this.runCommand(task.command, {
      explicitlyAllowsPrivilegeChanges: task.explicitlyAllowsPrivilegeChanges,
      target: task.target,
      source: task.source,
      brokerAction: task.brokerAction,
    })
  }

  parseRequestedCommand(userText: string): TerminalTask | null {
    const text = userText.trim()

    const match =
      text.match(/^\s*(?:run|execute)\s+(?:the\s+)?safe command\s+([\s\S]+)$/i) ||
      text.match(/^\s*(?:run|execute)\s+(?:the\s+)?(?:command|shell command)\s+([\s\S]+)$/i) ||
      text.match(/^\s*(?:use\s+(?:the\s+)?)?terminal\s+to\s+([\s\S]+)$/i) ||
      text.match(/^\s*(?:in\s+the\s+)?shell[:,]?\s*([\s\S]+)$/i)

    if (!match) {
      const brokerAction = this.buildSidebarBrokerAction(text)
      if (!brokerAction) return null
      return {
        command: `run host broker action ${brokerAction.action}`,
        explicitlyAllowsPrivilegeChanges: false,
        target: 'host_user',
        source: 'sidebar_request',
        brokerAction,
      }
    }

    const rawCommand = stripWrappingQuotes(match[1])
    const explicitlyAllowsPrivilegeChanges = this.explicitlyAllowsPrivilegeChanges(text)
    const command = this.stripExplicitPermissionApprovalMarker(rawCommand)
    if (!command) return null

    return {
      command,
      explicitlyAllowsPrivilegeChanges,
      target: /^\s*(?:use\s+(?:the\s+)?)?terminal\s+to\s+/i.test(text) ? 'host_user' : 'runtime',
      source: 'shell_request',
    }
  }

  isPrivilegeChangingCommand(command: string): boolean {
    return PRIVILEGE_CHANGE_PATTERNS.some((pattern) => pattern.test(command))
  }

  private buildSidebarBrokerAction(userText: string): HostBrokerAction | null {
    const match =
      userText.match(/\b(?:pin|add|put)\s+(.+?)\s+(?:to|on)\s+(?:the\s+)?(?:sidebar|dock|favorites)\b/i) ||
      userText.match(/\b(?:pin|add)\s+(.+?)\s+(?:as\s+)?(?:a\s+)?favorite\b/i)

    if (!match) return null

    const rawTarget = normalizeSidebarTarget(match[1])
    const desktopId = resolveSidebarDesktopId(rawTarget)
    if (!desktopId) return null

    return {
      action: 'favorites.pin',
      params: {
        desktop_id: desktopId,
      },
    }
  }

  private assertCommandAllowed(
    command: string,
    options?: {
      explicitlyAllowsPrivilegeChanges?: boolean
      target?: 'runtime' | 'host_user'
      source?: 'shell_request' | 'sidebar_request'
    }
  ) {
    const explicitlyAllowsPrivilegeChanges = options?.explicitlyAllowsPrivilegeChanges === true
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(`Blocked command pattern matched: ${pattern}`)
      }
    }

    if (!explicitlyAllowsPrivilegeChanges) {
      for (const pattern of PRIVILEGE_CHANGE_PATTERNS) {
        if (pattern.test(command)) {
          throw new Error(
            'Permission, ownership, or privilege-changing commands are blocked unless you explicitly ask for that exact kind of change.'
          )
        }
      }
    }

    if (options?.target === 'host_user') {
      this.assertHostUserCommandAllowed(command, options.source)
    }
  }

  async runCommand(
    command: string,
    options?: {
      explicitlyAllowsPrivilegeChanges?: boolean
      target?: 'runtime' | 'host_user'
      source?: 'shell_request' | 'sidebar_request'
      brokerAction?: HostBrokerAction
    }
  ): Promise<string> {
    const explicitlyAllowsPrivilegeChanges =
      options?.explicitlyAllowsPrivilegeChanges === true ||
      this.explicitlyAllowsPrivilegeChanges(command)
    const effectiveCommand = this.stripExplicitPermissionApprovalMarker(command)

    this.assertCommandAllowed(effectiveCommand, {
      explicitlyAllowsPrivilegeChanges,
      target: options?.target,
      source: options?.source ?? 'shell_request',
    })
    const result =
      options?.source === 'sidebar_request' && options?.brokerAction
        ? await this.runHostBrokerAction(options.brokerAction)
        : options?.target === 'host_user'
        ? await execShell(effectiveCommand, {
            cwd: HOST_USER_CWD,
            env: {
              ...process.env,
              DISPLAY: process.env.DISPLAY || ':0',
              HOME: '/home/nomad',
              XDG_CONFIG_HOME: '/home/nomad/.config',
              XDG_RUNTIME_DIR: '/run/user/1000',
              DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
            },
            uid: 1000,
            gid: 1000,
          })
        : await execShell(effectiveCommand, {
            cwd: DEFAULT_CWD,
            env: process.env,
          })
    if (options?.source === 'sidebar_request') {
      return formatSidebarResult(result)
    }

    const parts = [
      `Command: ${effectiveCommand}`,
      `Exit code: ${result.exitCode}`,
    ]

    if (result.stdout) {
      parts.push(`Stdout:\n${result.stdout}`)
    }
    if (result.stderr) {
      parts.push(`Stderr:\n${result.stderr}`)
    }

    if (!result.stdout && !result.stderr) {
      parts.push('No output was produced.')
    }

    return parts.join('\n\n')
  }

  private async runHostBrokerAction(
    brokerAction: HostBrokerAction
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const brokerUrl = (process.env.NOMAD_HOST_BROKER_URL || DEFAULT_HOST_SESSION_BROKER_URL).replace(/\/$/, '')

    try {
      const response = await fetch(`${brokerUrl}/v1/actions/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Nomad-Broker-Token':
            process.env.NOMAD_HOST_BROKER_TOKEN || DEFAULT_HOST_SESSION_BROKER_TOKEN,
        },
        body: JSON.stringify({
          action: brokerAction.action,
          params: brokerAction.params,
        }),
      })

      const payload = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null
      if (!response.ok) {
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            typeof payload?.error === 'string'
              ? payload.error
              : `Broker request failed with HTTP ${response.status}`,
        }
      }

      return {
        exitCode: 0,
        stdout:
          typeof payload?.message === 'string'
            ? payload.message
            : 'The host action broker completed the requested action.',
        stderr: '',
      }
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr:
          error instanceof Error
            ? `The host action broker is unavailable: ${error.message}`
            : 'The host action broker is unavailable.',
      }
    }
  }

  private explicitlyAllowsPrivilegeChanges(userText: string): boolean {
    return [
      /\b--allow-permissions\b/i,
      /\bwith explicit permission approval\b/i,
      /\bi explicitly (?:want|need|am asking you) to change (?:the )?(?:permissions|ownership)\b/i,
      /\bexplicitly change (?:the )?(?:permissions|ownership)\b/i,
      /\bchange (?:the )?(?:permissions|ownership)\b.*\bexplicitly\b/i,
    ].some((pattern) => pattern.test(userText))
  }

  private stripExplicitPermissionApprovalMarker(command: string): string {
    return command
      .replace(/^\s*--allow-permissions\b[:\s-]*/i, '')
      .replace(/^\s*with explicit permission approval\b[:\s-]*/i, '')
      .trim()
  }

  private assertHostUserCommandAllowed(
    command: string,
    source: 'shell_request' | 'sidebar_request' | undefined
  ) {
    if (/\bgsettings\s+set\b/i.test(command) && !/\borg\.gnome\.shell\s+favorite-apps\b/i.test(command)) {
      throw new Error('Host session setting changes are limited to GNOME favorites right now.')
    }

    if (source === 'sidebar_request') {
      return
    }

    const mutatesHostUserState = HOST_USER_MUTATION_PATTERNS.some((pattern) => pattern.test(command))
    if (!mutatesHostUserState) {
      return
    }

    const referencedPaths = extractAbsoluteAndTildePaths(command)
    const hasReferencedPaths = referencedPaths.length > 0
    const allReferencedPathsAreSafe =
      hasReferencedPaths &&
      referencedPaths.every((candidate) => SAFE_HOST_USER_PATH_PATTERNS.some((pattern) => pattern.test(candidate)))
    if (allReferencedPathsAreSafe) {
      return
    }

    for (const pattern of HIGH_RISK_HOST_PATH_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(
          'That host-user terminal command touches a high-risk path, so I blocked it. Use the narrow Desktop/session bridges or ask for a safer bounded command.'
        )
      }
    }

    const unsafeReferencedPath = referencedPaths.find(
      (candidate) => !SAFE_HOST_USER_PATH_PATTERNS.some((pattern) => pattern.test(candidate))
    )
    if (unsafeReferencedPath) {
      throw new Error(
        `That host-user terminal command touches ${unsafeReferencedPath}, which is outside the allowed Desktop/session bridges.`
      )
    }
  }
}

async function execShell(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; uid?: number; gid?: number }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-c', command], {
      cwd: options.cwd,
      env: options.env,
      uid: options.uid,
      gid: options.gid,
    })

    let stdout = ''
    let stderr = ''
    let finished = false

    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      child.kill('SIGTERM')
      reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS}ms`))
    }, COMMAND_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, String(chunk))
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, String(chunk))
    })

    child.on('error', (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({
        exitCode: code ?? 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })
  })
}

function appendBounded(current: string, addition: string): string {
  const combined = current + addition
  if (Buffer.byteLength(combined, 'utf-8') <= MAX_OUTPUT_BYTES) {
    return combined
  }

  const truncated = Buffer.from(combined, 'utf-8')
    .subarray(0, MAX_OUTPUT_BYTES)
    .toString('utf-8')

  return `${truncated}\n...[truncated]`
}

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function normalizeSidebarTarget(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+(?:please|for me)$/i, '')
    .replace(/^\s*the\s+/i, '')
    .replace(/\s+(?:shortcut|launcher)$/i, '')
    .trim()
}

function resolveSidebarDesktopId(target: string): string | null {
  if (['home assistant', 'homeassistant', 'ha'].includes(target)) {
    return 'home-assistant.desktop'
  }

  if (['nomad', 'n.o.m.a.d.', 'project nomad'].includes(target)) {
    return 'nomad.desktop'
  }

  return null
}

function extractAbsoluteAndTildePaths(command: string): string[] {
  const matches = command.match(/(?:~\/[^\s"'`|;&()]+|\/[^\s"'`|;&()]+)/g) || []
  return Array.from(new Set(matches))
}

function formatSidebarResult(result: { exitCode: number; stdout: string; stderr: string }): string {
  const stdout = result.stdout.trim()
  const stderr = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('/root/.bashrc') && !line.includes('/root/.bash_profile'))
    .join('\n')

  if (result.exitCode === 0) {
    if (stdout) {
      return stdout
    }
    return 'I prepared the launcher in the applications directory, but there was nothing else to report.'
  }

  const parts = ['I could not finish that sidebar action safely.']
  if (stdout) {
    parts.push(`Details: ${stdout}`)
  }
  if (stderr) {
    parts.push(`Error: ${stderr}`)
  }
  return parts.join('\n')
}
