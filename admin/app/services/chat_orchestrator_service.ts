import { inject } from '@adonisjs/core'
import env from '#start/env'
import path from 'node:path'
import { RagService } from '#services/rag_service'

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

@inject()
export class ChatOrchestratorService {
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
    const { messages, model, lastUserText, ragDocsCount } = args
    const systemChars = messages
      .filter((m) => m.role === 'system')
      .reduce((sum, m) => sum + m.content.length, 0)
    const estimatedSystemTokens = Math.ceil(systemChars / 3.5)

    let numCtx: number | undefined
    if (estimatedSystemTokens > 3000) {
      const needed = estimatedSystemTokens + 2048
      numCtx = [8192, 16384, 32768, 65536].find((n) => n >= needed) ?? 65536
    } else if (model === 'qwen3.5:35b-a3b-fast') {
      numCtx = 4096
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

    const isShortPrompt = lastUserText.length > 0 && lastUserText.length < 80
    const maxTokens =
      model === 'qwen3.5:35b-a3b-fast' && isShortPrompt && !ragDocsCount ? 128 : undefined

    return { numCtx, keepAlive, maxTokens }
  }
}
