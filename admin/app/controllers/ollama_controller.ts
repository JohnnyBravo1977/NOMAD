import { ChatOrchestratorService } from '#services/chat_orchestrator_service'
import { DockerService } from '#services/docker_service'
import { OllamaService } from '#services/ollama_service'
import { RagService } from '#services/rag_service'
import Service from '#models/service'
import KVStore from '#models/kv_store'
import { modelNameSchema } from '#validators/download'
import { chatSchema, getAvailableModelsSchema } from '#validators/ollama'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { SYSTEM_PROMPTS } from '../../constants/ollama.js'
import { SERVICE_NAMES } from '../../constants/service_names.js'
import logger from '@adonisjs/core/services/logger'

@inject()
export default class OllamaController {
  constructor(
    private chatOrchestratorService: ChatOrchestratorService,
    private dockerService: DockerService,
    private ollamaService: OllamaService,
    private ragService: RagService
  ) { }

  async availableModels({ request }: HttpContext) {
    const reqData = await request.validateUsing(getAvailableModelsSchema)
    return await this.ollamaService.getAvailableModels({
      sort: reqData.sort,
      recommendedOnly: reqData.recommendedOnly,
      query: reqData.query || null,
      limit: reqData.limit || 15,
      force: reqData.force,
    })
  }

  async systemPromptDefault() {
    return {
      prompt: SYSTEM_PROMPTS.default.trim(),
    }
  }

