import { ChatService } from '#services/chat_service'
import { DockerService } from '#services/docker_service'
import { OllamaService } from '#services/ollama_service'
import { RagService } from '#services/rag_service'
import Service from '#models/service'
import KVStore from '#models/kv_store'
import { modelNameSchema } from '#validators/download'
import { chatSchema, getAvailableModelsSchema } from '#validators/ollama'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { DEFAULT_QUERY_REWRITE_MODEL, RAG_CONTEXT_LIMITS, SYSTEM_PROMPTS } from '../../constants/ollama.js'
import { SERVICE_NAMES } from '../../constants/service_names.js'
import logger from '@adonisjs/core/services/logger'
import { appendFile, mkdir, writeFile } from 'fs/promises'
import path from 'node:path'
import env from '#start/env'
type Message = { role: 'system' | 'user' | 'assistant'; content: string }

function stripReasoningBlock(text: string): string {
  const trimmed = text.trimStart()
  // Strip fenced code block that starts with "Reasoning" or "Thinking Process"
  if (trimmed.startsWith('```')) {
    const fenceEnd = trimmed.indexOf('```', 3)
    const header = trimmed.slice(3, Math.min(trimmed.length, 80)).toLowerCase()
    if (header.includes('reason') || header.includes('thinking')) {
      if (fenceEnd !== -1) {
        return trimmed.slice(fenceEnd + 3).trimStart()
      }
    }
  }
  // Strip plain "Reasoning" / "Thinking Process" header blocks
  const headerMatch = trimmed.match(/^(reasoning|thinking process)\s*[:\-]*\s*/i)
  if (headerMatch) {
    const rest = trimmed.slice(headerMatch[0].length)
    // Drop up to the first blank line (or a long chunk) if present
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
  // Strip multiple reasoning blocks if present
  for (let i = 0; i < 5; i++) {
    const next = stripReasoningBlock(out)
    if (next === out) break
    out = next
  }
  return out
}

@inject()
export default class OllamaController {
  constructor(
    private chatService: ChatService,
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
      // Capture simple user profile memory (name) before prompting
      const lastUserMessage = [...reqData.messages].reverse().find((m) => m.role === 'user')
      let lastUserText = lastUserMessage?.content?.trim() || ''
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
      } else {
        if (!storedActiveUser && storedUserName) {
          await KVStore.setValue('ai.activeUserName', storedUserName)
        }
      }

      const activeUserForMemory =
        detectedName ? normalizeUserName(detectedName) : storedActiveUser || storedUserName
      if (activeUserForMemory) {
        await captureRelationshipFact(lastUserText, activeUserForMemory, this.ragService)
        await forgetMemoryFacts(lastUserText, activeUserForMemory, this.ragService)
        await capturePersonalFacts(lastUserText, activeUserForMemory, this.ragService)
        await captureRelatedPersonFacts(lastUserText, activeUserForMemory, this.ragService)
      }

      // Store explicit memory facts for the active user
      if (shouldRememberFact(lastUserText)) {
        const fact = normalizeFact(lastUserText)
        const activeUser = activeUserForMemory
        if (activeUser && fact.length > 0) {
          const profiles = await loadUserProfiles()
          const list: string[] = Array.isArray(profiles[activeUser]) ? profiles[activeUser] : []
          const deduped = list.filter((item) => item.toLowerCase() !== fact.toLowerCase())
          deduped.push(fact)
          profiles[activeUser] = deduped.slice(-50)
          await saveUserProfiles(profiles)
          await writeProfileToKb(activeUser, profiles[activeUser])
          await scheduleProfilesSync(this.ragService)
        }
      }

      // Inject base system prompt if missing
      const hasSystemMessage = reqData.messages.some((msg) => msg.role === 'system')
      const customName = await KVStore.getValue('ai.assistantCustomName')
      const assistantName = (customName && customName.trim()) ? customName : 'AI Assistant'
      const storedPromptRaw = await KVStore.getValue('ai.systemPrompt')
      const storedPrompt = typeof storedPromptRaw === 'string' ? storedPromptRaw.trim() : ''
      const baseSystemPrompt = storedPrompt || SYSTEM_PROMPTS.default.trim()
      // Make the prompt visible/editable in the UI even when the user hasn't customized it yet.
      if (!storedPrompt) {
        await KVStore.setValue('ai.systemPrompt', baseSystemPrompt)
      }
      const userName = detectedName ? normalizeUserName(detectedName) : storedUserName
      const activeUser = activeUserForMemory
      const profiles = await loadUserProfiles()
      const knownUsers = Object.keys(profiles)
      const activeUserFacts = activeUser ? profiles[activeUser] || [] : []
      const tz = env.get('NOMAD_TIMEZONE')
      const nowText = formatLocalDateTime(tz)
      if (!hasSystemMessage) {
        const systemPrompt = {
          role: 'system' as const,
          content: `${baseSystemPrompt}\nCurrent date/time: ${nowText}${tz ? ` (${tz})` : ''}\nYour name is ${assistantName}. If asked your name, answer "I'm ${assistantName} — your assistant here. How can I help today?"${userName ? `\nThe user's name is ${userName}. If asked who the user is, answer "${userName}".` : ''}${activeUser ? `\nYou are currently talking to ${activeUser}.` : ''}`,
        }
        logger.debug('[OllamaController] Injecting system prompt')
        reqData.messages.unshift(systemPrompt)
      }

      // Inject memory as a dedicated system message when available
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
        const memoryPrompt = {
          role: 'system' as const,
          content: `User memory (facts, always true):\n${memoryLines.join('\n')}\nIf asked about the user or family, answer using these facts.`,
        }
        const firstNonSystemIndex = reqData.messages.findIndex((msg) => msg.role !== 'system')
        const insertIndex = firstNonSystemIndex === -1 ? reqData.messages.length : firstNonSystemIndex
        reqData.messages.splice(insertIndex, 0, memoryPrompt)
      }

      // Short-circuit with memory answer when the question is explicitly about saved facts.
      const memoryAnswer = buildMemoryAnswer(lastUserText, profiles, activeUser || userName || null)
      if (memoryAnswer) {
        const sessionId = reqData.sessionId ?? null
        if (sessionId) {
          const lastUserMsg = [...reqData.messages].reverse().find((m) => m.role === 'user')
          if (lastUserMsg) {
            await this.chatService.addMessage(sessionId, 'user', lastUserMsg.content)
          }
          await this.chatService.addMessage(sessionId, 'assistant', memoryAnswer)
        }
        if (reqData.stream) {
          response.response.write(`data: ${JSON.stringify({ message: { content: memoryAnswer }, done: true })}\n\n`)
          response.response.end()
          return
        }
        return { message: { content: memoryAnswer }, done: true, model: reqData.model }
      }

      const libraryAnswer = await buildLibraryInventoryAnswer(lastUserText, this.ragService)
      if (libraryAnswer) {
        const sessionId = reqData.sessionId ?? null
        if (sessionId) {
          const lastUserMsg = [...reqData.messages].reverse().find((m) => m.role === 'user')
          if (lastUserMsg) {
            await this.chatService.addMessage(sessionId, 'user', lastUserMsg.content)
          }
          await this.chatService.addMessage(sessionId, 'assistant', libraryAnswer)
        }
        if (reqData.stream) {
          response.response.write(`data: ${JSON.stringify({ message: { content: libraryAnswer }, done: true })}\n\n`)
          response.response.end()
          return
        }
        return { message: { content: libraryAnswer }, done: true, model: reqData.model }
      }

      // For fast chat model, explicitly forbid reasoning dumps
      if (reqData.model === 'qwen3.5:35b-a3b-fast') {
        reqData.messages.unshift({
          role: 'system',
          content:
            'Do not reveal chain-of-thought or reasoning. Respond with the final answer only. Do not wrap responses in code blocks unless the user asked for code.',
        })
      }

      // Query rewriting for better RAG retrieval with manageable context
      // Will return user's latest message if no rewriting is needed
      // Reuse lastUserText for RAG logic
      const looksLikeSmallTalk = /^(hi|hello|hey|yo|sup|what'?s up|how are you|how's it going|test|ping)[.!?]*$/i.test(lastUserText)
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
      let matchedSourceDocs: Array<{ text: string; score: number; metadata?: Record<string, any> }> = []
      const wantsDocumentSummary = /\b(summarize|summary|summarise|overview|what(?:'s| is) in|tell me about)\b/i.test(
        lastUserText
      )
      if (!disableRag && (forceRag || looksLikeKbQuery)) {
        matchedSources = await this.ragService.findUploadedFilesByQuery(lastUserText, 2)
        if (matchedSources.length === 0) {
          matchedSources = await this.ragService.findStoredFilesByQuery(lastUserText, 2)
        }
        if (matchedSources.length > 0) {
          const matchedDocLimit = wantsDocumentSummary ? 8 : 4
          for (const source of matchedSources) {
            const docs = await this.ragService.getDocumentsBySource(source, matchedDocLimit)
            matchedSourceDocs.push(...docs)
          }
        }
      }

      const rewriteStart = Date.now()
      const rewrittenQuery = (looksLikeSmallTalk || disableRewrite)
        ? (lastUserText || null)
        : await this.rewriteQueryWithContext(reqData.messages)
      const rewriteMs = Date.now() - rewriteStart

      logger.debug(`[OllamaController] Rewritten query for RAG: "${rewrittenQuery}"`)
      // Skip RAG for very short or low-signal queries to avoid bloating the prompt.
      let ragDocsCount = 0
      let ragMs = 0
      if (
        !disableRag &&
        rewrittenQuery &&
        (forceRag || looksLikeKbQuery || rewrittenQuery.trim().length >= ragMinChars)
      ) {
        const ragStart = Date.now()
        const relevantDocs = matchedSourceDocs.length > 0
          ? matchedSourceDocs
          : await this.ragService.searchSimilarDocuments(
              rewrittenQuery,
              5, // Top 5 most relevant chunks
              0.3 // Minimum similarity score of 0.3
            )
        ragMs = Date.now() - ragStart

        logger.debug(`[RAG] Retrieved ${relevantDocs.length} relevant documents for query: "${rewrittenQuery}"`)

        // If relevant context is found, inject as a system message with adaptive limits
        const topScore = matchedSourceDocs.length > 0 ? 1 : (relevantDocs[0]?.score ?? 0)
        if (relevantDocs.length > 0 && (forceRag || matchedSourceDocs.length > 0 || topScore >= ragMinScore)) {
          ragDocsCount = relevantDocs.length
          // Determine context budget based on model size
          const { maxResults, maxTokens } = this.getContextLimitsForModel(reqData.model)
          let trimmedDocs = relevantDocs.slice(0, maxResults)

          // Apply token cap if set (estimate ~3.5 chars per token)
          // Always include the first (most relevant) result — the cap only gates subsequent results
          if (maxTokens > 0) {
            const charCap = maxTokens * 3.5
            let totalChars = 0
            trimmedDocs = trimmedDocs.filter((doc, idx) => {
              totalChars += doc.text.length
              return idx === 0 || totalChars <= charCap
            })
          }

          logger.debug(
            `[RAG] Injecting ${trimmedDocs.length}/${relevantDocs.length} results (model: ${reqData.model}, maxResults: ${maxResults}, maxTokens: ${maxTokens || 'unlimited'})`
          )

          const matchedFilesHeader = matchedSources.length > 0
            ? `Matched file(s):\n${matchedSources.map((source) => `- ${path.basename(source)}`).join('\n')}\n\n`
            : ''

          const contextText = matchedFilesHeader + trimmedDocs
            .map((doc, idx) => `[Context ${idx + 1}] (Relevance: ${(doc.score * 100).toFixed(1)}%)\n${doc.text}`)
            .join('\n\n')

          const systemMessage = {
            role: 'system' as const,
            content: SYSTEM_PROMPTS.rag_context(contextText),
          }

          // Insert system message at the beginning (after any existing system messages)
          const firstNonSystemIndex = reqData.messages.findIndex((msg) => msg.role !== 'system')
          const insertIndex = firstNonSystemIndex === -1 ? 0 : firstNonSystemIndex
          reqData.messages.splice(insertIndex, 0, systemMessage)
        }
      }

      // If system messages are large (e.g. due to RAG context), request a context window big
      // enough to fit them. Ollama respects num_ctx per-request; LM Studio ignores it gracefully.
      const systemChars = reqData.messages
        .filter((m) => m.role === 'system')
        .reduce((sum, m) => sum + m.content.length, 0)
      const estimatedSystemTokens = Math.ceil(systemChars / 3.5)
      let numCtx: number | undefined
      if (estimatedSystemTokens > 3000) {
        const needed = estimatedSystemTokens + 2048 // leave room for conversation + response
        numCtx = [8192, 16384, 32768, 65536].find((n) => n >= needed) ?? 65536
        logger.debug(`[OllamaController] Large system prompt (~${estimatedSystemTokens} tokens), requesting num_ctx: ${numCtx}`)
      } else if (reqData.model === 'qwen3.5:35b-a3b-fast') {
        // Keep fast chat lean unless we truly need a big context window
        numCtx = 4096
      }

      // Check if the model supports "thinking" capability for enhanced response generation
      // If gpt-oss model, it requires a text param for "think" https://docs.ollama.com/api/chat
      const thinkingCapability = await this.ollamaService.checkModelHasThinking(reqData.model)
      let think: boolean | 'medium' = false
      if (reqData.think === true) {
        think = thinkingCapability
          ? (reqData.model.startsWith('gpt-oss') ? 'medium' : true)
          : false
      }

      const keepAliveDefault = env.get('NOMAD_OLLAMA_KEEP_ALIVE')
      const keepAliveModelsRaw = env.get('NOMAD_OLLAMA_KEEP_ALIVE_MODELS')
      const keepAliveModels = (keepAliveModelsRaw || '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
      const keepAlive = keepAliveModels.length > 0
        ? (keepAliveModels.includes(reqData.model) ? keepAliveDefault : undefined)
        : keepAliveDefault

      // Separate sessionId from the Ollama request payload — Ollama rejects unknown fields
      const { sessionId, ...ollamaRequest } = reqData
      const isShortPrompt = lastUserText.length > 0 && lastUserText.length < 80
      const maxTokens =
        reqData.model === 'qwen3.5:35b-a3b-fast' && isShortPrompt && !ragDocsCount
          ? 128
          : undefined

      // Optional prompt logging for debugging performance issues
      await this.logPromptIfEnabled({
        timestamp: new Date().toISOString(),
        model: reqData.model,
        sessionId: sessionId ?? null,
        think,
        numCtx: numCtx ?? null,
        messages: reqData.messages,
      })

      // Save user message to DB before streaming if sessionId provided
      let userContent: string | null = null
      if (sessionId) {
        const lastUserMsg = [...reqData.messages].reverse().find((m) => m.role === 'user')
        if (lastUserMsg) {
          userContent = lastUserMsg.content
          await this.chatService.addMessage(sessionId, 'user', userContent)
        }
      }

      if (reqData.stream) {
        logger.debug(`[OllamaController] Initiating streaming response for model: "${reqData.model}" with think: ${think}`)
        // Headers already flushed above
        const chatStart = Date.now()
        const stream = await this.ollamaService.chatStream({ ...ollamaRequest, think, numCtx, keepAlive, maxTokens })
        let fullContent = ''
        let firstChunkAt: number | null = null
        let droppingReasoning = false
        let dropBuffer = ''
        let dropFence = false
        for await (const chunk of stream) {
          let chunkContent = chunk.message?.content ?? ''

          if (chunkContent) {
            if (!droppingReasoning) {
              const trimmed = chunkContent.trimStart()
              if (trimmed.startsWith('```') && (trimmed.toLowerCase().includes('reason') || trimmed.toLowerCase().includes('thinking'))) {
                droppingReasoning = true
                dropFence = true
                dropBuffer += chunkContent
                chunkContent = ''
              } else if (/^(reasoning|thinking process)\s*[:\-]*\s*/i.test(trimmed)) {
                droppingReasoning = true
                dropFence = false
                dropBuffer += chunkContent
                chunkContent = ''
              }
            } else {
              dropBuffer += chunkContent
              chunkContent = ''
            }

            if (droppingReasoning) {
              if (dropFence) {
                const fenceEnd = dropBuffer.indexOf('```', 3)
                if (fenceEnd !== -1) {
                  const remaining = dropBuffer.slice(fenceEnd + 3)
                  dropBuffer = ''
                  droppingReasoning = false
                  dropFence = false
                  chunkContent = remaining
                }
              } else {
                const blankIdx = dropBuffer.search(/\n\s*\n/)
                if (blankIdx !== -1) {
                  const remaining = dropBuffer.slice(blankIdx)
                  dropBuffer = ''
                  droppingReasoning = false
                  chunkContent = remaining
                }
              }
            }
          }

          if (chunkContent) {
            chunkContent = stripReasoningBlocksAll(chunkContent)
          }
          if (chunkContent) {
            fullContent += chunkContent
          }
          if (firstChunkAt === null && (chunk.message?.content || chunk.message?.thinking)) {
            firstChunkAt = Date.now()
          }
          if (chunkContent !== chunk.message?.content) {
            response.response.write(`data: ${JSON.stringify({ ...chunk, message: { ...chunk.message, content: chunkContent } })}\n\n`)
          } else {
            response.response.write(`data: ${JSON.stringify(chunk)}\n\n`)
          }
        }
        response.response.end()
        const chatMs = Date.now() - chatStart

        // Save assistant message and optionally generate title
        if (sessionId && fullContent) {
          await this.chatService.addMessage(sessionId, 'assistant', fullContent)
          const messageCount = await this.chatService.getMessageCount(sessionId)
          if (messageCount <= 2 && userContent) {
            this.chatService.generateTitle(sessionId, userContent, fullContent).catch((err) => {
              logger.error(`[OllamaController] Title generation failed: ${err instanceof Error ? err.message : err}`)
            })
          }
        }
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
          ttfbMs: firstChunkAt ? firstChunkAt - chatStart : null,
          totalMs: Date.now() - perfStart,
          chatMs,
        }
        console.log('[ChatPerf]', JSON.stringify(perfPayload))
        await this.logChatPerfIfEnabled(perfPayload)
        return
      }

      // Non-streaming (legacy) path
      const chatStart = Date.now()
      const result = await this.ollamaService.chat({ ...ollamaRequest, think, numCtx, keepAlive, maxTokens })
      if (result?.message?.content) {
        result.message.content = stripReasoningBlocksAll(result.message.content)
      }
      const chatMs = Date.now() - chatStart

      if (sessionId && result?.message?.content) {
        await this.chatService.addMessage(sessionId, 'assistant', result.message.content)
        const messageCount = await this.chatService.getMessageCount(sessionId)
        if (messageCount <= 2 && userContent) {
          this.chatService.generateTitle(sessionId, userContent, result.message.content).catch((err) => {
            logger.error(`[OllamaController] Title generation failed: ${err instanceof Error ? err.message : err}`)
          })
        }
      }

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
      await this.logChatPerfIfEnabled(perfPayload)
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

  /**
   * Determines RAG context limits based on model size extracted from the model name.
   * Parses size indicators like "1b", "3b", "8b", "70b" from model names/tags.
   */
  private getContextLimitsForModel(modelName: string): { maxResults: number; maxTokens: number } {
    // Extract parameter count from model name (e.g., "llama3.2:3b", "qwen2.5:1.5b", "gemma:7b")
    const sizeMatch = modelName.match(/(\d+\.?\d*)[bB]/)
    const paramBillions = sizeMatch ? parseFloat(sizeMatch[1]) : 8 // default to 8B if unknown

    for (const tier of RAG_CONTEXT_LIMITS) {
      if (paramBillions <= tier.maxParams) {
        return { maxResults: tier.maxResults, maxTokens: tier.maxTokens }
      }
    }

    // Fallback: no limits
    return { maxResults: 5, maxTokens: 0 }
  }

  private async rewriteQueryWithContext(
    messages: Message[]
  ): Promise<string | null> {
    try {
      // Get recent conversation history (last 6 messages for 3 turns)
      const recentMessages = messages.slice(-6)

      // Skip rewriting for short conversations. Rewriting adds latency with
      // little RAG benefit until there is enough context to matter.
      const userMessages = recentMessages.filter(msg => msg.role === 'user')
      if (userMessages.length <= 2) {
        return userMessages[userMessages.length - 1]?.content || null
      }

      const conversationContext = recentMessages
        .map(msg => {
          const role = msg.role === 'user' ? 'User' : 'Assistant'
          // Truncate assistant messages to first 200 chars to keep context manageable
          const content = msg.role === 'assistant'
            ? msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : '')
            : msg.content
          return `${role}: "${content}"`
        })
        .join('\n')

      const installedModels = await this.ollamaService.getModels(true)
      const rewriteModelAvailable = installedModels?.some(model => model.name === DEFAULT_QUERY_REWRITE_MODEL)
      if (!rewriteModelAvailable) {
        logger.warn(`[RAG] Query rewrite model "${DEFAULT_QUERY_REWRITE_MODEL}" not available. Skipping query rewriting.`)
        const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user')
        return lastUserMessage?.content || null
      }

      // FUTURE ENHANCEMENT: allow the user to specify which model to use for rewriting
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
      // Fallback to last user message if rewriting fails
      const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user')
      return lastUserMessage?.content || null
    }
  }

  private async logPromptIfEnabled(payload: {
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
      logger.error(`[OllamaController] Failed to write prompt log: ${err?.message || err}`)
    }
  }

  private async logChatPerfIfEnabled(payload: {
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
      logger.error(`[OllamaController] Failed to write chat perf log: ${err?.message || err}`)
    }
  }
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
    // fall back to system time if timezone invalid
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
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
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
    'fine',
    'good',
    'okay',
    'ok',
    'great',
    'here',
    'there',
    'me',
    'you',
    'done',
    'finished',
    'ready',
    'busy',
    'hungry',
    'tired',
    'sleepy',
    'reason',
    'moment',
    'wife',
    'husband',
    'partner',
    'spouse',
    'mother',
    'father',
    'mom',
    'dad',
    'son',
    'daughter',
    'child',
    'children',
    'kid',
    'kids',
    'brother',
    'sister',
    'family',
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

  // Always store on the active user's profile
  const ownerFacts: string[] = Array.isArray(profiles[activeUser]) ? profiles[activeUser] : []
  const ownerFact = `${relation} ${fact}`
  const ownerDeduped = ownerFacts.filter((item) => item.toLowerCase() !== ownerFact.toLowerCase())
  ownerDeduped.push(ownerFact)
  profiles[activeUser] = ownerDeduped.slice(-50)
  await writeProfileToKb(activeUser, profiles[activeUser])

  // If we know the related person's name, store on their profile too
  if (relatedName) {
    const relatedFacts: string[] = Array.isArray(profiles[relatedName]) ? profiles[relatedName] : []
    const relatedFact = fact
    const relatedDeduped = relatedFacts.filter((item) => item.toLowerCase() !== relatedFact.toLowerCase())
    relatedDeduped.push(relatedFact)
    profiles[relatedName] = relatedDeduped.slice(-50)
    await writeProfileToKb(relatedName, profiles[relatedName])
  }

  await saveUserProfiles(profiles)
  await scheduleProfilesSync(ragService)
}

