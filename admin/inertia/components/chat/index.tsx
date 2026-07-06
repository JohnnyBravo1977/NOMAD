import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { usePage } from '@inertiajs/react'
import { Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react'
import ChatSidebar from './ChatSidebar'
import ChatInterface from './ChatInterface'
import api from '~/lib/api'
import { formatBytes } from '~/lib/util'
import { useModals } from '~/context/ModalContext'
import { ChatAttachment, ChatMessage } from '../../../types/chat'
import classNames from '~/lib/classNames'
import { IconChevronRight, IconExternalLink, IconX } from '@tabler/icons-react'
import { DEFAULT_QUERY_REWRITE_MODEL } from '../../../constants/ollama'
import { useSystemSetting } from '~/hooks/useSystemSetting'
import { useNotifications } from '~/context/NotificationContext'
import { buildSpeechInstruction, resolveSpeechDelivery } from '~/lib/speechDelivery'
import StyledModal from '../StyledModal'
import StyledButton from '../StyledButton'

type VoiceCharacter = {
  id: string
  name: string
  engine: 'voice_design' | 'voice_clone'
  gender?: 'male' | 'female'
  description?: string
  speakingStyle?: string
  referenceText?: string
  referenceAudioName?: string
  createdAt: string
  updatedAt: string
}

const DELIVERY_OPTIONS = [
  { id: 'auto', label: 'Auto', description: 'Let the wording drive the natural tone.' },
  { id: 'warm', label: 'Warm', description: 'Friendly, reassuring, a little softer.' },
  { id: 'calm', label: 'Calm', description: 'Steady, even, and relaxed.' },
  { id: 'cheerful', label: 'Cheerful', description: 'Upbeat, bright, and positive.' },
  { id: 'gentle', label: 'Gentle', description: 'Light, tender, and comforting.' },
  { id: 'serious', label: 'Serious', description: 'Measured, focused, and direct.' },
  { id: 'dramatic', label: 'Dramatic', description: 'More intensity and theatrical emphasis.' },
  { id: 'excited', label: 'Excited', description: 'More energy, enthusiasm, and lift.' },
] as const

type DeliveryOptionId = (typeof DELIVERY_OPTIONS)[number]['id']

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
  const { userSpace, aiAssistantName } = usePage<{
    aiAssistantName: string
    userSpace?: {
      canAccessAdminTools: boolean
      user: { displayName: string; role: 'admin' | 'user' }
    } | null
  }>().props
  const canAccessAdminTools = !!userSpace?.canAccessAdminTools
  const queryClient = useQueryClient()
  const { openModal, closeAllModals } = useModals()
  const { addNotification } = useNotifications()
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [isStreamingResponse, setIsStreamingResponse] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [voicePanelOpen, setVoicePanelOpen] = useState(false)
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const streamAbortRef = useRef<AbortController | null>(null)
  const [thinkingEnabled, setThinkingEnabled] = useState(() => {
    try {
      return localStorage.getItem('nomad:chat-thinking-enabled') === 'true'
    } catch {
      return false
    }
  })
  const [autoSpeakReplies, setAutoSpeakReplies] = useState(() => {
    try {
      return localStorage.getItem('nomad:chat-auto-speak-replies') === 'true'
    } catch {
      return false
    }
  })
  const [selectedVoiceId, setSelectedVoiceId] = useState(() => {
    try {
      return localStorage.getItem('nomad:chat-selected-voice') || ''
    } catch {
      return ''
    }
  })
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<DeliveryOptionId>(() => {
    try {
      const saved = localStorage.getItem('nomad:chat-delivery') as DeliveryOptionId | null
      return DELIVERY_OPTIONS.some((option) => option.id === saved) ? saved! : 'auto'
    } catch {
      return 'auto'
    }
  })
  const [voicePreviewLoading, setVoicePreviewLoading] = useState(false)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewAudioUrlRef = useRef<string | null>(null)
  const previewAudioContextRef = useRef<AudioContext | null>(null)
  const previewAudioSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const previewSequenceRef = useRef(0)

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

  const { data: lastModelSetting } = useSystemSetting({
    key: 'chat.lastModel',
    enabled: enabled && canAccessAdminTools,
  })
  const { data: remoteOllamaUrlSetting } = useSystemSetting({
    key: 'ai.remoteOllamaUrl',
    enabled: enabled && canAccessAdminTools,
  })
  const { data: systemPromptSetting } = useSystemSetting({
    key: 'ai.systemPrompt',
    enabled: enabled && canAccessAdminTools,
  })
  const [promptEditorOpen, setPromptEditorOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')

  const { data: remoteStatus } = useQuery({
    queryKey: ['remoteOllamaStatus'],
    queryFn: () => api.getRemoteOllamaStatus(),
    enabled: enabled && canAccessAdminTools && !!remoteOllamaUrlSetting?.value,
    refetchInterval: 15000,
  })

  const { data: installedModels = [], isLoading: isLoadingModels } = useQuery({
    queryKey: ['installedModels'],
    queryFn: () => api.getInstalledModels(),
    enabled,
    select: (data) => data || [],
  })

  const { data: comfyVoices } = useQuery({
    queryKey: ['comfyVoices'],
    queryFn: () => api.getComfyVoices(),
    enabled,
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
    return installedModels.some((model) => model.name === DEFAULT_QUERY_REWRITE_MODEL)
  }, [installedModels])

  const currentPrompt: string =
    typeof systemPromptSetting?.value === 'string' ? systemPromptSetting.value : ''

  const savePromptMutation = useMutation({
    mutationFn: async (next: string) => {
      const res = await api.updateSettingStrict('ai.systemPrompt', next)
      if (!res?.success) {
        throw new Error(res?.message || 'Failed to save chat style')
      }
      return res
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['system-setting', 'ai.systemPrompt'] })
      addNotification({
        type: 'success',
        message: res?.gatePending
          ? 'Chat style saved. Safety check is running in the background.'
          : 'Chat style saved',
      })
    },
    onError: (error: any) => {
      const message =
        typeof error?.response?.data?.message === 'string'
          ? error.response.data.message
          : error instanceof Error
            ? error.message
            : 'Failed to save chat style'
      addNotification({ type: 'error', message })
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
      messages: Array<{
        role: 'system' | 'user' | 'assistant'
        content: string
        attachments?: ChatAttachment[]
      }>
      sessionId?: number
    }) => api.sendChatMessage({ ...request, stream: false }),
    onSuccess: async (data) => {
      if (!data || !activeSessionId) {
        throw new Error('No response from Ollama')
      }

      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        role: 'assistant',
        content: data.message?.content || 'Sorry, I could not generate a response.',
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, assistantMessage])
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

  useEffect(() => {
    if (selectedModel && canAccessAdminTools) {
      api.updateSetting('chat.lastModel', selectedModel)
    }
  }, [selectedModel, canAccessAdminTools])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mediaQuery = window.matchMedia('(max-width: 1400px)')
    const updateViewport = () => {
      const touchCapable =
        'ontouchstart' in window ||
        (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
      const narrowViewport = mediaQuery.matches || window.innerWidth <= 1400
      const mobileLikeUserAgent =
        typeof navigator !== 'undefined' &&
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
      const coarsePointer =
        typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches

      setIsMobileViewport(
        Boolean(mobileLikeUserAgent || (touchCapable && (narrowViewport || coarsePointer)))
      )
    }

    updateViewport()
    window.addEventListener('resize', updateViewport)
    mediaQuery.addEventListener('change', updateViewport)
    return () => {
      window.removeEventListener('resize', updateViewport)
      mediaQuery.removeEventListener('change', updateViewport)
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('nomad:chat-thinking-enabled', String(thinkingEnabled))
    } catch {}
  }, [thinkingEnabled])

  useEffect(() => {
    try {
      localStorage.setItem('nomad:chat-auto-speak-replies', String(autoSpeakReplies))
    } catch {}
  }, [autoSpeakReplies])

  useEffect(() => {
    try {
      if (selectedVoiceId) {
        localStorage.setItem('nomad:chat-selected-voice', selectedVoiceId)
      }
    } catch {}
  }, [selectedVoiceId])

  useEffect(() => {
    try {
      localStorage.setItem('nomad:chat-delivery', selectedDeliveryId)
    } catch {}
  }, [selectedDeliveryId])

  useEffect(() => {
    return () => {
      previewSequenceRef.current += 1
      if (previewAudioSourceRef.current) {
        try {
          previewAudioSourceRef.current.stop()
        } catch {}
        previewAudioSourceRef.current.disconnect()
        previewAudioSourceRef.current = null
      }
      if (previewAudioRef.current) {
        previewAudioRef.current.pause()
        previewAudioRef.current.src = ''
      }
      if (previewAudioUrlRef.current) {
        URL.revokeObjectURL(previewAudioUrlRef.current)
      }
      if (previewAudioContextRef.current) {
        void previewAudioContextRef.current.close().catch(() => {})
        previewAudioContextRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const defaultSpeaker = comfyVoices?.status?.defaultSpeaker
    if (!defaultSpeaker) return

    const speakerOptions = new Set((comfyVoices?.status?.speakers || []).map((speaker) => `speaker:${speaker}`))
    const characterOptions = new Set((comfyVoices?.characters || []).map((character) => `character:${character.id}`))
    const allOptions = new Set([...speakerOptions, ...characterOptions])
    const storedVoiceId =
      typeof window !== 'undefined' ? window.localStorage.getItem('nomad:chat-selected-voice') || '' : ''

    if (storedVoiceId && allOptions.has(storedVoiceId) && storedVoiceId !== selectedVoiceId) {
      setSelectedVoiceId(storedVoiceId)
      return
    }

    if (!selectedVoiceId || !allOptions.has(selectedVoiceId)) {
      setSelectedVoiceId(`speaker:${defaultSpeaker}`)
    }
  }, [comfyVoices, selectedVoiceId])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const syncSelectedVoiceFromStorage = () => {
      const stored = window.localStorage.getItem('nomad:chat-selected-voice') || ''
      if (stored && stored !== selectedVoiceId) {
        setSelectedVoiceId(stored)
      }
    }

    window.addEventListener('focus', syncSelectedVoiceFromStorage)
    window.addEventListener('storage', syncSelectedVoiceFromStorage)
    document.addEventListener('visibilitychange', syncSelectedVoiceFromStorage)

    return () => {
      window.removeEventListener('focus', syncSelectedVoiceFromStorage)
      window.removeEventListener('storage', syncSelectedVoiceFromStorage)
      document.removeEventListener('visibilitychange', syncSelectedVoiceFromStorage)
    }
  }, [selectedVoiceId])

  useEffect(() => {
    if (!promptEditorOpen) return
    setPromptDraft(currentPrompt)
  }, [promptEditorOpen, currentPrompt])

  const handleNewChat = useCallback(() => {
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
      queryClient.cancelQueries({ queryKey: ['chatSuggestions'] })

      setActiveSessionId(sessionId)
      const sessionData = await api.getChatSession(sessionId)
      if (sessionData?.messages) {
          setMessages(
            sessionData.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              attachments: m.attachments || [],
              timestamp: new Date(m.timestamp),
            }))
          )
      } else {
        setMessages([])
      }

      if (sessionData?.model) {
        setSelectedModel(sessionData.model)
      }
    },
    [queryClient]
  )

  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false)
  }, [])

  const handleSendMessage = useCallback(
    async ({ content, attachments = [] }: { content: string; attachments?: ChatAttachment[] }) => {
      let sessionId = activeSessionId

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

      const userMessage: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        attachments,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, userMessage])

      const chatMessages = [
        ...messages.map((m) => ({ role: m.role, content: m.content, attachments: m.attachments })),
        { role: 'user' as const, content, attachments },
      ]

      if (streamingEnabled !== false) {
        const abortController = new AbortController()
        streamAbortRef.current = abortController
        setIsStreamingResponse(true)

        const assistantMsgId = `msg-${Date.now()}-assistant`
        let isFirstChunk = true
        let fullContent = ''
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
            },
            abortController.signal
          )
        } catch (error: any) {
          if (error?.name !== 'AbortError') {
            setMessages((prev) => {
              const hasAssistantMsg = prev.some((m) => m.id === assistantMsgId)
              if (hasAssistantMsg) {
                return prev.map((m) => (m.id === assistantMsgId ? { ...m, isStreaming: false } : m))
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
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsgId ? { ...m, isStreaming: false } : m))
          )
          queryClient.invalidateQueries({ queryKey: ['chatSessions'] })
          setTimeout(() => queryClient.invalidateQueries({ queryKey: ['chatSessions'] }), 3000)
        }
      } else {
        chatMutation.mutate({
          model: selectedModel || 'llama3.2',
          messages: chatMessages,
          think: thinkingEnabled ? true : undefined,
          sessionId: sessionId ? Number(sessionId) : undefined,
        })
      }
    },
    [activeSessionId, messages, selectedModel, queryClient, streamingEnabled, thinkingEnabled, chatMutation]
  )

  const handleStopMessage = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort()
      streamAbortRef.current = null
      addNotification({ type: 'success', message: 'Response stopped' })
    }
    setIsStreamingResponse(false)
  }, [addNotification])

  const handleSteerQueuedMessage = useCallback(
    (message: string) => {
      handleStopMessage()
      setTimeout(() => void handleSendMessage(message), 75)
    },
    [handleStopMessage, handleSendMessage]
  )

  const handleModelChange = useCallback(
    async (nextModel: string) => {
      setSelectedModel(nextModel)

      if (!activeSessionId) {
        return
      }

      try {
        await api.updateChatSession(activeSessionId, { model: nextModel })
        queryClient.invalidateQueries({ queryKey: ['chatSessions'] })
      } catch {
        addNotification({ type: 'error', message: 'Failed to save chat model selection' })
      }
    },
    [activeSessionId, queryClient, addNotification]
  )

  const promptDirty = useMemo(() => promptDraft !== currentPrompt, [promptDraft, currentPrompt])
  const voiceCharacters: VoiceCharacter[] = comfyVoices?.characters || []
  const speakerOptions = comfyVoices?.status?.speakers || []
  const selectedCharacter = useMemo(
    () =>
      selectedVoiceId.startsWith('character:')
        ? voiceCharacters.find((entry) => entry.id === selectedVoiceId.replace(/^character:/, '')) || null
        : null,
    [selectedVoiceId, voiceCharacters]
  )
  const selectedSpeaker = useMemo(
    () => (selectedVoiceId.startsWith('speaker:') ? selectedVoiceId.replace(/^speaker:/, '') : ''),
    [selectedVoiceId]
  )
  const selectedVoiceSummary = useMemo(() => {
    if (selectedCharacter) {
      return {
        title: selectedCharacter.name,
        subtitle:
          selectedCharacter.engine === 'voice_clone'
            ? 'Saved cloned character'
            : `Saved ${selectedCharacter.gender} character`,
        description:
          selectedCharacter.engine === 'voice_clone'
            ? selectedCharacter.speakingStyle || selectedCharacter.referenceText || 'Saved cloned voice reference'
            : selectedCharacter.speakingStyle || selectedCharacter.description || 'Saved designed voice character',
      }
    }

    const fallbackSpeaker = selectedSpeaker || comfyVoices?.status?.defaultSpeaker || 'Ryan'
    return {
      title: fallbackSpeaker,
      subtitle: 'Built-in speaker',
      description: 'Uses the built-in Qwen custom voice speaker path for quick playback.',
    }
  }, [selectedCharacter, selectedSpeaker, comfyVoices])
  const selectedDelivery = useMemo(
    () => DELIVERY_OPTIONS.find((option) => option.id === selectedDeliveryId) || DELIVERY_OPTIONS[0],
    [selectedDeliveryId]
  )

  const stopVoicePreview = useCallback(() => {
    previewSequenceRef.current += 1
    if (previewAudioSourceRef.current) {
      try {
        previewAudioSourceRef.current.stop()
      } catch {}
      previewAudioSourceRef.current.disconnect()
      previewAudioSourceRef.current = null
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.pause()
      previewAudioRef.current.currentTime = 0
      previewAudioRef.current.src = ''
    }
    if (previewAudioUrlRef.current) {
      URL.revokeObjectURL(previewAudioUrlRef.current)
      previewAudioUrlRef.current = null
    }
    setVoicePreviewLoading(false)
  }, [])

  const ensurePreviewAudioContext = useCallback(async () => {
    if (typeof window === 'undefined') return null
    const AudioContextCtor =
      window.AudioContext || ((window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null)
    if (!AudioContextCtor) return null

    if (!previewAudioContextRef.current) {
      previewAudioContextRef.current = new AudioContextCtor()
    }

    if (previewAudioContextRef.current.state === 'suspended') {
      await previewAudioContextRef.current.resume()
    }

    return previewAudioContextRef.current
  }, [])

  const playPreviewBlob = useCallback(
    async (blob: Blob) => {
      stopVoicePreview()
      const sequenceId = previewSequenceRef.current
      const context = await ensurePreviewAudioContext()

      if (context) {
        try {
          const decoded = await context.decodeAudioData((await blob.arrayBuffer()).slice(0))
          const source = context.createBufferSource()
          source.buffer = decoded
          source.connect(context.destination)
          previewAudioSourceRef.current = source
          setVoicePreviewLoading(false)
          await new Promise<void>((resolve) => {
            source.onended = () => {
              if (previewAudioSourceRef.current === source) {
                previewAudioSourceRef.current.disconnect()
                previewAudioSourceRef.current = null
              }
              if (previewSequenceRef.current === sequenceId) {
                setVoicePreviewLoading(false)
              }
              resolve()
            }
            source.start(0)
          })
          return
        } catch (error) {
          console.warn('Chat voice preview Web Audio fallback engaged:', error)
        }
      }

      const url = URL.createObjectURL(blob)
      previewAudioUrlRef.current = url
      const audio = previewAudioRef.current || new Audio()
      previewAudioRef.current = audio
      audio.preload = 'auto'
      audio.setAttribute('playsinline', 'true')
      audio.src = url
      audio.onended = () => {
        if (previewSequenceRef.current === sequenceId) {
          setVoicePreviewLoading(false)
        }
      }
      audio.onerror = () => {
        stopVoicePreview()
        addNotification({ type: 'error', message: 'Voice preview playback failed.' })
      }
      setVoicePreviewLoading(false)
      try {
        await audio.play()
      } catch (error) {
        stopVoicePreview()
        addNotification({
          type: 'error',
          message: error instanceof Error ? `Voice preview playback failed: ${error.message}` : 'Voice preview playback failed.',
        })
      }
    },
    [addNotification, ensurePreviewAudioContext, stopVoicePreview]
  )

  const handlePreviewVoice = useCallback(async () => {
    const selectedCharacter = selectedVoiceId.startsWith('character:')
      ? voiceCharacters.find((entry) => entry.id === selectedVoiceId.replace(/^character:/, ''))
      : null
    const selectedSpeaker = selectedVoiceId.startsWith('speaker:')
      ? selectedVoiceId.replace(/^speaker:/, '')
      : comfyVoices?.status?.defaultSpeaker || 'Ryan'

    const previewText = `Hello, I'm ${aiAssistantName}.`
    const resolvedDelivery = resolveSpeechDelivery(selectedDeliveryId, previewText)
    const speakingInstruction = buildSpeechInstruction(selectedCharacter?.speakingStyle, resolvedDelivery)

    setVoicePreviewLoading(true)
    try {
      const cloneLike = selectedCharacter?.engine === 'voice_clone'
      const blob = await api.synthesizeComfySpeech({
        text: previewText,
        engine:
          selectedCharacter?.engine === 'voice_clone'
            ? 'voice_clone'
            : selectedCharacter
              ? 'voice_design'
              : 'custom_voice',
        characterId: selectedCharacter?.id,
        speaker: selectedCharacter ? undefined : selectedSpeaker,
        gender: selectedCharacter?.engine === 'voice_design' ? selectedCharacter.gender : undefined,
        description:
          selectedCharacter?.engine === 'voice_design' ? selectedCharacter.description : undefined,
        delivery: cloneLike ? undefined : resolvedDelivery,
        instruct: speakingInstruction,
        language: 'English',
      })

      await playPreviewBlob(blob)
    } catch (error) {
      setVoicePreviewLoading(false)
      addNotification({
        type: 'error',
        message: error instanceof Error ? error.message : 'Voice preview failed.',
      })
    }
  }, [
    selectedVoiceId,
    voiceCharacters,
    comfyVoices,
    playPreviewBlob,
    addNotification,
    selectedDeliveryId,
    aiAssistantName,
  ])

  return (
    <div
      className={classNames(
        'relative flex border border-border-subtle overflow-hidden shadow-sm w-full',
        isInModal ? 'h-full rounded-none sm:rounded-lg' : 'h-[100dvh]'
      )}
    >
      {isMobileViewport && !mobileSidebarOpen && (
        <button
          type="button"
          onClick={() => setMobileSidebarOpen(true)}
          className="fixed left-0 top-[74vh] z-[70] -translate-y-1/2 rounded-r-2xl border border-l-0 border-desert-green/30 bg-desert-green text-white px-3 py-4 shadow-xl"
          aria-label="Open chat sessions"
        >
          <div className="flex flex-col items-center gap-1.5">
            <IconChevronRight className="h-5 w-5" />
            <span className="text-[11px] font-semibold tracking-[0.18em] [writing-mode:vertical-rl] rotate-180">
              Chats
            </span>
          </div>
        </button>
      )}
      <Dialog
        open={isMobileViewport && mobileSidebarOpen}
        onClose={setMobileSidebarOpen}
        className="relative z-40"
      >
        <DialogBackdrop className="fixed inset-0 bg-black/30 backdrop-blur-sm" />
        <div className="fixed inset-y-0 left-0 flex max-w-full">
          <DialogPanel className="h-full w-[84vw] max-w-sm">
            <ChatSidebar
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSessionSelect={handleSessionSelect}
              onNewChat={handleNewChat}
              onClearHistory={handleClearHistory}
              isInModal={isInModal}
              onNavigate={closeMobileSidebar}
              onOpenVoicePanel={() => setVoicePanelOpen(true)}
            />
          </DialogPanel>
        </div>
      </Dialog>
      <ChatSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSessionSelect={handleSessionSelect}
        onNewChat={handleNewChat}
        onClearHistory={handleClearHistory}
        isInModal={isInModal}
        className={classNames('md:w-64 lg:w-72', isMobileViewport ? 'hidden' : 'flex')}
        onOpenVoicePanel={() => setVoicePanelOpen(true)}
      />
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 md:px-6 py-3 border-b border-border-subtle bg-surface-secondary flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:min-h-[75px] flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-base md:text-lg font-semibold text-text-primary truncate">
              {activeSession?.title || 'New Chat'}
            </h2>
          </div>
          {!isMobileViewport && (
            <div className="flex flex-wrap items-center gap-4">
              <div className="text-xs md:text-sm text-text-secondary rounded-full bg-surface-primary px-3 py-1.5 border border-border-subtle">
                {userSpace?.user.displayName} · {userSpace?.user.role}
              </div>
              {canAccessAdminTools && remoteOllamaUrlSetting?.value && (
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
              <div className="flex items-center gap-2 rounded-full bg-surface-primary px-3 py-1.5 border border-border-subtle">
                <span className="text-xs text-text-secondary hidden sm:inline">Thinking</span>
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
              <div className="flex items-center gap-2 rounded-full bg-surface-primary px-3 py-1.5 border border-border-subtle">
                <label htmlFor="model-select" className="text-xs md:text-sm text-text-secondary">
                  Model:
                </label>
                {isLoadingModels ? (
                  <div className="text-xs md:text-sm text-text-muted">Loading...</div>
                ) : installedModels.length === 0 ? (
                  <div className="text-xs md:text-sm text-red-600">No models</div>
                ) : (
                  <select
                    id="model-select"
                    value={selectedModel}
                    onChange={(e) => void handleModelChange(e.target.value)}
                    className="max-w-[10rem] md:max-w-none px-2 py-1 border border-border-default rounded-lg text-xs md:text-sm focus:outline-none focus:ring-2 focus:ring-desert-green focus:border-transparent bg-surface-primary"
                  >
                    {installedModels.map((model) => (
                      <option key={model.name} value={model.name}>
                        {model.name}
                        {model.size > 0 ? ` (${formatBytes(model.size)})` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <button
                type="button"
                onClick={() => canAccessAdminTools && setPromptEditorOpen((v) => !v)}
                disabled={!canAccessAdminTools}
                className={classNames(
                  'px-3 py-1.5 border rounded-lg text-xs md:text-sm transition-colors',
                  promptEditorOpen
                    ? 'border-desert-green bg-surface-primary text-text-primary'
                    : 'border-border-default bg-surface-primary text-text-secondary hover:bg-surface-secondary',
                  !canAccessAdminTools && 'cursor-not-allowed opacity-50 hover:bg-surface-primary'
                )}
              >
                Style
              </button>
            </div>
          )}
          {isMobileViewport && (
            <div className="flex items-center gap-2">
              <div className="text-xs text-text-secondary rounded-full bg-surface-primary px-3 py-1.5 border border-border-subtle">
                {userSpace?.user.displayName}
              </div>
              {isInModal && (
                <button
                  onClick={() => {
                    if (onClose) {
                      onClose()
                    }
                  }}
                  className="rounded-lg border border-border-default bg-surface-primary p-2 hover:bg-surface-secondary transition-colors"
                >
                  <IconX className="h-5 w-5 text-text-muted" />
                </button>
              )}
            </div>
          )}
          {!isMobileViewport && (
            <div className="flex items-center gap-2">
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
          )}
        </div>
        {canAccessAdminTools && promptEditorOpen && (
          <div className="border-b border-border-subtle bg-surface-primary px-4 md:px-6 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <div className="text-sm font-medium text-text-primary">Chat Style</div>
                  <div className="text-xs text-text-muted">
                    Quinn stays Quinn underneath. This just nudges delivery and voice.
                  </div>
                </div>
                <textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  rows={8}
                  className="w-full rounded-lg border border-border-default px-3 py-2 text-sm bg-surface-primary focus:outline-none focus:ring-2 focus:ring-desert-green focus:border-transparent font-mono"
                  placeholder={'Examples:\n- Be a little more direct and concise.\n- Keep things warm and calm.\n- Talk like a pirate, but still be Quinn.\n- Answer with a little rhyme when it fits.'}
                />
                <div className="mt-2 text-xs text-text-muted">
                  Use this to shape tone, detail level, or playful voice. It can add pirate/rhyme flavor without replacing Quinn.
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
          onSteerQueuedMessage={handleSteerQueuedMessage}
          isLoading={isStreamingResponse || chatMutation.isPending}
          chatSuggestions={chatSuggestions}
          chatSuggestionsEnabled={suggestionsEnabled}
          chatSuggestionsLoading={chatSuggestionsLoading}
          rewriteModelAvailable={rewriteModelAvailable}
          canDownloadRewriteModel={canAccessAdminTools}
          autoSpeakReplies={autoSpeakReplies}
          selectedVoiceId={selectedVoiceId}
          selectedDeliveryId={selectedDeliveryId}
          availableSpeakers={speakerOptions}
          voiceCharacters={voiceCharacters}
        />
      </div>
      <StyledModal
        open={voicePanelOpen}
        onClose={() => setVoicePanelOpen(false)}
        onCancel={() => setVoicePanelOpen(false)}
        cancelText="Close"
        title="Voice"
      >
        <div className="space-y-4 text-left">
          <div className="rounded-2xl border border-border-subtle bg-surface-primary shadow-sm overflow-hidden">
            <div className="bg-gradient-to-r from-desert-green via-desert-green to-desert-tan px-4 py-4 text-white">
              <div className="text-lg font-semibold">Voice</div>
              <div className="mt-1 text-sm text-white/85">
                Choose how Quinn sounds in chat without exposing raw workflow controls.
              </div>
            </div>
            <div className="grid gap-3 bg-surface-secondary/70 px-4 py-4 md:grid-cols-2">
              <div className="rounded-xl border border-border-subtle bg-surface-primary px-4 py-3 shadow-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                  Current Voice
                </div>
                <div className="mt-2 text-lg font-bold text-desert-green">
                  {selectedVoiceSummary.title}
                </div>
                <div className="text-xs uppercase tracking-wide text-text-muted">
                  {selectedVoiceSummary.subtitle}
                </div>
              </div>
              <div className="rounded-xl border border-border-subtle bg-surface-primary px-4 py-3 shadow-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                  Delivery
                </div>
                <div className="mt-2 text-lg font-bold text-desert-green">
                  {selectedDelivery.label}
                </div>
                <div className="text-sm text-text-secondary">
                  {selectedDelivery.description}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border-subtle bg-surface-secondary p-4 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-text-primary">Auto Speak Replies</div>
                <div className="text-sm text-text-secondary">
                  Automatically play Quinn’s replies after they finish streaming.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoSpeakReplies}
                onClick={() => setAutoSpeakReplies((value) => !value)}
                className={classNames(
                  'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                  autoSpeakReplies ? 'bg-desert-green' : 'bg-border-default'
                )}
              >
                <span
                  className={classNames(
                    'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition',
                    autoSpeakReplies ? 'translate-x-5' : 'translate-x-0'
                  )}
                />
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-border-subtle bg-surface-secondary p-4 shadow-sm">
            <div className="font-medium text-text-primary">Character Selection</div>
            <div className="mt-1 text-sm text-text-secondary">
              Choose a built-in speaker or one of the saved voice characters from Voice Studio.
            </div>
            <select
              value={selectedVoiceId}
              onChange={(event) => setSelectedVoiceId(event.target.value)}
              className="mt-3 w-full rounded-xl border border-border-default bg-surface-primary px-3 py-3 text-sm shadow-sm"
            >
              <optgroup label="Built-in Speakers">
                {speakerOptions.map((speaker) => (
                  <option key={speaker} value={`speaker:${speaker}`}>
                    {speaker}
                  </option>
                ))}
              </optgroup>
              {voiceCharacters.length > 0 && (
                <optgroup label="Saved Characters">
                  {voiceCharacters.map((character) => (
                    <option key={character.id} value={`character:${character.id}`}>
                      {character.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            <div className="mt-3 rounded-xl border border-border-subtle bg-surface-primary px-4 py-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                Selected Voice
              </div>
              <div className="mt-2 text-base font-semibold text-text-primary">{selectedVoiceSummary.title}</div>
              <div className="text-xs uppercase tracking-wide text-text-muted">
                {selectedVoiceSummary.subtitle}
              </div>
              <div className="mt-2 text-sm text-text-secondary">{selectedVoiceSummary.description}</div>
            </div>

            <div className="mt-4">
              <div className="font-medium text-text-primary">Delivery</div>
              <div className="mt-1 text-sm text-text-secondary">
                Shape the emotional tone without changing the voice identity.
              </div>
              <select
                value={selectedDeliveryId}
                onChange={(event) => setSelectedDeliveryId(event.target.value as DeliveryOptionId)}
                className="mt-3 w-full rounded-xl border border-border-default bg-surface-primary px-3 py-3 text-sm shadow-sm"
              >
                {DELIVERY_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <div className="mt-3 rounded-xl border border-border-subtle bg-surface-primary px-4 py-4 shadow-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                  Selected Delivery
                </div>
                <div className="mt-2 text-base font-semibold text-text-primary">{selectedDelivery.label}</div>
                <div className="mt-2 text-sm text-text-secondary">{selectedDelivery.description}</div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <StyledButton
                size="sm"
                variant="action"
                onClick={() => void handlePreviewVoice()}
                loading={voicePreviewLoading}
              >
                Test Voice
              </StyledButton>
              {previewAudioRef.current && (
                <StyledButton size="sm" variant="outline" onClick={stopVoicePreview}>
                  Stop
                </StyledButton>
              )}
              {canAccessAdminTools && (
                <StyledButton
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setVoicePanelOpen(false)
                    window.location.href = '/voice-settings'
                  }}
                >
                  Open Voice Studio
                </StyledButton>
              )}
            </div>
          </div>

          {canAccessAdminTools && (
            <div className="rounded-2xl border border-dashed border-border-default bg-surface-primary p-4">
              <div className="flex items-center gap-2 text-text-primary">
                <IconExternalLink className="h-4 w-4" />
                <span className="font-medium">Advanced Routing</span>
              </div>
              <div className="mt-1 text-sm text-text-secondary">
                Voice Studio is where admin should create and test new characters. Raw ComfyUI node editing stays out of the normal chat flow on purpose.
              </div>
            </div>
          )}
        </div>
      </StyledModal>
    </div>
  )
}
