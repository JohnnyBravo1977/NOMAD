import { inject } from '@adonisjs/core'
import env from '#start/env'
import path from 'node:path'
import KVStore from '#models/kv_store'
import { RagService } from '#services/rag_service'
import { ChatService } from '#services/chat_service'
import { DirectToolRegistryService } from '#services/direct_tool_registry_service'
import { OllamaService } from '#services/ollama_service'
import { EditWorkerService } from '#services/edit_worker_service'
import { HomeAssistantWorkerService } from '#services/home_assistant_worker_service'
import { ReadWorkerService } from '#services/read_worker_service'
import { SystemWorkerService } from '#services/system_worker_service'
import { TerminalWorkerService } from '#services/terminal_worker_service'
import { WorkerFlowRegistryService } from '#services/worker_flow_registry_service'
import { appendFile, mkdir, writeFile } from 'fs/promises'
import logger from '@adonisjs/core/services/logger'
import { DEFAULT_QUERY_REWRITE_MODEL, RAG_CONTEXT_LIMITS, SYSTEM_PROMPTS } from '../../constants/ollama.js'

type Message = { role: 'system' | 'user' | 'assistant'; content: string }

type RetrievalDoc = { text: string; score: number; metadata?: Record<string, any> }

type KnowledgeContextPlan = {
  lastUserText: string
  rewrittenQuery: string | null
  rewriteMs: number
  ragMs: number
  ragDocsCount: number
  systemMessage: Message | null
}

type RuntimeSettingsPlan = {
  numCtx?: number
  keepAlive?: string
  maxTokens?: number
}

type PersonalizationPlan = {
  lastUserText: string
  userName: string | null
  activeUser: string | null
  profiles: Record<string, string[]>
  systemMessages: Message[]
}

type DirectAnswerPlan = {
  responseText?: string
  contextMessage: Message
  promptMessage: Message
} | null

type AutonomousTaskPlan =
  | { source: 'task_loop'; result: string }
  | { source: 'missing_capability'; result: string }
  | null

type AutonomousTaskDecision =
  | { action: 'run'; worker: string; request: string }
  | { action: 'done'; reason?: string }
  | { action: 'cannot'; reason: string }

type AutonomousTaskStep = {
  step: number
  worker: string
  request: string
  result: string
}

const ALLOWED_AUTONOMOUS_WORKERS = new Set([
  'read',
  'system',
  'terminal',
  'edit',
  'home_assistant',
])

type StreamChunk = {
  message?: {
    content?: string
    thinking?: string
    [key: string]: any
  }
  [key: string]: any
}

type StreamingReplyState = {
  fullContent: string
  firstChunkAt: number | null
  droppingReasoning: boolean
  dropBuffer: string
  dropFence: boolean
}

type ChatExecutionOptions = {
  model: string
  messages: Message[]
  think: boolean | 'medium'
  numCtx?: number
  keepAlive?: string
  maxTokens?: number
}

type ChatRequestInput = {
  model: string
  messages: Message[]
  sessionId?: number | null
  stream?: boolean
  think?: boolean
  [key: string]: any
}

type PreparedChatTurn = {
  messages: Message[]
  sessionId: number | null
  originalUserContent: string | null
  ollamaRequest: {
    model: string
    messages: Message[]
    [key: string]: any
  }
  lastUserText: string
  rewriteMs: number
  ragMs: number
  ragDocsCount: number
  think: boolean | 'medium'
  numCtx?: number
  keepAlive?: string
  maxTokens?: number
  directAnswer: DirectAnswerPlan
}

type ChatTurnResult =
  | {
      kind: 'stream'
    }
  | {
      kind: 'json'
      body: any
    }

@inject()
export class ChatOrchestratorService {
  constructor(
    private chatService: ChatService,
    private ollamaService: OllamaService,
    private directToolRegistryService: DirectToolRegistryService,
    private workerFlowRegistryService: WorkerFlowRegistryService,
    private homeAssistantWorkerService: HomeAssistantWorkerService,
    private terminalWorkerService: TerminalWorkerService,
    private editWorkerService: EditWorkerService,
    private readWorkerService: ReadWorkerService,
    private systemWorkerService: SystemWorkerService
  ) {}

  getContextLimitsForModel(modelName: string): { maxResults: number; maxTokens: number } {
    const sizeMatch = modelName.match(/(\d+\.?\d*)[bB]/)
    const paramBillions = sizeMatch ? parseFloat(sizeMatch[1]) : 8

    for (const tier of RAG_CONTEXT_LIMITS) {
      if (paramBillions <= tier.maxParams) {
        return { maxResults: tier.maxResults, maxTokens: tier.maxTokens }
      }
    }

    return { maxResults: 5, maxTokens: 0 }
  }