function parseRelationshipFact(text: string): { relation: string; name: string } | null {
  const cleaned = text.trim()
  // Only treat relationship memory as a name when the user uses explicit naming language.
  // This avoids bogus profiles like "Son", "Mother", "Reason", or "Moment".
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
    {
      relation: 'Wife',
      re: /\bmy wife(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i,
      formatter: (m) => `Likes ${cleanupFactText(m[1])}`,
    },
    {
      relation: 'Wife',
      re: /\bmy wife(?:['’]?s)? (?:works at|works for|works as)\s+(.+?)(?:[.!]|$)/i,
      formatter: (m) => `Works ${m[0].includes('as') ? 'as' : m[0].includes('for') ? 'for' : 'at'} ${cleanupFactText(m[1])}`,
    },
    {
      relation: 'Wife',
      re: /\bmy wife(?:['’]?s)? lives in\s+(.+?)(?:[.!]|$)/i,
      formatter: (m) => `Lives in ${cleanupFactText(m[1])}`,
    },
    {
      relation: 'Husband',
      re: /\bmy husband(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i,
      formatter: (m) => `Likes ${cleanupFactText(m[1])}`,
    },
    {
      relation: 'Husband',
      re: /\bmy husband(?:['’]?s)? (?:works at|works for|works as)\s+(.+?)(?:[.!]|$)/i,
      formatter: (m) => `Works ${m[0].includes('as') ? 'as' : m[0].includes('for') ? 'for' : 'at'} ${cleanupFactText(m[1])}`,
    },
    {
      relation: 'Husband',
      re: /\bmy husband(?:['’]?s)? lives in\s+(.+?)(?:[.!]|$)/i,
      formatter: (m) => `Lives in ${cleanupFactText(m[1])}`,
    },
    {
      relation: 'Son',
      re: /\bmy son(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i,
      formatter: (m) => `Likes ${cleanupFactText(m[1])}`,
    },
    {
      relation: 'Daughter',
      re: /\bmy daughter(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i,
      formatter: (m) => `Likes ${cleanupFactText(m[1])}`,
    },
    {
      relation: 'Child',
      re: /\bmy child(?:['’]?s)? (?:likes|loves|enjoys|prefers)\s+(.+?)(?:[.!]|$)/i,
      formatter: (m) => `Likes ${cleanupFactText(m[1])}`,
    },
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
  if (jobMatch?.[1] && !isLikelyTransientState(jobMatch[1])) {
    facts.push(`Is ${cleanupFactText(jobMatch[1])}`)
  }

  const haveMatch = cleaned.match(/\bI have\s+(.+?)(?:[.!]|$)/i)
  if (haveMatch?.[1] && !isLikelyTransientState(haveMatch[1])) {
    facts.push(`Has ${cleanupFactText(haveMatch[1])}`)
  }

  const favoriteMatch = cleaned.match(/\bmy (?:favorite|fav)\s+([a-zA-Z\s]+?)\s+is\s+(.+?)(?:[.!]|$)/i)
  if (favoriteMatch?.[1] && favoriteMatch?.[2]) {
    facts.push(`Favorite ${cleanupFactText(favoriteMatch[1])}: ${cleanupFactText(favoriteMatch[2])}`)
  }

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
  return text
    .replace(/[.?!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildMemoryAnswer(question: string, profiles: Record<string, string[]>, activeUser: string | null): string | null {
  const cleaned = question.trim().toLowerCase()
  if (!cleaned) return null

  const knownUsers = Object.keys(profiles)
  const activeFacts = activeUser ? profiles[activeUser] || [] : []

  if (/^(who am i|who am i\?|who am i today)$/.test(cleaned)) {
    return activeUser ? `You are ${activeUser}.` : null
  }

  if (/(tell me about myself|what do you know about me|what do you remember about me)/i.test(cleaned)) {
    if (!activeUser || activeFacts.length === 0) {
      return "I don't have any saved facts about you yet. Tell me a bit about yourself and I'll remember."
    }
    return `Here's what I have saved about you, ${activeUser}:\n- ${activeFacts.join('\n- ')}`
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
            if (relatedFacts.length === 0) {
              return `- ${name}`
            }
            return `- ${name}: ${relatedFacts.join('; ')}`
          })
          return `Here's what I have saved about your children:\n${childSummaries.join('\n')}`
        }

        const relatedFacts = profiles[match] || []
        if (relatedFacts.length > 0) {
          return `Here's what I have saved about your ${relationQuery.label}, ${match}:\n- ${relatedFacts.join('\n- ')}`
        }
      }

      if (relationQuery.relation === 'Child' && matches.length > 1) {
        return `Your children are ${formatNameList(matches)}.`
      }

      return `Your ${relationQuery.label} is ${match}.`
    }
    return `I don't have your ${relationQuery.label}'s name saved yet.`
  }

  const mentioned = findNamedMemoryQuery(question, knownUsers)
  if (mentioned) {
    const facts = profiles[mentioned] || []
    if (facts.length === 0) {
      return `I don't have any saved facts about ${mentioned} yet.`
    }
    return `Here's what I have saved about ${mentioned}:\n- ${facts.join('\n- ')}`
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

    if (patterns.some((pattern) => pattern.test(question.trim()))) {
      return name
    }
  }

  return null
}

function isLibraryInventoryQuestion(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return false

  return (
    /(?:what|which|show|list).*(?:pdf|pdfs|file|files|document|documents).*(?:library|knowledge base|kb|uploaded)/i.test(
      cleaned
    ) ||
    /(?:what|which|show|list)\s+(?:uploads|uploaded files|uploaded documents|uploaded pdfs)/i.test(
      cleaned
    ) ||
    /what pdfs do you have/i.test(cleaned)
  )
}

async function buildLibraryInventoryAnswer(
  question: string,
  ragService: RagService
): Promise<string | null> {
  if (!isLibraryInventoryQuestion(question)) {
    return null
  }

  const wantsPdfOnly = /\bpdfs?\b/i.test(question)
  const fileNames = wantsPdfOnly
    ? await ragService.getUploadedFileDisplayNames('.pdf')
    : await ragService.getUploadedFileDisplayNames()

  if (fileNames.length === 0) {
    return wantsPdfOnly
      ? "I don't have any uploaded PDFs in the knowledge base yet."
      : "I don't have any uploaded files in the knowledge base yet."
  }

  const visibleNames = fileNames.slice(0, 20)
  const moreCount = fileNames.length - visibleNames.length
  const heading = wantsPdfOnly
    ? 'I currently have these uploaded PDFs in the knowledge base:'
    : 'I currently have these uploaded files in the knowledge base:'
  const suffix = moreCount > 0 ? `\n- ...and ${moreCount} more` : ''

  return `${heading}\n- ${visibleNames.join('\n- ')}${suffix}`
}

function parseRelationQuery(
  text: string
): { relation: string; label: string; intent: 'name' | 'about' } | null {
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
  if (relation === 'Spouse') {
    prefixes.push('Wife', 'Husband', 'Partner')
  }
  if (relation === 'Child') {
    prefixes.push('Son', 'Daughter')
  }

  const matches: string[] = []
  for (const prefix of prefixes) {
    for (const fact of facts) {
      if (!fact.toLowerCase().startsWith(`${prefix.toLowerCase()}: `)) continue
      const value = fact.split(':').slice(1).join(':').trim()
      if (value && !matches.includes(value)) {
        matches.push(value)
      }
    }
  }
  return matches
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isLikelyTransientState(text: string): boolean {
  const lower = text.trim().toLowerCase()
  const blacklist = [
    'ok',
    'okay',
    'fine',
    'good',
    'great',
    'tired',
    'sleepy',
    'hungry',
    'thirsty',
    'busy',
    'bored',
    'here',
    'there',
    'ready',
    'done',
  ]
  return blacklist.includes(lower)
}

function relationOf(relation: string): string {
  switch (relation) {
    case 'Wife':
      return 'Spouse'
    case 'Husband':
      return 'Spouse'
    case 'Partner':
      return 'Spouse'
    case 'Mom':
      return 'Parent'
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

function normalizeProfiles(input: Record<string, string[]>) {
  let changed = false
  const normalized: Record<string, string[]> = {}
  for (const [name, facts] of Object.entries(input)) {
    const normalizedName = sanitizeStoredIdentityName(name)
    if (!normalizedName) {
      changed = true
      continue
    }

    const nextFacts = (Array.isArray(facts) ? facts : [])
      .map((fact) => {
        const normalizedFact = canonicalizeProfileFact(fact)
        if (normalizedFact !== fact) {
          changed = true
        }
        return normalizedFact
      })
      .filter((fact) => {
        const relationMatch = fact.match(/^(wife|husband|partner|spouse|daughter|son|child|mom|dad|sister|brother):\s+(.+)$/i)
        if (!relationMatch) return true
        const relatedName = sanitizeStoredIdentityName(relationMatch[2])
        if (!relatedName) {
          changed = true
          return false
        }
        if (relatedName !== relationMatch[2].trim()) {
          changed = true
        }
        return true
      })
    if (normalizedName !== name) {
      changed = true
    }
    normalized[normalizedName] = nextFacts
  }
  return { normalized, changed }
}
