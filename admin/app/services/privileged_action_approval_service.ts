import { inject } from '@adonisjs/core'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import path from 'node:path'
import { TerminalWorkerService } from '#services/terminal_worker_service'

type PendingPrivilegedAction = {
  type: 'terminal_command'
  command: string
  target: 'runtime' | 'host_user'
  source: 'shell_request' | 'sidebar_request'
  createdAt: string
}

const APPROVAL_DIR = '/app/storage/pending-approvals'

@inject()
export class PrivilegedActionApprovalService {
  constructor(private terminalWorkerService: TerminalWorkerService) {}

  async tryHandlePendingApproval(userText: string, sessionId: number | null): Promise<string | null> {
    if (!sessionId) return null

    const pending = await this.getPendingAction(sessionId)
    if (!pending) return null

    if (isApprovalResponse(userText)) {
      await this.clearPendingAction(sessionId)
      return await this.terminalWorkerService.runCommand(pending.command, {
        explicitlyAllowsPrivilegeChanges: true,
        target: pending.target,
        source: pending.source,
      })
    }

    if (isRejectionResponse(userText)) {
      await this.clearPendingAction(sessionId)
      return 'Okay. I canceled that privileged change and did not run it.'
    }

    return null
  }

  async tryCreateApprovalRequest(userText: string, sessionId: number | null): Promise<string | null> {
    const parsedCommand = this.terminalWorkerService.parseRequestedCommand(userText)
    if (!parsedCommand) return null
    if (!this.terminalWorkerService.isPrivilegeChangingCommand(parsedCommand.command)) return null
    if (parsedCommand.explicitlyAllowsPrivilegeChanges) return null

    if (!sessionId) {
      return [
        'That command would change permissions, ownership, or privileges.',
        'I will not run it by default.',
        'Please retry it in a saved chat and then reply with a clear approval like "yes, approve it" if you want me to continue.',
      ].join(' ')
    }

    await this.setPendingAction(sessionId, {
      type: 'terminal_command',
      command: parsedCommand.command,
      target: parsedCommand.target,
      source: parsedCommand.source,
      createdAt: new Date().toISOString(),
    })

    return [
      'That command would change permissions, ownership, or privileges, so I paused before running it.',
      `Pending command: ${parsedCommand.command}`,
      'Reply with "yes, approve it" to continue or "no, cancel it" to stop.',
    ].join('\n')
  }

  private async getPendingAction(sessionId: number): Promise<PendingPrivilegedAction | null> {
    try {
      const target = this.getSessionFile(sessionId)
      const raw = await readFile(target, 'utf-8')
      return JSON.parse(raw) as PendingPrivilegedAction
    } catch {
      return null
    }
  }

  private async setPendingAction(sessionId: number, payload: PendingPrivilegedAction): Promise<void> {
    await mkdir(APPROVAL_DIR, { recursive: true })
    await writeFile(this.getSessionFile(sessionId), JSON.stringify(payload), 'utf-8')
  }

  private async clearPendingAction(sessionId: number): Promise<void> {
    await rm(this.getSessionFile(sessionId), { force: true })
  }

  private getSessionFile(sessionId: number): string {
    return path.join(APPROVAL_DIR, `session-${sessionId}.json`)
  }
}

function isApprovalResponse(value: string): boolean {
  const text = value.trim().toLowerCase()
  return [
    /^yes\b/,
    /^approve\b/,
    /^yes[, ]+approve\b/,
    /\byes[, ]+approve it\b/,
    /\bgo ahead\b/,
    /\bproceed\b/,
    /\bdo it\b/,
  ].some((pattern) => pattern.test(text))
}

function isRejectionResponse(value: string): boolean {
  const text = value.trim().toLowerCase()
  return [
    /^no\b/,
    /^cancel\b/,
    /\bdon't\b/,
    /\bdo not\b/,
    /\bstop\b/,
    /\bnever mind\b/,
  ].some((pattern) => pattern.test(text))
}
