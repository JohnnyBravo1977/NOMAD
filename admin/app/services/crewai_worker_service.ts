import { inject } from '@adonisjs/core'
import { spawn } from 'node:child_process'

export type CrewAIWorkerFlowName =
  | 'diagnose_container'
  | 'patch_file_and_verify'

type CrewAIRunPayload =
  | { tool: 'diagnose_container'; input: { container_name: string } }
  | {
      tool: 'patch_file_and_verify'
      input: { file_path: string; search: string; replace: string; service_name?: string }
    }

@inject()
export class CrewAIWorkerService {
  private readonly baseUrl = process.env.NOMAD_CREWAI_URL || 'http://crewai:8000'

  async isAvailable(): Promise<boolean> {
    try {
      const output = await this.runCurl([
        '-sS',
        '--max-time',
        '5',
        `${this.baseUrl}/health`,
      ])
      const body = JSON.parse(output || '{}') as { status?: string }
      return body.status === 'ok'
    } catch {
      return false
    }
  }

  async describeCapabilities(): Promise<string> {
    const available = await this.isAvailable()
    return [
      'CrewAI worker-flow engine:',
      `- Status: ${available ? 'available' : 'unavailable'}`,
      `- URL: ${this.baseUrl}`,
      '- Purpose: bounded multi-step worker-flow execution only',
      '- Current tools: diagnose_container, patch_file_and_verify',
    ].join('\n')
  }

  async runTool(payload: CrewAIRunPayload): Promise<string> {
    const receiptOutput = await this.runCurl([
      '-sS',
      '--max-time',
      '20',
      '-X',
      'POST',
      `${this.baseUrl}/run`,
      '-H',
      'Content-Type: application/json',
      '-H',
      'Expect:',
      '-d',
      JSON.stringify(payload),
    ])

    const receipt = JSON.parse(receiptOutput || '{}') as { job_id?: string; detail?: string }
    if (receipt.detail) {
      throw new Error(`CrewAI worker-flow request failed: ${receipt.detail}`)
    }
    if (!receipt.job_id) {
      throw new Error('CrewAI worker-flow request did not return a job id.')
    }

    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      const statusOutput = await this.runCurl([
        '-sS',
        '--max-time',
        '20',
        `${this.baseUrl}/jobs/${receipt.job_id}`,
      ])
      const status = JSON.parse(statusOutput || '{}') as {
        status?: string
        result?: string
        error?: string
      }

      if (status.status === 'completed' && status.result) {
        return status.result.trim()
      }
      if (status.status === 'failed') {
        throw new Error(`CrewAI worker-flow job failed: ${status.error || 'unknown error'}`)
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    throw new Error('CrewAI worker-flow job timed out before completing.')
  }

  private async runCurl(args: string[]): Promise<string> {
    return await new Promise((resolve, reject) => {
      const child = spawn('curl', args, {
        env: process.env,
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })

      child.on('error', reject)

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim())
          return
        }
        reject(new Error(`curl exited with code ${code}: ${stderr.trim() || stdout.trim()}`))
      })
    })
  }
}
