import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import ChatSidebar from './ChatSidebar'
import ChatInterface from './ChatInterface'
import StyledModal from '../StyledModal'
import api from '~/lib/api'
import { formatBytes } from '~/lib/util'
import { useModals } from '~/context/ModalContext'
import { ChatMessage } from '../../../types/chat'
import classNames from '~/lib/classNames'
import { IconX } from '@tabler/icons-react'
import { DEFAULT_QUERY_REWRITE_MODEL } from '../../../constants/ollama'
import { useSystemSetting } from '~/hooks/useSystemSetting'
import { useNotifications } from '~/context/NotificationContext'

interface ChatProps {
  enabled: boolean
  isInModal?: boolean
  onClose?: () => void
  suggestionsEnabled?: boolean
  streamingEnabled?: boolean
}

export default function Chat({
  enabled,
  isInModal,
  onClose,
  suggestionsEnabled = false,
  streamingEnabled = true,
}: ChatProps) {
  const queryClient = useQueryClient()
  const { openModal, closeAllModals } = useModals()
  const { addNotification } = useNotifications()
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [isStreamingResponse, setIsStreamingResponse] = useState(false)
  const streamAbortRef = useRef<AbortController | null>(null)
  const [thinkingEnabled, setThinkingEnabled] = useState(() => {
    try {
      return localStorage.getItem('nomad:chat-thinking-enabled') === 'true'
    } catch {
      return false
    }
  })

  // Fetch all sessions
  const { data: sessions = [] } = useQuery({
    queryKey: ['chatSessions'],
    queryFn: () => api.getChatSessions(),
    enabled,
    select: (data) =>
      data?.map((s) => ({
        id: s.id,
        title: s.title,
        model: s.model || undefined,
        timestamp: new Date(s.timestamp),
        lastMessage: s.lastMessage || undefined,
      })) || [],
  })

  const activeSession = sessions.find((s) => s.id === activeSessionId)

  const { data: lastModelSetting } = useSystemSetting({ key: 'chat.lastModel', enabled })
  const { data: remoteOllamaUrlSetting } = useSystemSetting({ key: 'ai.remoteOllamaUrl', enabled })
  const { data: systemPromptSetting } = useSystemSetting({ key: 'ai.systemPrompt', enabled })
  const [promptEditorOpen, setPromptEditorOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')

  const { data: remoteStatus } = useQuery({
    queryKey: ['remoteOllamaStatus'],
    queryFn: () => api.getRemoteOllamaStatus(),
    enabled: enabled && !!remoteOllamaUrlSetting?.value,
    refetchInterval: 15000,
  })

  const { data: defaultPromptData } = useQuery({
    queryKey: ['defaultSystemPrompt'],
    queryFn: () => api.getDefaultSystemPrompt(),
    enabled: enabled && promptEditorOpen,
    staleTime: Infinity,
  })

  const { data: installedModels = [], isLoading: isLoadingModels } = useQuery({
    queryKey: ['installedModels'],
    queryFn: () => api.getInstalledModels(),
    enabled,
    select: (data) => data || [],
  })

  const { data: chatSuggestions, isLoading: chatSuggestionsLoading } = useQuery<string[]>({
    queryKey: ['chatSuggestions'],
    queryFn: async ({ signal }) => {
      const res = await api.getChatSuggestions(signal)
      return res ?? []
    },
    enabled: suggestionsEnabled && !activeSessionId,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  })

  const rewriteModelAvailable = useMemo(() => {
    return installedModels.some(model => model.name === DEFAULT_QUERY_REWRITE_MODEL)
  }, [installedModels])

  const currentPrompt: string =
    typeof systemPromptSetting?.value === 'string' ? systemPromptSetting.value : ''

  const savePromptMutation = useMutation({
    mutationFn: async (next: string) => {
      await api.updateSetting('ai.systemPrompt', next)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-setting', 'ai.systemPrompt'] })
      addNotification({ type: 'success', message: 'System prompt saved' })
    },
    onError: () => {
      addNotification({ type: 'error', message: 'Failed to save system prompt' })
    },
  })

  const deleteAllSessionsMutation = useMutation({
    mutationFn: () => api.deleteAllChatSessions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chatSessions'] })
      setActiveSessionId(null)
      setMessages([])
      closeAllModals()
    },
  })

  const chatMutation = useMutation({
    mutationFn: (request: {
      model: string
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
      sessionId?: number
    }) => api.sendChatMessage({ ...request, stream: false }),
    onSuccess: async (data) => {
      if (!data || !activeSessionId) {
        throw new Error('No response from Ollama')
      }

      // Add assistant message
      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        role: 'assistant',
        content: data.message?.content || 'Sorry, I could not generate a response.',
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, assistantMessage])

      // Refresh sessions to pick up backend-persisted messages and title
      queryClient.invalidateQueries({ queryKey: ['chatSessions'] })
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['chatSessions'] }), 3000)
    },
    onError: (error) => {
      console.error('Error sending message:', error)
      const errorMessage: ChatMessage = {
        id: `msg-${Date.now()}-error`,
        role: 'assistant',
        content: 'Sorry, there was an error processing your request. Please try again.',
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, errorMessage])
    },
  })

  // Set default model: prefer last used model, fall back to first installed if last model not available
  useEffect(() => {
    if (installedModels.length > 0 && !selectedModel) {
      const lastModel = lastModelSetting?.value as string | undefined
      if (lastModel && installedModels.some((m) => m.name === lastModel)) {
        setSelectedModel(lastModel)
      } else {
        setSelectedModel(installedModels[0].name)
      }
    }
  }, [installedModels, selectedModel, lastModelSetting])

  // Persist model selection
  useEffect(() => {
    if (selectedModel) {
      api.updateSetting('chat.lastModel', selectedModel)
    }
  }, [selectedModel])
  // Persist thinking toggle
  useEffect(() => {
    try {
      localStorage.setItem('nomad:chat-thinking-enabled', String(thinkingEnabled))
    } catch {}
  }, [thinkingEnabled])

  useEffect(() => {
    if (!promptEditorOpen) return
    if (currentPrompt) {
      setPromptDraft(currentPrompt)
      return
    }
    const fallback = defaultPromptData?.prompt
    if (fallback) setPromptDraft(fallback)
  }, [promptEditorOpen, currentPrompt, defaultPromptData?.prompt])

  const handleNewChat = useCallback(() => {
    // Just clear the active session and messages - don't create a session yet
    setActiveSessionId(null)
    setMessages([])
  }, [])

  const handleClearHistory = useCallback(() => {
    openModal(
      <StyledModal
        title="Clear All Chat History?"
        onConfirm={() => deleteAllSessionsMutation.mutate()}
        onCancel={closeAllModals}
        open={true}
        confirmText="Clear All"
        cancelText="Cancel"
        confirmVariant="danger"
      >
        <p className="text-text-primary">
          Are you sure you want to delete all chat sessions? This action cannot be undone and all
          conversations will be permanently deleted.
        </p>
      </StyledModal>,
      'confirm-clear-history-modal'
    )
  }, [openModal, closeAllModals, deleteAllSessionsMutation])

  const handleSessionSelect = useCallback(
    async (sessionId: string) => {
      // Cancel any ongoing suggestions fetch
      queryClient.cancelQueries({ queryKey: ['chatSuggestions'] })

      setActiveSessionId(sessionId)
      // Load messages for this session
      const sessionData = await api.getChatSession(sessionId)
      if (sessionData?.messages) {
        setMessages(
          sessionData.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.timestamp),
          }))
        )
      } else {
        setMessages([])
      }

      // Set the model to match the session's model if it exists and is available
      if (sessionData?.model) {
        setSelectedModel(sessionData.model)
      }
    },
    [installedModels, queryClient]
  )

  const handleSendMessage = useCallback(
    async (content: string) => {
      let sessionId = activeSessionId

      // Create a new session if none exists
      if (!sessionId) {
        const newSession = await api.createChatSession('New Chat', selectedModel)
        if (newSession) {
          sessionId = newSession.id
          setActiveSessionId(sessionId)
          queryClient.invalidateQueries({ queryKey: ['chatSessions'] })
        } else {
          return
        }
      }

      // Add user message to UI
      const userMessage: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, userMessage])

      const chatMessages = [
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content },
      ]

      if (streamingEnabled !== false) {
        // Streaming path
        const abortController = new AbortController()
        streamAbortRef.current = abortController

        setIsStreamingResponse(true)

        const assistantMsgId = `msg-${Date.now()}-assistant`
        let isFirstChunk = true
        let fullContent = ''
        let thinkingContent = ''
        let isThinkingPhase = true
        let thinkingStartTime: number | null = null
        let thinkingDuration: number | null = null

        try {
          await api.streamChatMessage(
            {
              model: selectedModel || 'llama3.2',
              messages: chatMessages,
              stream: true,
              think: thinkingEnabled ? true : undefined,
              sessionId: sessionId ? Number(sessionId) : undefined,
            },
            (chunkContent, chunkThinking, done) => {
              if (chunkThinking.length > 0 && thinkingStartTime === null) {
                thinkingStartTime = Date.now()
              }
              if (isFirstChunk) {
                isFirstChunk = false
                setIsStreamingResponse(false)
                setMessages((prev) => [
                  ...prev,
                  {
                    id: assistantMsgId,
                    role: 'assistant',
                    content: chunkContent,
                    thinking: chunkThinking,
                    timestamp: new Date(),
                    isStreaming: true,
                    isThinking: chunkThinking.length > 0 && chunkContent.length === 0,
                    thinkingDuration: undefined,
                  },
                ])
              } else {
                if (isThinkingPhase && chunkContent.length > 0) {
                  isThinkingPhase = false
                  if (thinkingStartTime !== null) {
                    thinkingDuration = Math.max(1, Math.round((Date.now() - thinkingStartTime) / 1000))
                  }
                }
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? {
                        ...m,
                        content: m.content + chunkContent,
                        thinking: (m.thinking ?? '') + chunkThinking,
                        isStreaming: !done,
                        isThinking: isThinkingPhase,
                        thinkingDuration: thinkingDuration ?? undefined,
                      }
                      : m
                  )
                )
              }
              fullContent += chunkContent
              thinkingContent += chunkThinking
            },
            abortController.signal
          )
        } catch (error: any) {
          if (error?.name !== 'AbortError') {
            setMessages((prev) => {
              const hasAssistantMsg = prev.some((m) => m.id === assistantMsgId)
              if (hasAssistantMsg) {
                return prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, isStreaming: false } : m
                )
              }
              return [
                ...prev,
                {
                  id: assistantMsgId,
                  role: 'assistant',
                  content: 'Sorry, there was an error processing your request. Please try again.',
                  timestamp: new Date(),
                },
              ]
            })
          }
        } finally {
          setIsStreamingResponse(false)
          streamAbortRef.current = null
        }

        if (fullContent && sessionId) {
          // Ensure the streaming cursor is removed
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, isStreaming: false } : m
            )
          )

          // Refresh sessions to pick up backend-persisted messages and title
          queryClient.invalidateQueries({ queryKey: ['chatSessions'] })
          setTimeout(() => queryClient.invalidateQueries({ queryKey: ['chatSessions'] }), 3000)
        }
      } else {
        // Non-streaming (legacy) path
        chatMutation.mutate({
          model: selectedModel || 'llama3.2',
          messages: chatMessages,
          think: thinkingEnabled ? true : undefined,
          sessionId: sessionId ? Number(sessionId) : undefined,
        })
      }
    },
    [activeSessionId, messages, selectedModel, chatMutation, queryClient, streamingEnabled, thinkingEnabled]
  )

  const handleStopMessage = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort()
      streamAbortRef.current = null
      addNotification({ type: 'success', message: 'Response stopped' })
    }
    setIsStreamingResponse(false)
  }, [addNotification])

  const handleModelChange = useCallback(
    async (nextModel: string) => {
      setSelectedModel(nextModel)

      if (!activeSessionId) {
        return
      }

      try {
        await api.updateChatSession(activeSessionId, { model: nextModel })
        queryClient.invalidateQueries({ queryKey: ['chatSessions'] })
      } catch (error) {
        addNotification({ type: 'error', message: 'Failed to save chat model selection' })
      }
    },
    [activeSessionId, queryClient, addNotification]
  )

  const promptDirty = useMemo(() => {
    // Treat an unset custom prompt as equivalent to default prompt (when we have it).
    const effectiveCurrent = currentPrompt || defaultPromptData?.prompt || ''
    return promptDraft !== effectiveCurrent
  }, [promptDraft, currentPrompt, defaultPromptData?.prompt])

  return (
    <div
      className={classNames(
        'flex border border-border-subtle overflow-hidden shadow-sm w-full',
        isInModal ? 'h-full rounded-lg' : 'h-screen'
      )}
    >
      <ChatSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSessionSelect={handleSessionSelect}
        onNewChat={handleNewChat}
        onClearHistory={handleClearHistory}
        isInModal={isInModal}
      />
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-6 py-3 border-b border-border-subtle bg-surface-secondary flex items-center justify-between h-[75px] flex-shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">
            {activeSession?.title || 'New Chat'}
          </h2>
          <div className="flex items-center gap-4">
            {remoteOllamaUrlSetting?.value && (
              <span
                className={classNames(
                  'text-xs rounded px-2 py-1 font-medium',
                  remoteStatus?.connected === false
                    ? 'text-red-700 bg-red-50 border border-red-200'
                    : 'text-green-700 bg-green-50 border border-green-200'
                )}
              >
                {remoteStatus?.connected === false ? 'Remote Disconnected' : 'Remote Connected'}
              </span>
            )}
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">Thinking</span>
              <button
                type="button"
                role="switch"
                aria-checked={thinkingEnabled}
                onClick={() => setThinkingEnabled(!thinkingEnabled)}
                className={classNames(
                  'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent',
                  'transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-desert-green focus:ring-offset-2',
                  thinkingEnabled ? 'bg-desert-green' : 'bg-border-default'
                )}
              >
                <span
                  className={classNames(
                    'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0',
                    'transition duration-200 ease-in-out',
                    thinkingEnabled ? 'translate-x-4' : 'translate-x-0'
                  )}
                />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="model-select" className="text-sm text-text-secondary">
                Model:
              </label>
              {isLoadingModels ? (
                <div className="text-sm text-text-muted">Loading models...</div>
              ) : installedModels.length === 0 ? (
                <div className="text-sm text-red-600">No models installed</div>
              ) : (
                <select
                  id="model-select"
                  value={selectedModel}
                  onChange={(e) => void handleModelChange(e.target.value)}
                  className="px-3 py-1.5 border border-border-default rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-desert-green focus:border-transparent bg-surface-primary"
                >
                  {installedModels.map((model) => (
                    <option key={model.name} value={model.name}>
                      {model.name}{model.size > 0 ? ` (${formatBytes(model.size)})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <button
              type="button"
              onClick={() => setPromptEditorOpen((v) => !v)}
              className={classNames(
                'px-3 py-1.5 border rounded-lg text-sm transition-colors',
                promptEditorOpen
                  ? 'border-desert-green bg-surface-primary text-text-primary'
                  : 'border-border-default bg-surface-primary text-text-secondary hover:bg-surface-secondary'
              )}
            >
              Prompt
            </button>
            {isInModal && (
              <button
                onClick={() => {
                  if (onClose) {
                    onClose()
                  }
                }}
                className="rounded-lg hover:bg-surface-secondary transition-colors"
              >
                <IconX className="h-6 w-6 text-text-muted" />
              </button>
            )}
          </div>
        </div>
        {promptEditorOpen && (
          <div className="border-b border-border-subtle bg-surface-primary px-6 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <div className="text-sm font-medium text-text-primary">System Prompt</div>
                  <div className="text-xs text-text-muted">
                    Used for all chats (saved as <span className="font-mono">ai.systemPrompt</span>)
                  </div>
                </div>
                <textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  rows={8}
                  className="w-full rounded-lg border border-border-default px-3 py-2 text-sm bg-surface-primary focus:outline-none focus:ring-2 focus:ring-desert-green focus:border-transparent font-mono"
                  placeholder="Enter a custom system prompt…"
                />
                <div className="mt-2 text-xs text-text-muted">
                  Tip: Keep this stable. Use the chat messages for per-conversation context.
                </div>
              </div>
              <div className="flex flex-col gap-2 w-[180px] flex-shrink-0">
                <button
                  type="button"
                  disabled={!promptDirty || savePromptMutation.isPending}
                  onClick={() => savePromptMutation.mutate(promptDraft)}
                  className={classNames(
                    'px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    !promptDirty || savePromptMutation.isPending
                      ? 'bg-border-default text-text-muted cursor-not-allowed'
                      : 'bg-desert-green text-white hover:bg-desert-green/90'
                  )}
                >
                  {savePromptMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  disabled={!defaultPromptData?.prompt}
                  onClick={() => setPromptDraft(defaultPromptData?.prompt ?? '')}
                  className={classNames(
                    'px-3 py-2 rounded-lg text-sm border transition-colors',
                    defaultPromptData?.prompt
                      ? 'border-border-default text-text-secondary hover:bg-surface-secondary'
                      : 'border-border-default text-text-muted cursor-not-allowed'
                  )}
                >
                  Reset to Default
                </button>
                <button
                  type="button"
                  onClick={() => setPromptEditorOpen(false)}
                  className="px-3 py-2 rounded-lg text-sm border border-border-default text-text-secondary hover:bg-surface-secondary transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
        <ChatInterface
          messages={messages}
          onSendMessage={handleSendMessage}
          onStopMessage={handleStopMessage}
          isLoading={isStreamingResponse || chatMutation.isPending}
          chatSuggestions={chatSuggestions}
          chatSuggestionsEnabled={suggestionsEnabled}
          chatSuggestionsLoading={chatSuggestionsLoading}
          rewriteModelAvailable={rewriteModelAvailable}
        />
      </div>
    </div>
  )
}