  async rewriteQueryWithContext(messages: Message[]): Promise<string | null> {
    try {
      const recentMessages = messages.slice(-6)
      const userMessages = recentMessages.filter((msg) => msg.role === 'user')
      if (userMessages.length <= 2) {
        return userMessages[userMessages.length - 1]?.content || null
      }

      const conversationContext = recentMessages
        .map((msg) => {
          const role = msg.role === 'user' ? 'User' : 'Assistant'
          const content =
            msg.role === 'assistant'
              ? msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : '')
              : msg.content
          return `${role}: "${content}"`
        })
        .join('\n')

      const installedModels = await this.ollamaService.getModels(true)
      const rewriteModelAvailable = installedModels?.some(
        (model) => model.name === DEFAULT_QUERY_REWRITE_MODEL
      )
      if (!rewriteModelAvailable) {
        logger.warn(
          `[RAG] Query rewrite model "${DEFAULT_QUERY_REWRITE_MODEL}" not available. Skipping query rewriting.`
        )
        const lastUserMessage = [...messages].reverse().find((msg) => msg.role === 'user')
        return lastUserMessage?.content || null
      }

      const response = await this.ollamaService.chat({
        model: DEFAULT_QUERY_REWRITE_MODEL,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPTS.query_rewrite,
          },
          {
            role: 'user',
            content: `Conversation:\n${conversationContext}\n\nRewritten Query:`,
          },
        ],
      })

      const rewrittenQuery = response.message.content.trim()
      logger.info(`[RAG] Query rewritten: "${rewrittenQuery}"`)
      return rewrittenQuery
    } catch (error) {
      logger.error(
        `[RAG] Query rewriting failed: ${error instanceof Error ? error.message : error}`
      )
      const lastUserMessage = [...messages].reverse().find((msg) => msg.role === 'user')
      return lastUserMessage?.content || null
    }
  }

  async prepareChatTurn(args: {
    requestData: ChatRequestInput
    ragService: RagService
  }): Promise<PreparedChatTurn> {
    const { requestData, ragService } = args
    const messages = requestData.messages.map((message) => ({ ...message }))
    const originalLastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
    const originalUserContent = originalLastUserMessage?.content || null

    const customName = await KVStore.getValue('ai.assistantCustomName')
    const assistantName = customName && customName.trim() ? customName : 'AI Assistant'
    const storedPromptRaw = await KVStore.getValue('ai.systemPrompt')
    const storedPrompt = typeof storedPromptRaw === 'string' ? storedPromptRaw.trim() : ''
    const baseSystemPrompt = storedPrompt || SYSTEM_PROMPTS.default.trim()

    const personalizationPlan = await this.preparePersonalization({
      messages,
      assistantName,
      baseSystemPrompt,
      ragService,
    })

    let lastUserText = personalizationPlan.lastUserText
    for (const systemMessage of personalizationPlan.systemMessages) {
      logger.debug('[ChatOrchestratorService] Injecting orchestrated system prompt')
      messages.unshift(systemMessage)
    }

    const directAnswer = await this.prepareDirectAnswer({
      lastUserText,
      model: requestData.model,
      messages,
      profiles: personalizationPlan.profiles,
      activeUser: personalizationPlan.activeUser,
      userName: personalizationPlan.userName,
      ragService,
    })

    const knowledgePlan = await this.prepareKnowledgeContext({
      messages,
      lastUserText,
      model: requestData.model,
      ragService,
      rewriteQuery: (rewriteMessages) => this.rewriteQueryWithContext(rewriteMessages),
      getContextLimitsForModel: (modelName) => this.getContextLimitsForModel(modelName),
      buildRagPrompt: (context) => SYSTEM_PROMPTS.rag_context(context),
    })

    lastUserText = knowledgePlan.lastUserText
    logger.debug(`[ChatOrchestratorService] Rewritten query for RAG: "${knowledgePlan.rewrittenQuery}"`)

    if (knowledgePlan.systemMessage) {
      const firstNonSystemIndex = messages.findIndex((msg) => msg.role !== 'system')
      const insertIndex = firstNonSystemIndex === -1 ? 0 : firstNonSystemIndex
      messages.splice(insertIndex, 0, knowledgePlan.systemMessage)
    }

    const { numCtx, keepAlive, maxTokens } = this.buildRuntimeSettings({
      messages,
      model: requestData.model,
      lastUserText,
      ragDocsCount: knowledgePlan.ragDocsCount,
    })

    const thinkingCapability = await this.ollamaService.checkModelHasThinking(requestData.model)
    let think: boolean | 'medium' = false
    if (requestData.think === true) {
      think = thinkingCapability
        ? requestData.model.startsWith('gpt-oss')
          ? 'medium'
          : true
        : false
    }

    const { sessionId, ...restRequest } = requestData

    return {
      messages,
      sessionId: sessionId ?? null,
      originalUserContent,
      ollamaRequest: {
        ...restRequest,
        messages,
      },
      lastUserText,
      rewriteMs: knowledgePlan.rewriteMs,
      ragMs: knowledgePlan.ragMs,
      ragDocsCount: knowledgePlan.ragDocsCount,
      think,
      numCtx,
      keepAlive,
      maxTokens,
      directAnswer,
    }
  }

  async runChatTurn(args: {
    requestData: ChatRequestInput
    ragService: RagService
    perfStart: number
    onStreamChunk?: (chunk: StreamChunk | { message: { content: string }; done: true }) => void | Promise<void>
  }): Promise<ChatTurnResult> {
    const { requestData, ragService, perfStart, onStreamChunk } = args
    const preparedTurn = await this.prepareChatTurn({
      requestData,
      ragService,
    })

    const {
      messages,
      sessionId,
      originalUserContent,
      ollamaRequest,
      lastUserText,
      rewriteMs,
      ragMs,
      ragDocsCount,
      think,
      numCtx,
      keepAlive,
      maxTokens,
      directAnswer,
    } = preparedTurn

    const useDirectResponse = !!directAnswer?.responseText
    if (directAnswer && !useDirectResponse) {
      const firstNonSystemIndex = messages.findIndex((msg) => msg.role !== 'system')
      const insertIndex = firstNonSystemIndex === -1 ? 0 : firstNonSystemIndex
      messages.splice(insertIndex, 0, directAnswer.contextMessage)
      messages.push(directAnswer.promptMessage)
      ollamaRequest.messages = messages
    }

    await this.logPromptIfEnabled({
      timestamp: new Date().toISOString(),
      model: requestData.model,
      sessionId,
      think,
      numCtx: numCtx ?? null,
      messages,
    })

    const userContent = await this.saveUserMessage(sessionId, originalUserContent)

    if (directAnswer?.responseText) {
      const assistantContent = directAnswer.responseText
      if (requestData.stream) {
        await onStreamChunk?.({
          message: { content: assistantContent },
        })
        await onStreamChunk?.({
          message: { content: '' },
          done: true,
        } as any)
        await this.saveAssistantReply({
          sessionId,
          userContent,
          assistantContent,
        })
        const perfPayload = {
          timestamp: new Date().toISOString(),
          model: requestData.model,
          sessionId,
          stream: true,
          think,
          numCtx: numCtx ?? null,
          messageLength: lastUserText.length,
          rewriteMs,
          ragMs,
          ragDocsCount,
          ttfbMs: 0,
          totalMs: Date.now() - perfStart,
          chatMs: 0,
        }
        console.log('[ChatPerf]', JSON.stringify(perfPayload))
        await this.logChatPerfIfEnabled(perfPayload)
        return { kind: 'stream' }
      }

      await this.saveAssistantReply({
        sessionId,
        userContent,
        assistantContent,
      })
      const perfPayload = {
        timestamp: new Date().toISOString(),
        model: requestData.model,
        sessionId,
        stream: false,
        think,
        numCtx: numCtx ?? null,
        messageLength: lastUserText.length,
        rewriteMs,
        ragMs,
        ragDocsCount,
        ttfbMs: null,
        totalMs: Date.now() - perfStart,
        chatMs: 0,
      }
      console.log('[ChatPerf]', JSON.stringify(perfPayload))
      await this.logChatPerfIfEnabled(perfPayload)
      return {
        kind: 'json',
        body: {
          model: requestData.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: assistantContent,
          },
          done: true,
          done_reason: 'stop',
        },
      }
    }

    if (requestData.stream) {
      logger.debug(
        `[ChatOrchestratorService] Initiating streaming response for model: "${requestData.model}" with think: ${think}`
      )
      const streamResult = await this.executeStreamingChat({
        ...ollamaRequest,
        think,
        numCtx,
        keepAlive,
        maxTokens,
        onChunk: async (chunk) => {
          await onStreamChunk?.(chunk)
        },
      })

      await this.saveAssistantReply({
        sessionId,
        userContent,
        assistantContent: streamResult.fullContent,
      })
      const perfPayload = {
        timestamp: new Date().toISOString(),
        model: requestData.model,
        sessionId,
        stream: true,
        think,
        numCtx: numCtx ?? null,
        messageLength: lastUserText.length,
        rewriteMs,
        ragMs,
        ragDocsCount,
        ttfbMs: streamResult.ttfbMs,
        totalMs: Date.now() - perfStart,
        chatMs: streamResult.chatMs,
      }
      console.log('[ChatPerf]', JSON.stringify(perfPayload))
      await this.logChatPerfIfEnabled(perfPayload)
      return { kind: 'stream' }
    }

    const { result, chatMs } = await this.executeChat({
      ...ollamaRequest,
      think,
      numCtx,
      keepAlive,
      maxTokens,
    })

    await this.saveAssistantReply({
      sessionId,
      userContent,
      assistantContent: result?.message?.content || '',
    })

    const perfPayload = {
      timestamp: new Date().toISOString(),
      model: requestData.model,
      sessionId,
      stream: false,
      think,
      numCtx: numCtx ?? null,
      messageLength: lastUserText.length,
      rewriteMs,
      ragMs,
      ragDocsCount,
      ttfbMs: null,
      totalMs: Date.now() - perfStart,
      chatMs,
    }
    console.log('[ChatPerf]', JSON.stringify(perfPayload))
    await this.logChatPerfIfEnabled(perfPayload)
    return { kind: 'json', body: result }
  }

  async preparePersonalization(args: {
    messages: Message[]
    assistantName: string
    baseSystemPrompt: string
    ragService: RagService
  }): Promise<PersonalizationPlan> {
    const { messages, assistantName, baseSystemPrompt, ragService } = args
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
    const lastUserText = lastUserMessage?.content?.trim() || ''
    const storedActiveUserRaw = await KVStore.getValue('ai.activeUserName')
    const storedUserNameRaw = await KVStore.getValue('ai.userName')
    const storedActiveUser = sanitizeStoredIdentityName(storedActiveUserRaw)
    const storedUserName = sanitizeStoredIdentityName(storedUserNameRaw)

    if (storedActiveUserRaw && !storedActiveUser) {
      await KVStore.clearValue('ai.activeUserName')
    }
    if (storedUserNameRaw && !storedUserName) {
      await KVStore.clearValue('ai.userName')
    }

    const detectedName = parseUserName(lastUserText)
    if (detectedName) {
      const normalizedName = normalizeUserName(detectedName)
      await KVStore.setValue('ai.userName', normalizedName)
      await KVStore.setValue('ai.activeUserName', normalizedName)

      const profiles = await loadUserProfiles()
      const existing = Array.isArray(profiles[normalizedName]) ? profiles[normalizedName] : []
      if (!existing.some((fact) => fact.toLowerCase() === `name: ${normalizedName}`.toLowerCase())) {
        profiles[normalizedName] = [...existing, `Name: ${normalizedName}`].slice(-50)
        await saveUserProfiles(profiles)
        await writeProfileToKb(normalizedName, profiles[normalizedName])
      }
    } else if (!storedActiveUser && storedUserName) {
      await KVStore.setValue('ai.activeUserName', storedUserName)
    }

    const activeUser =
      detectedName ? normalizeUserName(detectedName) : storedActiveUser || storedUserName

    if (activeUser) {
      await captureRelationshipFact(lastUserText, activeUser, ragService)
      await forgetMemoryFacts(lastUserText, activeUser, ragService)
      await capturePersonalFacts(lastUserText, activeUser, ragService)
      await captureRelatedPersonFacts(lastUserText, activeUser, ragService)
    }

    if (shouldRememberFact(lastUserText)) {
      const fact = normalizeFact(lastUserText)
      if (activeUser && fact.length > 0) {
        const profiles = await loadUserProfiles()
        const list: string[] = Array.isArray(profiles[activeUser]) ? profiles[activeUser] : []
        const deduped = list.filter((item) => item.toLowerCase() !== fact.toLowerCase())
        deduped.push(fact)
        profiles[activeUser] = deduped.slice(-50)
        await saveUserProfiles(profiles)
        await writeProfileToKb(activeUser, profiles[activeUser])
        await scheduleProfilesSync(ragService)
      }
    }

    const storedPromptRaw = await KVStore.getValue('ai.systemPrompt')
    const storedPrompt = typeof storedPromptRaw === 'string' ? storedPromptRaw.trim() : ''
    if (!storedPrompt) {
      await KVStore.setValue('ai.systemPrompt', baseSystemPrompt)
    }

    const userName = detectedName ? normalizeUserName(detectedName) : storedUserName
    const profiles = await loadUserProfiles()
    const knownUsers = Object.keys(profiles)
    const activeUserFacts = activeUser ? profiles[activeUser] || [] : []
    const tz = env.get('NOMAD_TIMEZONE')
    const nowText = formatLocalDateTime(tz)

    const systemMessages: Message[] = []
    const hasSystemMessage = messages.some((msg) => msg.role === 'system')
    if (!hasSystemMessage) {
      const runtimeContext: string[] = [`Current date/time: ${nowText}${tz ? ` (${tz})` : ''}`]
      if (assistantName) {
        runtimeContext.push(`Your name is ${assistantName}.`)
      }
      if (activeUser) {
        runtimeContext.push(`You are currently talking to ${activeUser}.`)
      } else if (userName) {
        runtimeContext.push(`The user's name is ${userName}.`)
      }

      systemMessages.push({
        role: 'system',
        content: `${baseSystemPrompt}\n${runtimeContext.join('\n')}`,
      })
    }

    if (activeUserFacts.length > 0 || knownUsers.length > 0) {
      const memoryLines: string[] = []
      if (activeUser) {
        memoryLines.push(`Active user: ${activeUser}`)
      }
      if (activeUserFacts.length > 0) {
        memoryLines.push(`Facts about ${activeUser}:\n- ${activeUserFacts.slice(-12).join('\n- ')}`)
      }
      if (knownUsers.length > 0) {
        memoryLines.push(`Known family members: ${knownUsers.join(', ')}`)
      }
      systemMessages.push({
        role: 'system',
        content: `User memory (facts, always true):\n${memoryLines.join('\n')}`,
      })
    }

    return {
      lastUserText,
      userName,
      activeUser,
      profiles,
      systemMessages,
    }
  }

  async prepareDirectAnswer(args: {
    lastUserText: string
    model: string
    messages: Message[]
    profiles: Record<string, string[]>
    activeUser: string | null
    userName: string | null
    ragService: RagService
  }): Promise<DirectAnswerPlan> {
    const { lastUserText, model, messages, profiles, activeUser, userName, ragService } = args
    const groundedText = resolveGroundedFollowUpText(lastUserText, messages)

    if (isCapabilityQuestion(groundedText)) {
      return this.createGroundedContextMessage(
        'capabilities',
        groundedText,
        await this.describeRuntimeCapabilities()
      )
    }

    const directToolAnswer = await this.directToolRegistryService.tryHandle(groundedText)
    if (directToolAnswer) {
      return this.createGroundedContextMessage('direct_tool', groundedText, directToolAnswer.result)
    }

    const workerFlowAnswer = await this.workerFlowRegistryService.tryHandle(groundedText)
    if (workerFlowAnswer) {
      return this.createGroundedContextMessage('worker_flow', groundedText, workerFlowAnswer.result)
    }

    const autonomousTask = await this.tryAutonomousTaskLoop({
      requestText: groundedText,
      model,
    })
    if (autonomousTask) {
      return this.createGroundedContextMessage(autonomousTask.source, groundedText, autonomousTask.result)
    }

    try {
      const homeAssistantAnswer = await this.homeAssistantWorkerService.tryHandle(groundedText)
      if (homeAssistantAnswer) {
        return this.createGroundedContextMessage('home_assistant', groundedText, homeAssistantAnswer)
      }

      const systemWorkerAnswer = await this.systemWorkerService.tryHandle(groundedText)
      if (systemWorkerAnswer) {
        return this.createGroundedContextMessage('system', groundedText, systemWorkerAnswer)
      }

      const terminalWorkerAnswer = await this.terminalWorkerService.tryHandle(groundedText)
      if (terminalWorkerAnswer) {
        return this.createGroundedContextMessage('terminal', groundedText, terminalWorkerAnswer)
      }

      const editWorkerAnswer = await this.editWorkerService.tryHandle(groundedText)
      if (editWorkerAnswer) {
        return this.createGroundedContextMessage('edit', groundedText, editWorkerAnswer)
      }

      const readWorkerAnswer = await this.readWorkerService.tryHandle(groundedText)
      if (readWorkerAnswer) {
        return this.createGroundedContextMessage('read', groundedText, readWorkerAnswer)
      }
    } catch (error) {
      logger.warn(
        `[ChatOrchestratorService] Read worker failed: ${error instanceof Error ? error.message : error}`
      )
      return this.createGroundedContextMessage(
        'error',
        groundedText,
        error instanceof Error ? error.message : 'A tool execution error occurred.'
      )
    }

    const memoryAnswer = buildMemoryContext(lastUserText, profiles, activeUser || userName || null)
    if (memoryAnswer) {
      return this.createGroundedContextMessage('memory', groundedText, memoryAnswer)
    }

    const libraryAnswer = await buildLibraryInventoryContext(lastUserText, ragService)
    if (libraryAnswer) {
      return this.createGroundedContextMessage('library', groundedText, libraryAnswer)
    }

    return null
  }

  createGroundedContextMessage(source: string, requestText: string, result: string): DirectAnswerPlan {
    const directResponseText =
      source === 'capabilities' ||
      source === 'read' ||
      source === 'terminal' ||
      source === 'direct_tool' ||
      source === 'worker_flow' ||
      source === 'missing_capability' ||
      source === 'error'
        ? result
        : undefined
    const sourceInstruction =
      source === 'capabilities'
        ? 'Summarize every major capability family present in the grounded result. Do not omit categories.'
        : source === 'missing_capability'
        ? 'State plainly that the task cannot be completed now, then list the specific missing tool or access needed from the grounded result.'
        : source === 'task_loop'
          ? 'Summarize the verified worker steps and final outcome plainly. Do not claim anything beyond the grounded result.'
        : source === 'direct_tool'
          ? 'Answer naturally, but keep the direct tool result concrete and complete. Do not invent extra steps.'
        : source === 'worker_flow'
          ? 'Answer naturally, but preserve the multi-step grounded findings and verification results.'
        : source === 'terminal'
          ? 'Include the verified command, exit code, and any stdout or stderr present in the grounded result. Do not omit the command result.'
        : source === 'read'
          ? 'Answer naturally, but stay faithful to the grounded result. If the grounded result contains file contents, directory listings, container details, or log lines, keep those concrete details in the reply. Do not invent or omit important paths, names, statuses, or lines.'
        : source === 'system'
          ? 'Answer naturally in plain language, but keep every concrete value from the grounded result.'
        : source === 'home_assistant'
          ? 'Answer naturally in plain language, but keep every grounded entity, action, and state exactly consistent with the grounded result.'
        : source === 'edit'
          ? 'Answer naturally and briefly describe exactly what changed, using only the grounded result.'
        : 'Answer the request from the grounded result only.'

    return {
      responseText: directResponseText,
      contextMessage: {
        role: 'system',
        content:
          `The latest user request has already been grounded by the runtime ${source} layer.\n\n` +
          `Grounded result:\n${result}\n\n` +
          `Write the reply using only this grounded result. ` +
          `Do not add names, files, actions, relationships, or conclusions that are not present in it. ` +
          `If the grounded result is minimal, answer minimally. ` +
          `If the grounded result says nothing was found, say that plainly. ` +
          `${sourceInstruction}`,
      },
      promptMessage: {
        role: 'user',
        content:
          `Original request: ${requestText}\n` +
          `Grounded result: ${result}\n` +
          `Answer the original request using only the grounded result. ${sourceInstruction}`,
      },
    }
  }

  async describeRuntimeCapabilities(): Promise<string> {
    const homeAssistant = await this.homeAssistantWorkerService.describeCapabilities()
    const hasHa = /Home Assistant worker capabilities:/i.test(homeAssistant)

    return [
      'Live capability summary:',
      '- Chat and memory responses',
      '- Offline RAG/library lookups when relevant context is available',
      '- Home Assistant control and status tools',
      '- Direct deterministic tools',
      '- Worker-flow tools for bounded multi-step jobs',
      'Current limits:',
      '- No direct host home-directory or Desktop access is available',
      '- No arbitrary host filesystem write access is available',
      '- Replies must stay grounded in worker results and stored memory',
      '',
      this.directToolRegistryService.describeTools(),
      '',
      this.workerFlowRegistryService.describeTools(),
      ...(hasHa ? ['', homeAssistant] : []),
      '',
      this.systemWorkerService.describeCapabilities(),
      '',
      this.terminalWorkerService.describeCapabilities(),
      '',
      this.readWorkerService.describeCapabilities(),
      '',
      this.editWorkerService.describeCapabilities(),
    ].join('\n')
  }

  async tryAutonomousTaskLoop(_args: {
    requestText: string
    model: string
  }): Promise<AutonomousTaskPlan> {
    return null
  }

  async planAutonomousTaskStep(args: {
    requestText: string
    model: string
    steps: AutonomousTaskStep[]
    allowedWorkers: string[]
    blockedRequests: string[]
  }): Promise<AutonomousTaskDecision | null> {
    const { requestText, model, steps, allowedWorkers, blockedRequests } = args
    const stepHistory =
      steps.length > 0
        ? steps
            .map((entry) =>
              [
                `Step ${entry.step}`,
                `Worker: ${entry.worker}`,
                `Request: ${entry.request}`,
                `Result:\n${truncateAutonomousResult(entry.result)}`,
              ].join('\n')
            )
            .join('\n\n')
        : 'No grounded steps have been run yet.'

    const baseMessages: Message[] = [
      {
        role: 'system',
        content: [
          'You are the bounded task planner for Quinn.',
          'Decide exactly one next grounded action at a time.',
          'Return JSON only. No markdown. No prose outside the JSON object.',
          'Allowed JSON shapes:',
          ...allowedWorkers.map((worker) => `{"action":"run","worker":"${worker}","request":"..."}`),
          '{"action":"done","reason":"..."}',
          '{"action":"cannot","reason":"..."}',
          'Rules:',
          '- Prefer inspection before modification.',
          '- Never say done unless the prior grounded worker results verify the outcome.',
          '- If the task cannot be completed with the current workers, return action=cannot and name the missing capability.',
          '- The worker field must be exactly one worker name, never a list or placeholder.',
          `- For this task, the only allowed workers are: ${allowedWorkers.join(', ')}.`,
          '- Use request strings that the workers can already parse.',
          '- For host terminal work, requests must start with "use ubuntu terminal to ...".',
          '- The text after "use ubuntu terminal to" is executed directly as bash. It must be literal shell, not prose.',
          '- Do not write requests like "navigate to" or "create a new directory". Write real shell such as "cd ~/Desktop && ls -la".',
          '- For read work, use direct requests like "inspect container homeassistant" or "read file /app/...".',
          '- Keep host-terminal work inside approved /home/nomad user-space paths.',
          '- For a desktop shortcut, inspect existing .desktop launchers and the Home Assistant container first, then write and verify the new launcher on ~/Desktop.',
          '- Do not say done after only listing the Desktop or inspecting the container.',
          '- For a desktop shortcut, completion requires all of these grounded outcomes:',
          '  1. inspect grounded info needed for the launcher',
          '  2. write a .desktop file on ~/Desktop',
          '  3. verify that specific .desktop file exists',
          '- If a prior command failed, use the failure output to choose a better next command instead of repeating the same inspection.',
          '- Do not repeat an identical worker request that already succeeded unless the prior result explicitly says it found nothing or failed.',
          ...(blockedRequests.length > 0
            ? [
                '- These exact worker requests were already used and must not be returned again in this task:',
                ...blockedRequests.map((entry) => `  - ${entry}`),
              ]
            : []),
          '- Do not use sudo, apt, snap, systemctl, service, chown, or destructive commands.',
          '- A .desktop launcher is a Desktop Entry text file that typically contains [Desktop Entry], Type=Application, Name, Exec, and Terminal=false.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Goal:\n${requestText}`,
          '',
          'Available grounded workers:',
          ...allowedWorkers.map((worker) => `- ${worker}`),
          '',
          `Grounded steps so far:\n${stepHistory}`,
          '',
          `Planner hints:\n${buildAutonomousPlannerHints(requestText, steps, allowedWorkers, blockedRequests)}`,
          '',
          'Return the single best next action as JSON only.',
        ].join('\n'),
      },
    ]

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptMessages: Message[] =
        attempt === 1
          ? baseMessages
          : [
              ...baseMessages,
              {
                role: 'assistant',
                content: 'Your last reply was invalid because it was not a single JSON object.',
              },
              {
                role: 'user',
                content:
                  'Return exactly one valid JSON object now. No explanation. No bullet list. No markdown fences.',
              },
            ]

      const plannerResponse = await this.ollamaService.chat({
        model,
        messages: attemptMessages,
      })

      console.log('[AutonomousPlanner]', plannerResponse.message.content)
      const parsed = parseAutonomousTaskDecision(plannerResponse.message.content)
      if (parsed) {
        return parsed
      }
    }

    return null
  }

  async runAutonomousWorkerStep(worker: string, request: string): Promise<string | null> {
    switch (worker) {
      case 'home_assistant':
        return await this.homeAssistantWorkerService.tryHandle(request)
      case 'system':
        return await this.systemWorkerService.tryHandle(request)
      case 'terminal':
        return await this.terminalWorkerService.tryHandle(request)
      case 'edit':
        return await this.editWorkerService.tryHandle(request)
      case 'read':
        return await this.readWorkerService.tryHandle(request)
      default:
        return null
    }
  }

  getAutonomousFallbackDecision(args: {
    requestText: string
    steps: AutonomousTaskStep[]
    allowedWorkers: string[]
  }): AutonomousTaskDecision | null {
    const { requestText, steps, allowedWorkers } = args
    if (!isDesktopShortcutRequest(requestText)) return null

    const hasWorker = (worker: string) => allowedWorkers.includes(worker)
    const hasContainerInspect = steps.some(
      (step) => step.worker === 'read' && /inspect container homeassistant/i.test(step.request)
    )
    const hasLauncherLocationInspect = steps.some(
      (step) =>
        step.worker === 'host_terminal' &&
        /(?:Desktop|\.local\/share\/applications)/i.test(step.request)
    )
    const hasTemplateInspect = steps.some(
      (step) =>
        step.worker === 'host_terminal' &&
        /(?:sed -n|cat |head ).*\.desktop/i.test(step.request)
    )
    const hasWriteAttempt = steps.some(
      (step) => step.worker === 'host_terminal' && isDesktopShortcutWriteRequest(step.request)
    )
    const hasVerificationAttempt = steps.some(
      (step) =>
        step.worker === 'host_terminal' &&
        /Desktop\/home-assistant\.desktop/i.test(step.request) &&
        /(?:ls\b|stat\b|test\s+-f|sed -n\b|cat\b)/i.test(step.request)
    )

    if (!hasContainerInspect && hasWorker('read')) {
      return {
        action: 'run',
        worker: 'read',
        request: 'inspect container homeassistant',
      }
    }

    if (hasContainerInspect && !hasLauncherLocationInspect && hasWorker('host_terminal')) {
      return {
        action: 'run',
        worker: 'host_terminal',
        request:
          'use ubuntu terminal to cd ~/ && ls -la Desktop ~/.local/share/applications',
      }
    }

    if (hasLauncherLocationInspect && !hasTemplateInspect && hasWorker('host_terminal')) {
      return {
        action: 'run',
        worker: 'host_terminal',
        request:
          'use ubuntu terminal to cd ~/ && for f in Desktop/*.desktop .local/share/applications/*.desktop; do [ -f "$f" ] && { echo "FILE:$f"; sed -n \'1,20p\' "$f"; break; }; done',
      }
    }

    if (hasTemplateInspect && !hasWriteAttempt && hasWorker('host_terminal')) {
      return {
        action: 'run',
        worker: 'host_terminal',
        request:
          'use ubuntu terminal to cd ~/ && cat > Desktop/home-assistant.desktop <<\'EOF\'\n[Desktop Entry]\nVersion=1.0\nType=Application\nName=Home Assistant\nComment=Open Home Assistant\nExec=xdg-open http://127.0.0.1:8123\nIcon=applications-internet\nTerminal=false\nCategories=Network;Utility;\nStartupNotify=true\nEOF\nchmod +x Desktop/home-assistant.desktop',
      }
    }

    if (hasWriteAttempt && !hasVerificationAttempt && hasWorker('host_terminal')) {
      return {
        action: 'run',
        worker: 'host_terminal',
        request:
          'use ubuntu terminal to cd ~/ && ls -l Desktop/home-assistant.desktop && sed -n \'1,20p\' Desktop/home-assistant.desktop',
      }
    }

    return null
  }

  async prepareKnowledgeContext(args: {
    messages: Message[]
    lastUserText: string
    model: string
    ragService: RagService
    rewriteQuery: (messages: Message[]) => Promise<string | null>
    getContextLimitsForModel: (modelName: string) => { maxResults: number; maxTokens: number }
    buildRagPrompt: (context: string) => string
  }): Promise<KnowledgeContextPlan> {
    const {
      messages,
      model,
      ragService,
      rewriteQuery,
      getContextLimitsForModel,
      buildRagPrompt,
    } = args

    let lastUserText = args.lastUserText
    const looksLikeSmallTalk =
      /^(hi|hello|hey|yo|sup|what'?s up|how are you|how's it going|test|ping)[.!?]*$/i.test(
        lastUserText
      )
    const ragMinChars = env.get('NOMAD_RAG_MIN_CHARS') ?? 60
    const ragMinScore = env.get('NOMAD_RAG_MIN_SCORE') ?? 0.55
    const disableRewrite = env.get('NOMAD_DISABLE_QUERY_REWRITE') === true
    const disableRag = env.get('NOMAD_DISABLE_RAG') === true
    const forceRag = lastUserText.toLowerCase().startsWith('rag:')
    const looksLikeKbQuery =
      /(pdf|document|documents|file|files|uploaded|upload|knowledge base|kb|manual|guide|notes?)/i.test(
        lastUserText
      )

    if (forceRag) {
      lastUserText = lastUserText.slice(4).trim()
    }

    let matchedSources: string[] = []
    let matchedSourceDocs: RetrievalDoc[] = []
    const wantsDocumentSummary =
      /\b(summarize|summary|summarise|overview|what(?:'s| is) in|tell me about)\b/i.test(
        lastUserText
      )

    if (!disableRag && (forceRag || looksLikeKbQuery)) {
      matchedSources = await ragService.findUploadedFilesByQuery(lastUserText, 2)
      if (matchedSources.length === 0) {
        matchedSources = await ragService.findStoredFilesByQuery(lastUserText, 2)
      }
      if (matchedSources.length > 0) {
        const matchedDocLimit = wantsDocumentSummary ? 8 : 4
        for (const source of matchedSources) {
          const docs = await ragService.getDocumentsBySource(source, matchedDocLimit)
          matchedSourceDocs.push(...docs)
        }
      }
    }

    const rewriteStart = Date.now()
    const rewrittenQuery =
      looksLikeSmallTalk || disableRewrite ? (lastUserText || null) : await rewriteQuery(messages)
    const rewriteMs = Date.now() - rewriteStart

    let ragMs = 0
    let ragDocsCount = 0
    let systemMessage: Message | null = null

    if (
      !disableRag &&
      rewrittenQuery &&
      (forceRag || looksLikeKbQuery || rewrittenQuery.trim().length >= ragMinChars)
    ) {
      const ragStart = Date.now()
      const relevantDocs =
        matchedSourceDocs.length > 0
          ? matchedSourceDocs
          : await ragService.searchSimilarDocuments(
              rewrittenQuery,
              5,
              0.3
            )
      ragMs = Date.now() - ragStart

      const topScore = matchedSourceDocs.length > 0 ? 1 : (relevantDocs[0]?.score ?? 0)
      if (relevantDocs.length > 0 && (forceRag || matchedSourceDocs.length > 0 || topScore >= ragMinScore)) {
        ragDocsCount = relevantDocs.length
        const { maxResults, maxTokens } = getContextLimitsForModel(model)
        let trimmedDocs = relevantDocs.slice(0, maxResults)

        if (maxTokens > 0) {
          const charCap = maxTokens * 3.5
          let totalChars = 0
          trimmedDocs = trimmedDocs.filter((doc, idx) => {
            totalChars += doc.text.length
            return idx === 0 || totalChars <= charCap
          })
        }

        const matchedFilesHeader =
          matchedSources.length > 0
            ? `Matched file(s):\n${matchedSources.map((source) => `- ${path.basename(source)}`).join('\n')}\n\n`
            : ''

        const contextText =
          matchedFilesHeader +
          trimmedDocs
            .map(
              (doc, idx) =>
                `[Context ${idx + 1}] (Relevance: ${(doc.score * 100).toFixed(1)}%)\n${doc.text}`
            )
            .join('\n\n')

        systemMessage = {
          role: 'system',
          content: buildRagPrompt(contextText),
        }
      }
    }

    return {
      lastUserText,
      rewrittenQuery,
      rewriteMs,
      ragMs,
      ragDocsCount,
      systemMessage,
    }
  }

  buildRuntimeSettings(args: {
    messages: Message[]
    model: string
    lastUserText: string
    ragDocsCount: number
  }): RuntimeSettingsPlan {
    const { messages, model } = args
    const systemChars = messages
      .filter((m) => m.role === 'system')
      .reduce((sum, m) => sum + m.content.length, 0)
    const estimatedSystemTokens = Math.ceil(systemChars / 3.5)

    let numCtx: number | undefined
    if (estimatedSystemTokens > 3000) {
      const needed = estimatedSystemTokens + 2048
      numCtx = [8192, 16384, 32768, 65536].find((n) => n >= needed) ?? 65536
    }

    const keepAliveDefault = env.get('NOMAD_OLLAMA_KEEP_ALIVE')
    const keepAliveModelsRaw = env.get('NOMAD_OLLAMA_KEEP_ALIVE_MODELS')
    const keepAliveModels = (keepAliveModelsRaw || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    const keepAlive =
      keepAliveModels.length > 0
        ? keepAliveModels.includes(model)
          ? keepAliveDefault
          : undefined
        : keepAliveDefault

    const maxTokens = undefined

    return { numCtx, keepAlive, maxTokens }
  }

  async saveUserMessage(sessionId: number | null, content: string | null): Promise<string | null> {
    if (!sessionId || !content) return null
    await this.chatService.addMessage(sessionId, 'user', content)
    return content
  }

  sanitizeAssistantContent(text: string): string {
    return stripReasoningBlocksAll(text)
  }

  async saveAssistantReply(args: {
    sessionId: number | null
    userContent: string | null
    assistantContent: string
  }) {
    const { sessionId, userContent, assistantContent } = args
    if (!sessionId || !assistantContent) return
    await this.chatService.addMessage(sessionId, 'assistant', assistantContent)
    const messageCount = await this.chatService.getMessageCount(sessionId)
    if (messageCount <= 2 && userContent) {
      this.chatService.generateTitle(sessionId, userContent, assistantContent).catch((err) => {
        console.error(
          `[ChatOrchestratorService] Title generation failed: ${err instanceof Error ? err.message : err}`
        )
      })
    }
  }

  createStreamingReplyState(): StreamingReplyState {
    return {
      fullContent: '',
      firstChunkAt: null,
      droppingReasoning: false,
      dropBuffer: '',
      dropFence: false,
    }
  }

  processStreamingChunk(
    state: StreamingReplyState,
    chunk: StreamChunk
  ): { state: StreamingReplyState; outgoingChunk: StreamChunk } {
    let chunkContent = chunk.message?.content ?? ''

    if (chunkContent) {
      if (!state.droppingReasoning) {
        const trimmed = chunkContent.trimStart()
        if (
          trimmed.startsWith('```') &&
          (trimmed.toLowerCase().includes('reason') || trimmed.toLowerCase().includes('thinking'))
        ) {
          state.droppingReasoning = true
          state.dropFence = true
          state.dropBuffer += chunkContent
          chunkContent = ''
        } else if (/^(reasoning|thinking process)\s*[:\-]*\s*/i.test(trimmed)) {
          state.droppingReasoning = true
          state.dropFence = false
          state.dropBuffer += chunkContent
          chunkContent = ''
        }
      } else {
        state.dropBuffer += chunkContent
        chunkContent = ''
      }

      if (state.droppingReasoning) {
        if (state.dropFence) {
          const fenceEnd = state.dropBuffer.indexOf('```', 3)
          if (fenceEnd !== -1) {
            const remaining = state.dropBuffer.slice(fenceEnd + 3)
            state.dropBuffer = ''
            state.droppingReasoning = false
            state.dropFence = false
            chunkContent = remaining
          }
        } else {
          const blankIdx = state.dropBuffer.search(/\n\s*\n/)
          if (blankIdx !== -1) {
            const remaining = state.dropBuffer.slice(blankIdx)
            state.dropBuffer = ''
            state.droppingReasoning = false
            chunkContent = remaining
          }
        }
      }
    }

    if (chunkContent) {
      chunkContent = this.sanitizeAssistantContent(chunkContent)
      if (chunkContent) {
        state.fullContent += chunkContent
      }
    }

    if (state.firstChunkAt === null && (chunk.message?.content || chunk.message?.thinking)) {
      state.firstChunkAt = Date.now()
    }

    const outgoingChunk =
      chunkContent !== chunk.message?.content
        ? {
            ...chunk,
            message: {
              ...chunk.message,
              content: chunkContent,
            },
          }
        : chunk

    return { state, outgoingChunk }
  }

  async executeStreamingChat(
    args: ChatExecutionOptions & { onChunk: (chunk: StreamChunk) => void | Promise<void> }
  ): Promise<{ fullContent: string; ttfbMs: number | null; chatMs: number }> {
    const { onChunk, ...request } = args
    const chatStart = Date.now()
    const stream = await this.ollamaService.chatStream(request)
    const streamingState = this.createStreamingReplyState()

    for await (const chunk of stream) {
      const { outgoingChunk } = this.processStreamingChunk(streamingState, chunk)
      await onChunk(outgoingChunk)
    }

    return {
      fullContent: streamingState.fullContent,
      ttfbMs: streamingState.firstChunkAt ? streamingState.firstChunkAt - chatStart : null,
      chatMs: Date.now() - chatStart,
    }
  }

  async executeChat(
    args: ChatExecutionOptions
  ): Promise<{ result: any; chatMs: number }> {
    const chatStart = Date.now()
    const result = await this.ollamaService.chat(args)
    if (result?.message?.content) {
      result.message.content = this.sanitizeAssistantContent(result.message.content)
    }
    return {
      result,
      chatMs: Date.now() - chatStart,
    }
  }

  async logPromptIfEnabled(payload: {
    timestamp: string
    model: string
    sessionId: number | null
    think: boolean | 'medium'
    numCtx: number | null
    messages: Message[]
  }) {
    if (!process.env.NOMAD_PROMPT_LOG) return
    try {
      const logPath = path.join(process.cwd(), 'storage', 'logs', 'prompt.log')
      await mkdir(path.dirname(logPath), { recursive: true })
      await appendFile(logPath, JSON.stringify(payload) + '\n', 'utf-8')
    } catch (err: any) {
      logger.error(`[ChatOrchestratorService] Failed to write prompt log: ${err?.message || err}`)
    }
  }

  async logChatPerfIfEnabled(payload: {
    timestamp: string
    model: string
    sessionId: number | null
    stream: boolean
    think: boolean | 'medium'
    numCtx: number | null
    messageLength: number
    rewriteMs: number
    ragMs: number
    ragDocsCount: number
    ttfbMs: number | null
    totalMs: number
    chatMs?: number
  }) {
    if (!process.env.NOMAD_CHAT_PERF_LOG) return
    try {
      logger.info(`[ChatPerf] ${JSON.stringify(payload)}`)
    } catch (err: any) {
      logger.error(
        `[ChatOrchestratorService] Failed to write chat perf log: ${err?.message || err}`
      )
    }
  }
}

function stripReasoningBlock(text: string): string {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('```')) {
    const fenceEnd = trimmed.indexOf('```', 3)
    const header = trimmed.slice(3, Math.min(trimmed.length, 80)).toLowerCase()
    if (header.includes('reason') || header.includes('thinking')) {
      if (fenceEnd !== -1) {
        return trimmed.slice(fenceEnd + 3).trimStart()
      }
    }
  }
  const headerMatch = trimmed.match(/^(reasoning|thinking process)\s*[:\-]*\s*/i)
  if (headerMatch) {
    const rest = trimmed.slice(headerMatch[0].length)
    const blankIdx = rest.search(/\n\s*\n/)
    if (blankIdx !== -1) {
      return rest.slice(blankIdx).trimStart()
    }
    return rest.trimStart()
  }
  return text
}

