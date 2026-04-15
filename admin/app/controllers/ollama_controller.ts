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
      const chatResult = await this.chatOrchestratorService.runChatTurn({
        requestData: reqData,
        ragService: this.ragService,
        perfStart,
        onStreamChunk: async (chunk) => {
          response.response.write(`data: ${JSON.stringify(chunk)}\n\n`)
        },
      })

      if (chatResult.kind === 'stream') {
        response.response.end()
        return
      }

      return chatResult.body
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
