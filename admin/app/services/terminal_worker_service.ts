import { inject } from '@adonisjs/core'
import { spawn } from 'node:child_process'

type TerminalTask = {
  command: string
}

const DEFAULT_CWD = '/app'
const MAX_OUTPUT_BYTES = 16 * 1024
const COMMAND_TIMEOUT_MS = 15_000
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
  /\bchown\b/i,
]

@inject()
export class TerminalWorkerService {
  describeCapabilities(): string {
    return [
      'Terminal worker capabilities:',
      '- Run grounded shell commands inside the nomad_admin runtime',
      '- Return verified stdout, stderr, and exit status',
      '- Useful for inspection, searching, and controlled file/workflow tasks inside the runtime',
      'Terminal limits:',
      `- Working directory defaults to ${DEFAULT_CWD}`,
      `- Output is capped at ${MAX_OUTPUT_BYTES} bytes`,
      `- Commands time out after ${Math.floor(COMMAND_TIMEOUT_MS / 1000)} seconds`,
      '- Host Desktop/Ubuntu write access is not available through this worker',
      '- Package manager and destructive system commands are blocked',
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<string | null> {
    const task = this.parseTask(userText)
    if (!task) return null

    this.assertCommandAllowed(task.command)
    return await this.runCommand(task.command)
  }

  private parseTask(userText: string): TerminalTask | null {
    const text = userText.trim()

    const match =
      text.match(/^\s*(?:run|execute)\s+(?:the\s+)?(?:command|shell command)\s+([\s\S]+)$/i) ||
      text.match(/^\s*(?:use\s+the\s+)?terminal\s+to\s+([\s\S]+)$/i) ||
      text.match(/^\s*(?:in\s+the\s+)?shell[:,]?\s*([\s\S]+)$/i)

    if (!match) return null

    const command = stripWrappingQuotes(match[1])
    if (!command) return null

    return { command }
  }

  private assertCommandAllowed(command: string) {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(`Blocked command pattern matched: ${pattern}`)
      }
    }
  }

  async runCommand(command: string): Promise<string> {
    this.assertCommandAllowed(command)
    const result = await execShell(command)
    const parts = [
      `Command: ${command}`,
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
}

async function execShell(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: DEFAULT_CWD,
      env: process.env,
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