function stripReasoningBlocksAll(text: string): string {
  let out = text
  for (let i = 0; i < 5; i++) {
    const next = stripReasoningBlock(out)
    if (next === out) break
    out = next
  }
  return out
}

function formatLocalDateTime(timezone?: string): string {
  const now = new Date()
  try {
    if (timezone) {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      }).format(now)
    }
  } catch {
  }
  return now.toLocaleString()
}

function parseUserName(text: string): string | null {
  const cleaned = text.trim().replace(/\s+/g, ' ')
  if (!cleaned || cleaned.length > 80) return null

  const patterns = [
    /^(?:hi|hello|hey)[,! ]+(?:my name is|call me|this is|i am|i'm)\s+([a-zA-Z][a-zA-Z'.-]{0,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{0,30})?)\s*[.!?]*$/i,
    /^(?:my name is|call me|this is)\s+([a-zA-Z][a-zA-Z'.-]{0,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{0,30})?)\s*[.!?]*$/i,
    /^(?:i am|i'm)\s+([a-zA-Z][a-zA-Z'.-]{0,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{0,30})?)\s*[.!?]*$/i,
  ]

  for (const pattern of patterns) {
    const match = cleaned.match(pattern)
    const name = match?.[1]?.trim()
    if (name && !isLikelyNonName(name)) {
      return name
    }
  }

  return null
}

