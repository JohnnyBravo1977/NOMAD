import { inject } from '@adonisjs/core'
import { HermesRouterService } from '#services/hermes_router_service'
import { RagService } from '#services/rag_service'
import { OllamaService } from '#services/ollama_service'
import fs from 'node:fs/promises'
import path from 'node:path'

type GateCaseExpect = {
  mustMatch?: string[]
  mustNotMatch?: string[]
  mustNotHaveEmoji?: boolean
}

type GateCase = {
  id: string
  seed?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  turns: string[]
  expect: GateCaseExpect
}

type GateFixture = {
  meta?: { defaultModel?: string }
  cases?: GateCase[]
}

export type ConversationGateFailure = {
  caseId: string
  mode: 'json' | 'stream'
  failures: string[]
  reply: string
}

export type ConversationGateResult =
  | { ok: true; model: string; failures: []; ran: { cases: number; modes: Array<'json' | 'stream'> } }
  | { ok: false; model: string; failures: ConversationGateFailure[]; ran: { cases: number; modes: Array<'json' | 'stream'> } }

function hasExtendedPictographic(text: string): boolean {
  try {
    return /\p{Extended_Pictographic}/u.test(text)
  } catch {
    return false
  }
}

function validateReply(text: string, expect: GateCaseExpect): string[] {
  const failures: string[] = []
  for (const pattern of expect.mustMatch || []) {
    const re = new RegExp(pattern, 'i')
    if (!re.test(text)) failures.push(`missing mustMatch: /${pattern}/i`)
  }
  for (const pattern of expect.mustNotMatch || []) {
    const re = new RegExp(pattern, 'i')
    if (re.test(text)) failures.push(`hit mustNotMatch: /${pattern}/i`)
  }
  if (expect.mustNotHaveEmoji && hasExtendedPictographic(text)) {
    failures.push('hit mustNotHaveEmoji')
  }
  return failures
}

@inject()
export class ConversationGateService {
  constructor(
    private hermesRouterService: HermesRouterService,
    private ragService: RagService,
    private ollamaService: OllamaService
  ) {}

  private async resolveRunnableModel(preferred: string): Promise<string> {
    const installed = await this.ollamaService.getModels(true).catch(() => [])
    if (installed.some((m) => m.name === preferred)) return preferred

    const fallback = installed.find((m) => typeof m.name === 'string' && m.name.trim())?.name || null
    if (fallback) return fallback

    throw new Error(
      `No runnable AI model is installed. Install a model (Settings → Models) before running the conversation gate.`
    )
  }

  async runConversationGate(args?: {
    fixturePath?: string
    modes?: Array<'json' | 'stream'>
    onlyCaseIds?: string[]
  }): Promise<ConversationGateResult> {
    const modes: Array<'json' | 'stream'> = args?.modes?.length ? args.modes : ['json', 'stream']
    const fixturePath =
      args?.fixturePath ||
      path.join(process.cwd(), 'scripts', 'conversation_cases.json')

    const raw = await fs.readFile(fixturePath, 'utf-8')
    const fixture = JSON.parse(raw) as GateFixture
    const preferredModel = fixture?.meta?.defaultModel || 'qwen2.5:32b-instruct-q5_K_M'
    const model = await this.resolveRunnableModel(preferredModel)
    const selectedCases = Array.isArray(fixture?.cases) ? fixture.cases : []
    const onlySet = args?.onlyCaseIds?.length ? new Set(args.onlyCaseIds) : null

    const failures: ConversationGateFailure[] = []

    for (const testCase of selectedCases) {
      if (!testCase?.id || !Array.isArray(testCase.turns)) continue
      if (onlySet && !onlySet.has(testCase.id)) continue

      for (const mode of modes) {
        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
        if (Array.isArray(testCase.seed)) {
          for (const seedMessage of testCase.seed) {
            if (!seedMessage?.role || typeof seedMessage.content !== 'string') continue
            if (seedMessage.role !== 'system' && seedMessage.role !== 'user' && seedMessage.role !== 'assistant') continue
            messages.push({ role: seedMessage.role, content: seedMessage.content })
          }
        }
        let lastAssistant = ''

        for (const userText of testCase.turns) {
          messages.push({ role: 'user', content: userText })

          if (mode === 'json') {
            const routed = await this.hermesRouterService.runChatTurn({
              requestData: {
                model,
                messages,
                stream: false,
              // Keep the gate fast and deterministic.
              think: false,
              maxTokens: 140,
              temperature: 0,
            },
            ragService: this.ragService,
            perfStart: Date.now(),
          })
            const result = routed.result
            const reply =
              result.kind === 'json'
                ? (result.body?.message?.content as string) || ''
                : ''
            lastAssistant = typeof reply === 'string' ? reply : ''
          } else {
            let content = ''
            await this.hermesRouterService.runChatTurn({
              requestData: {
                model,
                messages,
                stream: true,
              think: false,
              maxTokens: 140,
              temperature: 0,
            },
            ragService: this.ragService,
            perfStart: Date.now(),
            onStreamChunk: async (chunk) => {
                const part = (chunk as any)?.message?.content
                if (typeof part === 'string' && part) content += part
              },
            })
            lastAssistant = content
          }

          messages.push({ role: 'assistant', content: lastAssistant })
        }

        const caseFailures = validateReply(lastAssistant || '', testCase.expect || {})
        if (caseFailures.length > 0) {
          failures.push({
            caseId: testCase.id,
            mode,
            failures: caseFailures,
            reply: lastAssistant || '',
          })
        }
      }
    }

    if (failures.length > 0) {
      return {
        ok: false,
        model,
        failures,
        ran: { cases: onlySet ? onlySet.size : selectedCases.length, modes },
      }
    }

    return { ok: true, model, failures: [], ran: { cases: onlySet ? onlySet.size : selectedCases.length, modes } }
  }
}
