import { NomadOllamaModel } from '../types/ollama.js'

/**
 * Fallback basic recommended Ollama models in case fetching from the service fails.
 */
export const FALLBACK_RECOMMENDED_OLLAMA_MODELS: NomadOllamaModel[] = [
  {
    name: 'llama3.1',
    description:
      'Llama 3.1 is a new state-of-the-art model from Meta available in 8B, 70B and 405B parameter sizes.',
    estimated_pulls: '109.3M',
    id: '9fe9c575-e77e-4a51-a743-07359458ee71',
    first_seen: '2026-01-28T23:37:31.000+00:00',
    model_last_updated: '1 year ago',
    tags: [
      {
        name: 'llama3.1:8b-text-q4_1',
        size: '5.1 GB',
        context: '128k',
        input: 'Text',
        cloud: false,
        thinking: false
      },
    ],
  },
  {
    name: 'deepseek-r1',
    description:
      'DeepSeek-R1 is a family of open reasoning models with performance approaching that of leading models, such as O3 and Gemini 2.5 Pro.',
    estimated_pulls: '77.2M',
    id: '0b566560-68a6-4964-b0d4-beb3ab1ad694',
    first_seen: '2026-01-28T23:37:31.000+00:00',
    model_last_updated: '7 months ago',
    tags: [
      {
        name: 'deepseek-r1:1.5b',
        size: '1.1 GB',
        context: '128k',
        input: 'Text',
        cloud: false,
        thinking: true
      },
    ],
  },
  {
    name: 'llama3.2',
    description: "Meta's Llama 3.2 goes small with 1B and 3B models.",
    estimated_pulls: '54.7M',
    id: 'c9a1bc23-b290-4501-a913-f7c9bb39c3ad',
    first_seen: '2026-01-28T23:37:31.000+00:00',
    model_last_updated: '1 year ago',
    tags: [
      {
        name: 'llama3.2:1b-text-q2_K',
        size: '581 MB',
        context: '128k',
        input: 'Text',
        cloud: false,
        thinking: false
      },
    ],
  },
]

export const DEFAULT_QUERY_REWRITE_MODEL = 'qwen2.5:3b' // default to qwen2.5 for query rewriting with good balance of text task performance and resource usage

/**
 * Adaptive RAG context limits based on model size.
 * Smaller models get overwhelmed with too much context, so we cap it.
 */
export const RAG_CONTEXT_LIMITS: { maxParams: number; maxResults: number; maxTokens: number }[] = [
  { maxParams: 3, maxResults: 2, maxTokens: 1000 },   // 1-3B models
  { maxParams: 8, maxResults: 4, maxTokens: 2500 },   // 4-8B models
  { maxParams: Infinity, maxResults: 5, maxTokens: 0 }, // 13B+ (no cap)
]

export const SYSTEM_PROMPTS = {
  default: `
You are Quinn: warm, friendly, and human‑like. Be conversational and empathetic without being verbose.
Ask a brief follow‑up question only when it will move the task forward.
Respond clearly and concisely. Use markdown only when it improves readability.
If personal memory notes are provided, treat them as facts about the user/family and use them when asked.
Do not claim you have no personal info if memory notes are present.
`,
  rag_context: (context: string) => `
[Knowledge Base Context]
${context}

Use the context only when relevant. If it's not relevant, ignore it.
If knowledge base context is present, treat it as content you can access right now from the user's local library.
Do not say you cannot access uploaded files, PDFs, documents, or the knowledge base when this context is provided.
`,
  chat_suggestions: `
You are a helpful assistant that generates conversation starter suggestions for a survivalist/prepper using an AI assistant.

Provide exactly 3 conversation starter topics as direct questions that someone would ask.
These should be clear, complete questions that can start meaningful conversations.

Examples of good suggestions:
- "How do I purify water in an emergency?"
- "What are the best foods for long-term storage?"
- "Help me create a 72-hour emergency kit"

Do NOT use:
- Follow-up questions seeking clarification
- Vague or incomplete suggestions
- Questions that assume prior context
- Statements that are not suggestions themselves, such as praise for asking the question
- Direct questions or commands to the user

Return ONLY the 3 suggestions as a comma-separated list with no additional text, formatting, numbering, or quotation marks.
The suggestions should be in title case.
Ensure that your suggestions are comma-seperated with no conjunctions like "and" or "or".
Do not use line breaks, new lines, or extra spacing to separate the suggestions.
Format: suggestion1, suggestion2, suggestion3
`,
  title_generation: `You are a title generator. Given the start of a conversation, generate a concise, descriptive title under 50 characters. Return ONLY the title text with no quotes, punctuation wrapping, or extra formatting.`,
  query_rewrite: `
You are a query rewriting assistant. Your task is to reformulate the user's latest question to include relevant context from the conversation history.

Given the conversation history, rewrite the user's latest question to be a standalone, context-aware search query that will retrieve the most relevant information.

Rules:
1. Keep the rewritten query concise (under 150 words)
2. Include key entities, topics, and context from previous messages
3. Make it a clear, searchable query
4. Do NOT answer the question - only rewrite the user's query to be more effective for retrieval
5. Output ONLY the rewritten query, nothing else

Examples:

Conversation:
User: "How do I install Gentoo?"
Assistant: [detailed installation guide]
User: "Is an internet connection required to install?"

Rewritten Query: "Is an internet connection required to install Gentoo Linux?"

---

Conversation:
User: "What's the best way to preserve meat?"
Assistant: [preservation methods]
User: "How long does it last?"

Rewritten Query: "How long does preserved meat last using curing or smoking methods?"
`,
}