function shouldRememberFact(text: string): boolean {
  const trimmed = text.trim()
  if (/^(remember|note|keep this in mind|for my profile|profile)\s*[:\-]/i.test(trimmed)) return true
  if (/^remember that\s+/i.test(trimmed)) return true
  return false
}

function normalizeFact(text: string): string {
  return text
    .replace(/^(remember|note|keep this in mind|for my profile|profile)\s*[:\-]\s*/i, '')
    .replace(/^remember that\s+/i, '')
    .trim()
}

function normalizeUserName(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function sanitizeStoredIdentityName(name: string | null | undefined): string | null {
  if (!name || typeof name !== 'string') return null
  const cleaned = name.trim()
  if (!cleaned) return null
  const normalized = normalizeUserName(cleaned)
  return isLikelyNonName(normalized) ? null : normalized
}

function isLikelyNonName(name: string): boolean {
  const cleaned = name.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!cleaned) return true

  const exactBlacklist = new Set([
    'fine', 'good', 'okay', 'ok', 'great', 'here', 'there', 'me', 'you', 'done', 'finished',
    'ready', 'busy', 'hungry', 'tired', 'sleepy', 'reason', 'moment', 'wife', 'husband',
    'partner', 'spouse', 'mother', 'father', 'mom', 'dad', 'son', 'daughter', 'child',
    'children', 'kid', 'kids', 'brother', 'sister', 'family',
  ])
  if (exactBlacklist.has(cleaned)) return true

  const invalidTokens = new Set(['you', 'your', 'yours', 'me', 'myself'])
  return cleaned.split(' ').some((token) => invalidTokens.has(token))
}