  async chat({ request, response }: HttpContext) {
    const reqData = await request.validateUsing(chatSchema)
    const perfStart = Date.now()
    console.log('[ChatPerf] request_start', JSON.stringify({
      model: reqData.model,
      stream: !!reqData.stream,
      messageCount: reqData.messages.length,
    }))

    // Flush SSE headers immediately so the client connection is open while
    // pre-processing (query rewriting, RAG lookup) runs in the background.
    if (reqData.stream) {
      response.response.setHeader('Content-Type', 'text/event-stream')
      response.response.setHeader('Cache-Control', 'no-cache')
      response.response.setHeader('Connection', 'keep-alive')
      response.response.flushHeaders()
    }

    try {
      const customName = await KVStore.getValue('ai.assistantCustomName')
      const assistantName = (customName && customName.trim()) ? customName : 'AI Assistant'
      const storedPromptRaw = await KVStore.getValue('ai.systemPrompt')
      const storedPrompt = typeof storedPromptRaw === 'string' ? storedPromptRaw.trim() : ''
      const baseSystemPrompt = storedPrompt || SYSTEM_PROMPTS.default.trim()
      const personalizationPlan = await this.chatOrchestratorService.preparePersonalization({
        messages: reqData.messages,
        assistantName,
        baseSystemPrompt,
        ragService: this.ragService,
      })
      let lastUserText = personalizationPlan.lastUserText
      for (const systemMessage of personalizationPlan.systemMessages) {
        logger.debug('[OllamaController] Injecting orchestrated system prompt')
        reqData.messages.unshift(systemMessage)
      }

      const directAnswer = await this.chatOrchestratorService.prepareDirectAnswer({
        lastUserText,
        profiles: personalizationPlan.profiles,
        activeUser: personalizationPlan.activeUser,
        userName: personalizationPlan.userName,
        ragService: this.ragService,
      })
      if (directAnswer) {
        const sessionId = reqData.sessionId ?? null
        const userContent = await this.chatOrchestratorService.saveUserMessage(sessionId, reqData.messages)
        await this.chatOrchestratorService.saveAssistantReply({
          sessionId,
          userContent,
          assistantContent: directAnswer.content,
        })
        if (reqData.stream) {
          response.response.write(`data: ${JSON.stringify({ message: { content: directAnswer.content }, done: true })}\n\n`)
          response.response.end()
          return
        }
        return { message: { content: directAnswer.content }, done: true, model: reqData.model }
      }

      // Query rewriting for better RAG retrieval with manageable context
      // Will return user's latest message if no rewriting is needed
      // Reuse lastUserText for RAG logic
      const knowledgePlan = await this.chatOrchestratorService.prepareKnowledgeContext({
        messages: reqData.messages,
        lastUserText,
        model: reqData.model,
        ragService: this.ragService,
        rewriteQuery: (messages) => this.chatOrchestratorService.rewriteQueryWithContext(messages),
        getContextLimitsForModel: (modelName) => this.chatOrchestratorService.getContextLimitsForModel(modelName),
        buildRagPrompt: (context) => SYSTEM_PROMPTS.rag_context(context),
      })
      lastUserText = knowledgePlan.lastUserText
      const rewrittenQuery = knowledgePlan.rewrittenQuery
      const rewriteMs = knowledgePlan.rewriteMs

      logger.debug(`[OllamaController] Rewritten query for RAG: "${rewrittenQuery}"`)
      const ragDocsCount = knowledgePlan.ragDocsCount
      const ragMs = knowledgePlan.ragMs
      if (knowledgePlan.systemMessage) {
        const firstNonSystemIndex = reqData.messages.findIndex((msg) => msg.role !== 'system')
        const insertIndex = firstNonSystemIndex === -1 ? 0 : firstNonSystemIndex
        reqData.messages.splice(insertIndex, 0, knowledgePlan.systemMessage)
      }

      const { numCtx, keepAlive, maxTokens } = this.chatOrchestratorService.buildRuntimeSettings({
        messages: reqData.messages,
        model: reqData.model,
        lastUserText,
        ragDocsCount,
      })

      // Check if the model supports "thinking" capability for enhanced response generation
      // If gpt-oss model, it requires a text param for "think" https://docs.ollama.com/api/chat
      const thinkingCapability = await this.ollamaService.checkModelHasThinking(reqData.model)
      let think: boolean | 'medium' = false
      if (reqData.think === true) {
        think = thinkingCapability
          ? (reqData.model.startsWith('gpt-oss') ? 'medium' : true)
          : false
      }

      // Separate sessionId from the Ollama request payload — Ollama rejects unknown fields
      const { sessionId, ...ollamaRequest } = reqData

      // Optional prompt logging for debugging performance issues
      await this.chatOrchestratorService.logPromptIfEnabled({
        timestamp: new Date().toISOString(),
        model: reqData.model,
        sessionId: sessionId ?? null,
        think,
        numCtx: numCtx ?? null,
        messages: reqData.messages,
      })

      // Save user message to DB before streaming if sessionId provided
      const userContent = await this.chatOrchestratorService.saveUserMessage(sessionId ?? null, reqData.messages)

      if (reqData.stream) {
        logger.debug(`[OllamaController] Initiating streaming response for model: "${reqData.model}" with think: ${think}`)
        const streamResult = await this.chatOrchestratorService.executeStreamingChat({
          ...ollamaRequest,
          think,
          numCtx,
          keepAlive,
          maxTokens,
          onChunk: async (chunk) => {
            response.response.write(`data: ${JSON.stringify(chunk)}\n\n`)
          },
        })
        response.response.end()

        await this.chatOrchestratorService.saveAssistantReply({
          sessionId: sessionId ?? null,
          userContent,
          assistantContent: streamResult.fullContent,
        })
        const perfPayload = {
          timestamp: new Date().toISOString(),
          model: reqData.model,
          sessionId: sessionId ?? null,
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
        await this.chatOrchestratorService.logChatPerfIfEnabled(perfPayload)
        return
      }

      const { result, chatMs } = await this.chatOrchestratorService.executeChat({
        ...ollamaRequest,
        think,
        numCtx,
        keepAlive,
        maxTokens,
      })

      await this.chatOrchestratorService.saveAssistantReply({
        sessionId: sessionId ?? null,
        userContent,
        assistantContent: result?.message?.content || '',
      })

      const perfPayload = {
        timestamp: new Date().toISOString(),
        model: reqData.model,
        sessionId: sessionId ?? null,
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
      await this.chatOrchestratorService.logChatPerfIfEnabled(perfPayload)
      return result
    } catch (error) {
      if (reqData.stream) {
        response.response.write(`data: ${JSON.stringify({ error: true })}\n\n`)
        response.response.end()
        return
      }
      throw error
    }
  }

  async remoteStatus() {
    const remoteUrl = await KVStore.getValue('ai.remoteOllamaUrl')
    if (!remoteUrl) {
      return { configured: false, connected: false }
    }
    try {
      const testResponse = await fetch(`${remoteUrl.replace(/\/$/, '')}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      })
      return { configured: true, connected: testResponse.ok }
    } catch {
      return { configured: true, connected: false }
    }
  }

  async configureRemote({ request, response }: HttpContext) {
    const remoteUrl: string | null = request.input('remoteUrl', null)

    const ollamaService = await Service.query().where('service_name', SERVICE_NAMES.OLLAMA).first()
    if (!ollamaService) {
      return response.status(404).send({ success: false, message: 'Ollama service record not found.' })
    }

    // Clear path: null or empty URL removes remote config and marks service as not installed
    if (!remoteUrl || remoteUrl.trim() === '') {
      await KVStore.clearValue('ai.remoteOllamaUrl')
      ollamaService.installed = false
      ollamaService.installation_status = 'idle'
      await ollamaService.save()
      return { success: true, message: 'Remote Ollama configuration cleared.' }
    }

    // Validate URL format
    if (!remoteUrl.startsWith('http')) {
      return response.status(400).send({
        success: false,
        message: 'Invalid URL. Must start with http:// or https://',
      })
    }

    // Test connectivity via OpenAI-compatible /v1/models endpoint (works with Ollama, LM Studio, llama.cpp, etc.)
    try {
      const testResponse = await fetch(`${remoteUrl.replace(/\/$/, '')}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!testResponse.ok) {
        return response.status(400).send({
          success: false,
          message: `Could not connect to ${remoteUrl} (HTTP ${testResponse.status}). Make sure the server is running and accessible. For Ollama, start it with OLLAMA_HOST=0.0.0.0.`,
        })
      }
    } catch (error) {
      return response.status(400).send({
        success: false,
        message: `Could not connect to ${remoteUrl}. Make sure the server is running and reachable. For Ollama, start it with OLLAMA_HOST=0.0.0.0.`,
      })
    }

    // Save remote URL and mark service as installed
    await KVStore.setValue('ai.remoteOllamaUrl', remoteUrl.trim())
    ollamaService.installed = true
    ollamaService.installation_status = 'idle'
    await ollamaService.save()

    // Install Qdrant if not already installed (fire-and-forget)
    const qdrantService = await Service.query().where('service_name', SERVICE_NAMES.QDRANT).first()
    if (qdrantService && !qdrantService.installed) {
      this.dockerService.createContainerPreflight(SERVICE_NAMES.QDRANT).catch((error) => {
        logger.error('[OllamaController] Failed to start Qdrant preflight:', error)
      })
    }

    // Mirror post-install side effects: disable suggestions, trigger docs discovery
    await KVStore.setValue('chat.suggestionsEnabled', false)
    this.ragService.discoverNomadDocs().catch((error) => {
      logger.error('[OllamaController] Failed to discover Nomad docs:', error)
    })

    return { success: true, message: 'Remote Ollama configured.' }
  }

  async deleteModel({ request }: HttpContext) {
    const reqData = await request.validateUsing(modelNameSchema)
    await this.ollamaService.deleteModel(reqData.model)
    return {
      success: true,
      message: `Model deleted: ${reqData.model}`,
    }
  }

  async dispatchModelDownload({ request }: HttpContext) {
    const reqData = await request.validateUsing(modelNameSchema)
    return await this.ollamaService.dispatchModelDownload(reqData.model)
  }

  async installedModels({ }: HttpContext) {
    return await this.ollamaService.getModels()
  }

}