async function loadUserProfiles(): Promise<Record<string, string[]>> {
  try {
    const profilesRaw = await KVStore.getValue('ai.userProfiles')
    const parsed = profilesRaw ? JSON.parse(String(profilesRaw)) : {}
    const profiles = typeof parsed === 'object' && parsed ? parsed : {}
    const { normalized, changed } = normalizeProfiles(profiles)
    if (changed) {
      await KVStore.setValue('ai.userProfiles', JSON.stringify(normalized))
    }
    return normalized
  } catch {
    return {}
  }
}

async function saveUserProfiles(profiles: Record<string, string[]>) {
  await KVStore.setValue('ai.userProfiles', JSON.stringify(profiles))
}

async function writeProfileToKb(userName: string, facts: string[]) {
  const safeName = userName.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const kbDir = path.join(process.cwd(), 'storage', 'kb_uploads', 'family-profiles')
  await mkdir(kbDir, { recursive: true })
  const profileText = `Name: ${userName}\nFacts:\n- ${facts.map((fact) => canonicalizeProfileFact(fact)).join('\n- ')}\n`
  await writeFile(path.join(kbDir, `${safeName}.txt`), profileText, 'utf-8')
}

async function scheduleProfilesSync(ragService: RagService) {
  const lastSyncRaw = await KVStore.getValue('ai.userProfilesLastSync')
  const lastSync = lastSyncRaw ? Number(lastSyncRaw) : 0
  const now = Date.now()
  if (now - lastSync > 10 * 60 * 1000) {
    await KVStore.setValue('ai.userProfilesLastSync', String(now))
    ragService.scanAndSyncStorage().catch(() => {})
  }
}

async function captureRelationshipFact(text: string, activeUser: string, ragService: RagService) {
  const relationship = parseRelationshipFact(text)
  if (!relationship) return

  const { relation, name } = relationship
  const normalizedName = normalizeUserName(name)
  const profiles = await loadUserProfiles()
  const ownerFacts: string[] = Array.isArray(profiles[activeUser]) ? profiles[activeUser] : []
  const ownerFact = `${relation}: ${normalizedName}`
  const ownerDeduped = ownerFacts.filter((fact) => fact.toLowerCase() !== ownerFact.toLowerCase())
  ownerDeduped.push(ownerFact)
  profiles[activeUser] = ownerDeduped.slice(-50)

  const relatedFacts: string[] = Array.isArray(profiles[normalizedName]) ? profiles[normalizedName] : []
  const relatedFact = `${relationOf(relation)} of ${activeUser}`
  const relatedDeduped = relatedFacts
    .filter((fact) => !/^(husband|wife|spouse|partner) of /i.test(fact))
    .filter((fact) => fact.toLowerCase() !== relatedFact.toLowerCase())
  relatedDeduped.push(relatedFact)
  profiles[normalizedName] = relatedDeduped.slice(-50)

  await saveUserProfiles(profiles)
  await writeProfileToKb(activeUser, profiles[activeUser])
  await writeProfileToKb(normalizedName, profiles[normalizedName])
  await scheduleProfilesSync(ragService)
}

async function capturePersonalFacts(text: string, activeUser: string, ragService: RagService) {
  if (text.trim().endsWith('?')) return
  const facts = parsePersonalFacts(text)
  if (facts.length === 0) return

  const profiles = await loadUserProfiles()
  const existing: string[] = Array.isArray(profiles[activeUser]) ? profiles[activeUser] : []
  const normalizedExisting = new Set(existing.map((f) => f.toLowerCase()))
  const merged = [...existing]
  for (const fact of facts) {
    if (!normalizedExisting.has(fact.toLowerCase())) {
      merged.push(fact)
      normalizedExisting.add(fact.toLowerCase())
    }
  }

  profiles[activeUser] = merged.slice(-50)
  await saveUserProfiles(profiles)
  await writeProfileToKb(activeUser, profiles[activeUser])
  await scheduleProfilesSync(ragService)
}

async function forgetMemoryFacts(text: string, activeUser: string, ragService: RagService) {
  const forgetTargets = parseForgetFacts(text)
  if (forgetTargets.length === 0) return
  const profiles = await loadUserProfiles()
  const existing: string[] = Array.isArray(profiles[activeUser]) ? profiles[activeUser] : []
  const loweredTargets = forgetTargets.map((t) => t.toLowerCase())
  const next = existing.filter((fact) => !loweredTargets.some((target) => fact.toLowerCase().includes(target)))
  profiles[activeUser] = next
  await saveUserProfiles(profiles)
  await writeProfileToKb(activeUser, profiles[activeUser])
  await scheduleProfilesSync(ragService)
}

async function captureRelatedPersonFacts(text: string, activeUser: string, ragService: RagService) {
  const parsed = parseRelatedPersonFact(text)
  if (!parsed) return
  const profiles = await loadUserProfiles()
  const { relation, fact } = parsed
  const relatedName = getRelatedPersonName(profiles[activeUser], relation)

  const ownerFacts: string[] = Array.isArray(profiles[activeUser]) ? profiles[activeUser] : []
  const ownerFact = `${relation} ${fact}`
  const ownerDeduped = ownerFacts.filter((item) => item.toLowerCase() !== ownerFact.toLowerCase())
  ownerDeduped.push(ownerFact)
  profiles[activeUser] = ownerDeduped.slice(-50)
  await writeProfileToKb(activeUser, profiles[activeUser])

  if (relatedName) {
    const relatedFacts: string[] = Array.isArray(profiles[relatedName]) ? profiles[relatedName] : []
    const relatedDeduped = relatedFacts.filter((item) => item.toLowerCase() !== fact.toLowerCase())
    relatedDeduped.push(fact)
    profiles[relatedName] = relatedDeduped.slice(-50)
    await writeProfileToKb(relatedName, profiles[relatedName])
  }

  await saveUserProfiles(profiles)
  await scheduleProfilesSync(ragService)
}

function parseRelationshipFact(text: string): { relation: string; name: string } | null {
  const cleaned = text.trim()
  const patterns: Array<{ relation: string; re: RegExp }> = [
    { relation: 'Wife', re: /\bmy wife['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Wife', re: /\bmy wife is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Wife', re: /\bmy wife is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Husband', re: /\bmy husband['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Husband', re: /\bmy husband is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Husband', re: /\bmy husband is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Partner', re: /\bmy partner['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Partner', re: /\bmy partner is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Partner', re: /\bmy partner is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Daughter', re: /\bmy daughter['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Daughter', re: /\bmy daughter is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Daughter', re: /\bmy daughter is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Son', re: /\bmy son['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Son', re: /\bmy son is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Son', re: /\bmy son is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Child', re: /\bmy child['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Child', re: /\bmy child is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Child', re: /\bmy child is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Mom', re: /\bmy mom['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Mom', re: /\bmy mom is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Mom', re: /\bmy mom is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Dad', re: /\bmy dad['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Dad', re: /\bmy dad is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Dad', re: /\bmy dad is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Sister', re: /\bmy sister['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Sister', re: /\bmy sister is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Sister', re: /\bmy sister is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Brother', re: /\bmy brother['’]?s name is\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Brother', re: /\bmy brother is named\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
    { relation: 'Brother', re: /\bmy brother is called\s+([a-zA-Z][a-zA-Z'.-]{1,30}(?:\s+[a-zA-Z][a-zA-Z'.-]{1,30})?)\b/i },
  ]

  for (const entry of patterns) {
    const match = cleaned.match(entry.re)
    if (match?.[1]) {
      const candidate = match[1].trim()
      if (!isLikelyNonName(candidate)) {
        return { relation: entry.relation, name: candidate }
      }
    }
  }
  return null
}

function parseRelatedPersonFact(text: string): { relation: string; fact: string } | null {
  const cleaned = text.trim()
  if (!cleaned || cleaned.endsWith('?')) return null
  const patterns: Array<{ relation: string; re: RegExp; formatter: (match: RegExpMatchArray) => string }> = [
    { relation: 'Wife', re: /\bmy wife(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i, formatter: (m) => `Likes ${cleanupFactText(m[1])}` },
    { relation: 'Wife', re: /\bmy wife(?:['’]?s)? (?:works at|works for|works as)\s+(.+?)(?:[.!]|$)/i, formatter: (m) => `Works ${m[0].includes('as') ? 'as' : m[0].includes('for') ? 'for' : 'at'} ${cleanupFactText(m[1])}` },
    { relation: 'Wife', re: /\bmy wife(?:['’]?s)? lives in\s+(.+?)(?:[.!]|$)/i, formatter: (m) => `Lives in ${cleanupFactText(m[1])}` },
    { relation: 'Husband', re: /\bmy husband(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i, formatter: (m) => `Likes ${cleanupFactText(m[1])}` },
    { relation: 'Husband', re: /\bmy husband(?:['’]?s)? (?:works at|works for|works as)\s+(.+?)(?:[.!]|$)/i, formatter: (m) => `Works ${m[0].includes('as') ? 'as' : m[0].includes('for') ? 'for' : 'at'} ${cleanupFactText(m[1])}` },
    { relation: 'Husband', re: /\bmy husband(?:['’]?s)? lives in\s+(.+?)(?:[.!]|$)/i, formatter: (m) => `Lives in ${cleanupFactText(m[1])}` },
    { relation: 'Son', re: /\bmy son(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i, formatter: (m) => `Likes ${cleanupFactText(m[1])}` },
    { relation: 'Daughter', re: /\bmy daughter(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i, formatter: (m) => `Likes ${cleanupFactText(m[1])}` },
    { relation: 'Child', re: /\bmy child(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i, formatter: (m) => `Likes ${cleanupFactText(m[1])}` },
  ]
  for (const entry of patterns) {
    const match = cleaned.match(entry.re)
    if (match?.[1]) {
      const fact = entry.formatter(match)
      if (fact && !isLikelyTransientState(fact)) {
        return { relation: entry.relation, fact }
      }
    }
  }
  return null
}

function getRelatedPersonName(facts: string[] | undefined, relation: string): string | null {
  if (!facts || facts.length === 0) return null
  const prefix = `${relation}: `
  const match = facts.find((fact) => fact.toLowerCase().startsWith(prefix.toLowerCase()))
  if (!match) return null
  const name = match.slice(prefix.length).trim()
  return name || null
}

function parsePersonalFacts(text: string): string[] {
  const cleaned = text.trim()
  if (!cleaned) return []
  if (cleaned.length > 180) return []
  if (/^(remember|note|keep this in mind|for my profile|profile)\s*[:\-]/i.test(cleaned)) {
    const explicit = normalizeFact(cleaned)
    return explicit ? [explicit] : []
  }

  const facts: string[] = []
  const likeMatch = cleaned.match(/\bI (?:like|love|enjoy|prefer)\s+(.+?)(?:[.!]|$)/i)
  if (likeMatch?.[1]) facts.push(`Likes ${cleanupFactText(likeMatch[1])}`)
  const liveMatch = cleaned.match(/\bI live in\s+(.+?)(?:[.!]|$)/i)
  if (liveMatch?.[1]) facts.push(`Lives in ${cleanupFactText(liveMatch[1])}`)
  const fromMatch = cleaned.match(/\bI am from\s+(.+?)(?:[.!]|$)/i)
  if (fromMatch?.[1]) facts.push(`From ${cleanupFactText(fromMatch[1])}`)
  const workMatch = cleaned.match(/\bI work (?:as|at|for)\s+(.+?)(?:[.!]|$)/i)
  if (workMatch?.[1]) {
    const mode = workMatch[0].includes('as') ? 'as' : (workMatch[0].includes('for') ? 'for' : 'at')
    facts.push(`Works ${mode} ${cleanupFactText(workMatch[1])}`)
  }
  const jobMatch = cleaned.match(/\bI am an?\s+([a-zA-Z][a-zA-Z\s]{1,60})(?:[.!]|$)/i)
  if (jobMatch?.[1] && !isLikelyTransientState(jobMatch[1])) facts.push(`Is ${cleanupFactText(jobMatch[1])}`)
  const haveMatch = cleaned.match(/\bI have\s+(.+?)(?:[.!]|$)/i)
  if (haveMatch?.[1] && !isLikelyTransientState(haveMatch[1])) facts.push(`Has ${cleanupFactText(haveMatch[1])}`)
  const favoriteMatch = cleaned.match(/\bmy (?:favorite|fav)\s+([a-zA-Z\s]+?)\s+is\s+(.+?)(?:[.!]|$)/i)
  if (favoriteMatch?.[1] && favoriteMatch?.[2]) facts.push(`Favorite ${cleanupFactText(favoriteMatch[1])}: ${cleanupFactText(favoriteMatch[2])}`)
  return facts.filter((fact) => fact.length > 3)
}

function parseForgetFacts(text: string): string[] {
  const cleaned = text.trim()
  const matches = cleaned.match(/^(forget|remove|delete)\s*(?:that)?\s*[:\-]?\s*(.+)$/i)
  if (!matches?.[2]) return []
  const target = matches[2].trim()
  return target ? [target] : []
}

function cleanupFactText(text: string): string {
  return text.replace(/[.?!]+$/, '').replace(/\s+/g, ' ').trim()
}

function buildMemoryContext(question: string, profiles: Record<string, string[]>, activeUser: string | null): string | null {
  const cleaned = question.trim().toLowerCase()
  if (!cleaned) return null
  const knownUsers = Object.keys(profiles)
  const activeFacts = activeUser ? profiles[activeUser] || [] : []
  if (/^(who am i|who am i\?|who am i today)$/.test(cleaned)) {
    return activeUser ? `Active user identity: ${activeUser}` : null
  }
  if (/(tell me about myself|what do you know about me|what do you remember about me)/i.test(cleaned)) {
    if (!activeUser || activeFacts.length === 0) {
      return 'No saved facts are available yet for the active user.'
    }
    return `Saved facts for ${activeUser}:\n- ${activeFacts.join('\n- ')}`
  }
  const relationQuery = parseRelationQuery(cleaned)
  if (relationQuery) {
    if (!activeUser) return null
    const matches = findRelationFacts(activeFacts, relationQuery.relation)
    if (matches.length > 0) {
      const match = matches[0]
      if (relationQuery.intent === 'about') {
        if (relationQuery.relation === 'Child' && matches.length > 1) {
          const childSummaries = matches.map((name) => {
            const relatedFacts = profiles[name] || []
            if (relatedFacts.length === 0) return `- ${name}`
            return `- ${name}: ${relatedFacts.join('; ')}`
          })
          return `Saved facts for children of ${activeUser}:\n${childSummaries.join('\n')}`
        }
        const relatedFacts = profiles[match] || []
        if (relatedFacts.length > 0) {
          return `Saved facts for ${relationQuery.label} ${match}:\n- ${relatedFacts.join('\n- ')}`
        }
      }
      if (relationQuery.relation === 'Child' && matches.length > 1) {
        return `Children of ${activeUser}: ${formatNameList(matches)}`
      }
      return `${relationQuery.label} of ${activeUser}: ${match}`
    }
    return `No saved ${relationQuery.label} information was found for ${activeUser}.`
  }
  const mentioned = findNamedMemoryQuery(question, knownUsers)
  if (mentioned) {
    const facts = profiles[mentioned] || []
    if (facts.length === 0) return `No saved facts are available for ${mentioned}.`
    return `Saved facts for ${mentioned}:\n- ${facts.join('\n- ')}`
  }
  return null
}

function findNamedMemoryQuery(question: string, knownUsers: string[]): string | null {
  for (const name of knownUsers) {
    const escaped = escapeRegExp(name)
    const patterns = [
      new RegExp(`^(?:who is|who's)\\s+${escaped}\\??$`, 'i'),
      new RegExp(`^(?:tell me about|what do you know about|what do you remember about)\\s+${escaped}\\??$`, 'i'),
      new RegExp(`^(?:do you know|do you remember)\\s+(?:who\\s+)?${escaped}(?:\\s+is)?\\??$`, 'i'),
    ]
    if (patterns.some((pattern) => pattern.test(question.trim()))) return name
  }
  return null
}

function isLibraryInventoryQuestion(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return false
  return (
    /(?:what|which|show|list).*(?:pdf|pdfs|file|files|document|documents).*(?:library|knowledge base|kb|uploaded)/i.test(cleaned) ||
    /(?:what|which|show|list)\s+(?:uploads|uploaded files|uploaded documents|uploaded pdfs)/i.test(cleaned) ||
    /what pdfs do you have/i.test(cleaned)
  )
}

async function buildLibraryInventoryContext(question: string, ragService: RagService): Promise<string | null> {
  if (!isLibraryInventoryQuestion(question)) return null
  const wantsPdfOnly = /\bpdfs?\b/i.test(question)
  const fileNames = wantsPdfOnly
    ? await ragService.getUploadedFileDisplayNames('.pdf')
    : await ragService.getUploadedFileDisplayNames()
  if (fileNames.length === 0) {
    return wantsPdfOnly
      ? 'Uploaded PDFs: none'
      : 'Uploaded files: none'
  }
  const visibleNames = fileNames.slice(0, 20)
  const moreCount = fileNames.length - visibleNames.length
  const heading = wantsPdfOnly ? 'Uploaded PDFs:' : 'Uploaded files:'
  const suffix = moreCount > 0 ? `\n- ...and ${moreCount} more` : ''
  return `${heading}\n- ${visibleNames.join('\n- ')}${suffix}`
}

function parseRelationQuery(text: string): { relation: string; label: string; intent: 'name' | 'about' } | null {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return null
  const relationMatchers = [
    { relation: 'Wife', label: 'wife', aliases: ['wife'] },
    { relation: 'Husband', label: 'husband', aliases: ['husband'] },
    { relation: 'Partner', label: 'partner', aliases: ['partner'] },
    { relation: 'Spouse', label: 'spouse', aliases: ['spouse'] },
    { relation: 'Daughter', label: 'daughter', aliases: ['daughter'] },
    { relation: 'Son', label: 'son', aliases: ['son'] },
    { relation: 'Child', label: 'child', aliases: ['child', 'children', 'kid', 'kids'] },
    { relation: 'Mom', label: 'mom', aliases: ['mom', 'mother'] },
    { relation: 'Dad', label: 'dad', aliases: ['dad', 'father'] },
    { relation: 'Sister', label: 'sister', aliases: ['sister'] },
    { relation: 'Brother', label: 'brother', aliases: ['brother'] },
  ] as const
  for (const candidate of relationMatchers) {
    for (const alias of candidate.aliases) {
      const escaped = escapeRegExp(alias)
      const namePatterns = [
        new RegExp(`^(?:who is|who's)\\s+my\\s+${escaped}\\??$`, 'i'),
        new RegExp(`^(?:what is|what's)\\s+my\\s+${escaped}(?:'s)?\\s+name\\??$`, 'i'),
        new RegExp(`^(?:what is|what's)\\s+the\\s+name\\s+of\\s+my\\s+${escaped}\\??$`, 'i'),
        new RegExp(`^(?:do you know|do you remember)\\s+my\\s+${escaped}(?:'s)?\\s+name\\??$`, 'i'),
      ]
      if (namePatterns.some((pattern) => pattern.test(cleaned))) {
        return { relation: candidate.relation, label: candidate.label, intent: 'name' }
      }
      const aboutPatterns = [
        new RegExp(`^(?:tell me about|what do you know about|what do you remember about)\\s+my\\s+${escaped}\\??$`, 'i'),
        new RegExp(`^(?:do you know|do you remember)\\s+(?:anything\\s+about\\s+)?my\\s+${escaped}\\??$`, 'i'),
      ]
      if (aboutPatterns.some((pattern) => pattern.test(cleaned))) {
        return { relation: candidate.relation, label: candidate.label, intent: 'about' }
      }
    }
  }
  return null
}

function findRelationFacts(facts: string[], relation: string): string[] {
  const prefixes = [relation]
  if (relation === 'Spouse') prefixes.push('Wife', 'Husband', 'Partner')
  if (relation === 'Child') prefixes.push('Son', 'Daughter')
  const matches: string[] = []
  for (const prefix of prefixes) {
    for (const fact of facts) {
      if (!fact.toLowerCase().startsWith(`${prefix.toLowerCase()}: `)) continue
      const value = fact.split(':').slice(1).join(':').trim()
      if (value && !matches.includes(value)) matches.push(value)
    }
  }
  return matches
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isLikelyTransientState(text: string): boolean {
  const lower = text.trim().toLowerCase()
  const blacklist = ['ok', 'okay', 'fine', 'good', 'great', 'tired', 'sleepy', 'hungry', 'thirsty', 'busy', 'bored', 'here', 'there', 'ready', 'done']
  return blacklist.includes(lower)
}

function resolveGroundedFollowUpText(currentText: string, messages: Message[]): string {
  const trimmed = currentText.trim()
  if (!trimmed) return currentText

  const previousUserMessages = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim())
    .filter(Boolean)

  if (previousUserMessages.length < 2) return currentText

  const isFollowUpText = (value: string): boolean => {
    const lower = value.trim().toLowerCase()
    return (
      /^(the|it|that|this|those|these|just|please)\b/.test(lower) ||
      /\b(file system|filesystem|directories|directory|folders|folder|files|list them|show them)\b/.test(lower)
    )
  }

  if (!isFollowUpText(trimmed)) return currentText

  const chain: string[] = [trimmed]
  for (let index = previousUserMessages.length - 2; index >= 0; index -= 1) {
    const candidate = previousUserMessages[index]
    chain.unshift(candidate)
    if (!isFollowUpText(candidate)) {
      return chain.join('\nFollow-up: ')
    }
  }

  return chain.join('\nFollow-up: ')
}

function isCapabilityQuestion(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return false
  return (
    /\b(what|which|list|show|tell me)\b/.test(cleaned) &&
    /\b(tool|tools|capabilit(?:y|ies)|access|available|can you do|what can you do|what kind of work)\b/.test(cleaned)
  ) || /^(tools|capabilities|access)\??$/.test(cleaned)
}

function isDesktopShortcutRequest(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return false
  if (!/\b(shortcut|launcher)\b/.test(cleaned)) return false
  return /\b(create|make|add|put)\b/.test(cleaned)
}

function normalizeAutonomousWorker(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function parseAutonomousTaskDecision(raw: string): AutonomousTaskDecision | null {
  const objectText = extractFirstJsonObject(raw)
  if (!objectText) return null

  try {
    const parsed = JSON.parse(objectText)
    const action = typeof parsed?.action === 'string' ? parsed.action.trim().toLowerCase() : ''

    if (action === 'run') {
      let worker = typeof parsed?.worker === 'string' ? normalizeAutonomousWorker(parsed.worker) : ''
      const request = typeof parsed?.request === 'string' ? parsed.request.trim() : ''
      if (!request) return null
      if (!ALLOWED_AUTONOMOUS_WORKERS.has(worker)) {
        worker = inferAutonomousWorkerFromRequest(request)
      }
      if (!worker || !ALLOWED_AUTONOMOUS_WORKERS.has(worker)) return null
      return {
        action: 'run',
        worker,
        request,
      }
    }

    if (action === 'done') {
      return {
        action: 'done',
        reason: typeof parsed?.reason === 'string' ? parsed.reason.trim() : undefined,
      }
    }

    if (action === 'cannot') {
      const reason = typeof parsed?.reason === 'string' ? parsed.reason.trim() : ''
      if (!reason) return null
      return {
        action: 'cannot',
        reason,
      }
    }
  } catch {
    return null
  }

  return null
}

function extractFirstJsonObject(raw: string): string | null {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1] || raw
  const start = candidate.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return candidate.slice(start, index + 1)
      }
    }
  }

  return null
}

function truncateAutonomousResult(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 900) return trimmed
  return `${trimmed.slice(0, 900)}\n...[truncated]`
}

function inferAutonomousWorkerFromRequest(request: string): string {
  const trimmed = request.trim()
  if (/^use ubuntu terminal to\b/i.test(trimmed) || /^(?:on ubuntu|on the host)\b/i.test(trimmed)) {
    return 'host_terminal'
  }
  if (/^use terminal to\b/i.test(trimmed) || /^\s*(?:run|execute)\s+(?:the\s+)?(?:command|shell command)\b/i.test(trimmed)) {
    return 'terminal'
  }
  if (
    /\b(?:inspect|show|read|open|list|find|locate|search|grep|disk usage|storage usage|free space|logs)\b/i.test(
      trimmed
    )
  ) {
    return 'read'
  }
  if (
    /\b(?:what time|what date|date|uptime|status of service|status of container|restart service|system status)\b/i.test(
      trimmed
    )
  ) {
    return 'system'
  }
  if (/\b(?:create|write|append|replace)\b/i.test(trimmed)) {
    return 'edit'
  }
  if (
    /\b(?:home assistant|shopping list|turn on|turn off|lock|unlock|state of|status of)\b/i.test(trimmed)
  ) {
    return 'home_assistant'
  }
  return ''
}

function isDesktopShortcutWriteRequest(request: string): boolean {
  return /(?:cat\s*>|printf\b|tee\b|install\b|touch\b|chmod\b)/i.test(request)
}

function buildAutonomousPlannerHints(
  requestText: string,
  steps: AutonomousTaskStep[],
  allowedWorkers: string[],
  blockedRequests: string[] = []
): string {
  const hints: string[] = []
  const lastStep = steps[steps.length - 1]

  if (steps.length === 0) {
    hints.push('- Start with the smallest inspection step that grounds the task.')
  }

  if (lastStep) {
    hints.push(`- The most recent grounded worker was ${lastStep.worker}.`)
    hints.push(`- Do not repeat this exact request unless its result explicitly requires a retry: ${lastStep.request}`)
  }

  if (isDesktopShortcutRequest(requestText)) {
    const hasContainerInspect = steps.some(
      (step) => step.worker === 'read' && /inspect container homeassistant/i.test(step.request)
    )
    const hasDesktopInspect = steps.some(
      (step) =>
        step.worker === 'host_terminal' &&
        /(Desktop|\.local\/share\/applications|\.desktop\b)/i.test(`${step.request}\n${step.result}`)
    )
    const hasLauncherTemplateInspect = steps.some(
      (step) =>
        step.worker === 'host_terminal' &&
        /(?:cat|sed|head)\b/i.test(step.request) &&
        /\.desktop\b/i.test(step.request)
    )
    const hasWriteAttempt = steps.some(
      (step) => step.worker === 'host_terminal' && isDesktopShortcutWriteRequest(step.request)
    )

    if (!hasContainerInspect) {
      hints.push('- If you do not yet know how Home Assistant is exposed, inspect the Home Assistant container first.')
    } else if (!hasDesktopInspect) {
      hints.push('- The container has already been inspected. Do not inspect it again yet.')
      hints.push('- Next, inspect launcher locations with the host terminal, such as ~/Desktop and ~/.local/share/applications.')
      hints.push('- A good next request would inspect existing .desktop launchers or list those directories.')
    } else if (!hasLauncherTemplateInspect) {
      hints.push('- You already saw the launcher locations. Next, inspect an existing .desktop file with the host terminal so you can mirror its structure.')
      hints.push('- Good targets include nomad.desktop on the Desktop or .desktop files in ~/.local/share/applications.')
    } else if (!hasWriteAttempt) {
      hints.push('- You already inspected a launcher template. Next, use the host terminal to write a real .desktop file on ~/Desktop and then verify it.')
      hints.push('- A valid next host-terminal request can use a heredoc to write Desktop/home-assistant.desktop, then chmod +x it.')
    } else {
      hints.push('- A .desktop write has already been attempted. Next, verify that exact file exists and contains the expected launcher fields.')
    }
  }

  if (blockedRequests.length > 0) {
    hints.push('- These requests are blocked because they already happened and did not advance the task:')
    hints.push(...blockedRequests.map((entry) => `  - ${entry}`))
  }

  if (!allowedWorkers.includes('host_terminal')) {
    hints.push('- Host terminal is not available for this task, so stay within the allowed worker set.')
  }

  return hints.join('\n')
}

function relationOf(relation: string): string {
  switch (relation) {
    case 'Wife':
    case 'Husband':
    case 'Partner':
      return 'Spouse'
    case 'Mom':
    case 'Dad':
      return 'Parent'
    case 'Son':
      return 'Son'
    case 'Daughter':
      return 'Daughter'
    case 'Child':
      return 'Child'
    case 'Brother':
    case 'Sister':
      return 'Sibling'
    default:
      return 'Family'
  }
}

function canonicalizeProfileFact(fact: string): string {
  const spouseMatch = fact.match(/^(husband|wife) of (.+)$/i)
  if (spouseMatch) {
    return `Spouse of ${spouseMatch[2].trim()}`
  }
  return fact
}

function formatNameList(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

function normalizeProfiles(
  profiles: Record<string, unknown>
): { normalized: Record<string, string[]>; changed: boolean } {
  const normalized: Record<string, string[]> = {}
  let changed = false
  for (const [name, facts] of Object.entries(profiles)) {
    const safeName = sanitizeStoredIdentityName(name)
    if (!safeName) {
      changed = true
      continue
    }
    const nextFacts = (Array.isArray(facts) ? facts : [])
      .filter((fact): fact is string => typeof fact === 'string')
      .map((fact) => fact.trim())
      .filter(Boolean)
      .filter((fact) => !hasInvalidFactValue(fact))
      .map((fact) => canonicalizeProfileFact(fact))
      .slice(-50)
    if (safeName !== name || nextFacts.length !== (Array.isArray(facts) ? facts.length : 0)) {
      changed = true
    }
    normalized[safeName] = nextFacts
  }
  return { normalized, changed }
}

function hasInvalidFactValue(fact: string): boolean {
  const relationFact = fact.match(/^([A-Za-z]+):\s*(.+)$/)
  if (!relationFact) return false
  const value = relationFact[2]?.trim()
  return !value || isLikelyNonName(value)
}
