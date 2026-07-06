import {
  IconFileTypePdf,
  IconLoader2,
  IconPaperclip,
  IconPlayerStopFilled,
  IconSend,
  IconSteeringWheel,
  IconVolume,
  IconWand,
  IconX,
} from '@tabler/icons-react'
import { useState, useRef, useEffect } from 'react'
import classNames from '~/lib/classNames'
import { ChatAttachment, ChatMessage } from '../../../types/chat'
import ChatMessageBubble from './ChatMessageBubble'
import ChatAssistantAvatar from './ChatAssistantAvatar'
import BouncingDots from '../BouncingDots'
import StyledModal from '../StyledModal'
import api from '~/lib/api'
import { DEFAULT_QUERY_REWRITE_MODEL } from '../../../constants/ollama'
import { useNotifications } from '~/context/NotificationContext'
import { usePage } from '@inertiajs/react'
import { buildSpeechInstruction, resolveSpeechDelivery } from '~/lib/speechDelivery'

type VoiceCharacter = {
  id: string
  name: string
  engine: 'voice_design' | 'voice_clone'
  gender?: 'male' | 'female'
  description?: string
  speakingStyle?: string
  referenceText?: string
  referenceAudioName?: string
}

interface ChatInterfaceProps {
  messages: ChatMessage[]
  onSendMessage: (message: { content: string; attachments?: ChatAttachment[] }) => void
  onStopMessage?: () => void
  onSteerQueuedMessage?: (message: { content: string; attachments?: ChatAttachment[] }) => void
  isLoading?: boolean
  chatSuggestions?: string[]
  chatSuggestionsEnabled?: boolean
  chatSuggestionsLoading?: boolean
  rewriteModelAvailable?: boolean
  canDownloadRewriteModel?: boolean
  autoSpeakReplies?: boolean
  selectedVoiceId?: string
  selectedDeliveryId?: string
  availableSpeakers?: string[]
  voiceCharacters?: VoiceCharacter[]
}

type QueuedMessage = {
  content: string
  attachments: ChatAttachment[]
}

function buildSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[*_#>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitLongSpeechSegment(segment: string, maxChars: number): string[] {
  if (segment.length <= maxChars) return [segment]

  const words = segment.split(/\s+/)
  const chunks: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length > maxChars) {
      if (current.trim()) chunks.push(current.trim())
      current = word
    } else {
      current = candidate
    }
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks
}

function splitSpeechText(text: string, maxChars = 220, firstChunkMaxChars = 96): string[] {
  const normalized = buildSpeechText(text)
  if (!normalized) return []
  if (normalized.length <= maxChars) return [normalized]

  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((entry) => entry.trim()).filter(Boolean) || [
    normalized,
  ]

  const chunks: string[] = []
  let current = ''
  let firstChunkFilled = false

  const pushCurrent = () => {
    if (!current.trim()) return
    chunks.push(current.trim())
    if (!firstChunkFilled) {
      firstChunkFilled = true
    }
    current = ''
  }

  for (const sentence of sentences) {
    const activeLimit = firstChunkFilled || current ? maxChars : firstChunkMaxChars

    if (sentence.length > activeLimit) {
      pushCurrent()
      const firstSegments = splitLongSpeechSegment(sentence, firstChunkFilled ? maxChars : firstChunkMaxChars)
      for (let index = 0; index < firstSegments.length; index += 1) {
        const segment = firstSegments[index]
        if (!firstChunkFilled) {
          chunks.push(segment)
          firstChunkFilled = true
        } else {
          chunks.push(...splitLongSpeechSegment(segment, maxChars))
        }
      }
      continue
    }

    const candidate = current ? `${current} ${sentence}` : sentence
    if (candidate.length > activeLimit) {
      pushCurrent()
      current = sentence
    } else {
      current = candidate
    }
  }

  pushCurrent()
  return chunks.filter(Boolean)
}

export default function ChatInterface({
  messages,
  onSendMessage,
  onStopMessage,
  onSteerQueuedMessage,
  isLoading = false,
  chatSuggestions = [],
  chatSuggestionsEnabled = false,
  chatSuggestionsLoading = false,
  rewriteModelAvailable = false,
  canDownloadRewriteModel = false,
  autoSpeakReplies = false,
  selectedVoiceId = '',
  selectedDeliveryId = 'auto',
  availableSpeakers = [],
  voiceCharacters = [],
}: ChatInterfaceProps) {
  const { aiAssistantName } = usePage<{ aiAssistantName: string }>().props
  const { addNotification } = useNotifications()
  const [input, setInput] = useState('')
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false)
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null)
  const [loadingSpeechMessageId, setLoadingSpeechMessageId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const shouldRestoreFocusRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const speechAudioContextRef = useRef<AudioContext | null>(null)
  const speechAudioSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const speechSequenceRef = useRef(0)
  const speechSpeakerRef = useRef<string | null>(null)
  const speechModelSizeRef = useRef<'0.6B' | '1.7B' | null>(null)
  const lastAutoSpokenMessageIdRef = useRef<string | null>(null)

  const shouldDismissKeyboardAfterSend = () => {
    if (typeof window === 'undefined') return false

    const coarsePointer =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    return coarsePointer || window.innerWidth <= 1024
  }

  const isMobileComposerViewport = () => {
    if (typeof window === 'undefined') return false

    const coarsePointer =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    return coarsePointer || window.innerWidth <= 1024
  }

  const handleDownloadModel = async () => {
    setIsDownloading(true)
    try {
      await api.downloadModel(DEFAULT_QUERY_REWRITE_MODEL)
      addNotification({ type: 'success', message: 'Model download queued' })
    } catch {
      addNotification({ type: 'error', message: 'Failed to queue model download' })
    } finally {
      setIsDownloading(false)
      setDownloadDialogOpen(false)
    }
  }

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    if (isLoading) return
    if (!shouldRestoreFocusRef.current) return

    shouldRestoreFocusRef.current = false
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [isLoading])

  useEffect(() => {
    if (isLoading) return
    if (queuedMessages.length === 0) return

    const [next, ...rest] = queuedMessages
    setQueuedMessages(rest)
    shouldRestoreFocusRef.current = true
    onSendMessage(next)
  }, [isLoading, queuedMessages, onSendMessage])

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
      }
      if (speechAudioSourceRef.current) {
        try {
          speechAudioSourceRef.current.stop()
        } catch {
          // ignore double-stop cleanup
        }
        speechAudioSourceRef.current.disconnect()
        speechAudioSourceRef.current = null
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
      }
      if (speechAudioContextRef.current) {
        void speechAudioContextRef.current.close().catch(() => {})
        speechAudioContextRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!autoSpeakReplies) return
    const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!latestAssistant || latestAssistant.isStreaming || !latestAssistant.content?.trim()) return
    if (lastAutoSpokenMessageIdRef.current === latestAssistant.id) return

    lastAutoSpokenMessageIdRef.current = latestAssistant.id
    void speakMessage(latestAssistant)
  }, [autoSpeakReplies, messages])

  const queueMessage = (payload: QueuedMessage) => {
    const trimmed = payload.content.trim()
    if (!trimmed && payload.attachments.length === 0) return

    setQueuedMessages((prev) => [...prev, { content: trimmed, attachments: payload.attachments }])
    setInput('')
    setPendingAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.focus()
    }
  }

  const steerQueued = (index: number) => {
    const message = queuedMessages[index]
    if (!message) return

    setQueuedMessages((prev) => prev.filter((_, i) => i !== index))

    if (onSteerQueuedMessage) {
      onSteerQueuedMessage(message)
      return
    }

    if (onStopMessage) onStopMessage()
    setTimeout(() => onSendMessage(message), 75)
  }

  const discardQueued = (index: number) => {
    setQueuedMessages((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() && pendingAttachments.length === 0) return
    const normalizedContent =
      input.trim() ||
      (pendingAttachments.length === 1
        ? `Please use the attached ${pendingAttachments[0].kind} in this chat turn.`
        : 'Please use the attached files in this chat turn.')

    if (isLoading) {
      queueMessage({ content: normalizedContent, attachments: pendingAttachments })
      return
    }

    const dismissKeyboard = shouldDismissKeyboardAfterSend()
    shouldRestoreFocusRef.current = !dismissKeyboard
    onSendMessage({ content: normalizedContent, attachments: pendingAttachments })
    setInput('')
    setPendingAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      if (dismissKeyboard) {
        textareaRef.current.blur()
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`
  }

  const handleTextareaFocus = () => {
    if (typeof window === 'undefined' || !isMobileComposerViewport()) return

    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'auto' })
      window.visualViewport?.offsetTop !== undefined &&
        window.scrollTo({ top: 0, behavior: 'auto' })
    })
  }

  const triggerAttachmentPicker = () => {
    fileInputRef.current?.click()
  }

  const removePendingAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
  }

  const handleAttachmentSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    if (files.length === 0) return

    setIsUploadingAttachment(true)
    try {
      const uploaded = await Promise.all(files.map((file) => api.uploadChatAttachment(file)))
      setPendingAttachments((prev) => [...prev, ...uploaded].slice(0, 6))
    } catch (error) {
      addNotification({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to upload chat attachment.',
      })
    } finally {
      setIsUploadingAttachment(false)
      event.target.value = ''
    }
  }

  const stopSpeech = () => {
    speechSequenceRef.current += 1
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current.src = ''
    }
    if (speechAudioSourceRef.current) {
      try {
        speechAudioSourceRef.current.stop()
      } catch {
        // ignore double-stop cleanup
      }
      speechAudioSourceRef.current.disconnect()
      speechAudioSourceRef.current = null
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
    setSpeakingMessageId(null)
    setLoadingSpeechMessageId(null)
  }

  const ensureSpeechAudioContext = async () => {
    if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null

    const existing = speechAudioContextRef.current
    if (existing && existing.state !== 'closed') {
      if (existing.state === 'suspended') {
        try {
          await existing.resume()
        } catch {
          return null
        }
      }
      return existing
    }

    try {
      const context = new window.AudioContext()
      speechAudioContextRef.current = context
      if (context.state === 'suspended') {
        await context.resume()
      }
      return context
    } catch {
      return null
    }
  }

  const playBlobWithFallback = async (blob: Blob, messageId: string, sequenceId: number) => {
    try {
      const context = await ensureSpeechAudioContext()
      if (context) {
        try {
          const decoded = await context.decodeAudioData((await blob.arrayBuffer()).slice(0))
          if (speechSequenceRef.current !== sequenceId) return

          const source = context.createBufferSource()
          source.buffer = decoded
          source.connect(context.destination)
          speechAudioSourceRef.current = source
          setLoadingSpeechMessageId(null)
          setSpeakingMessageId(messageId)

          await new Promise<void>((resolve) => {
            source.onended = () => {
              if (speechAudioSourceRef.current === source) {
                speechAudioSourceRef.current.disconnect()
                speechAudioSourceRef.current = null
              }
              resolve()
            }
            source.start(0)
          })
          return
        } catch (error) {
          console.warn('Chat message speech Web Audio fallback engaged:', error)
          if (speechAudioSourceRef.current) {
            speechAudioSourceRef.current.disconnect()
            speechAudioSourceRef.current = null
          }
        }
      }

      const url = URL.createObjectURL(blob)
      audioUrlRef.current = url
      const audio = audioRef.current || new Audio()
      audioRef.current = audio
      audio.preload = 'auto'
      audio.setAttribute('playsinline', 'true')
      audio.volume = 1
      audio.src = url

      setLoadingSpeechMessageId(null)
      setSpeakingMessageId(messageId)

      audio.onended = null
      audio.onerror = null
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve()
        audio.onerror = () => reject(new Error('Speech playback failed.'))
        audio
          .play()
          .then(() => undefined)
          .catch((error) => reject(error))
      })
    } catch (error) {
      if (speechSequenceRef.current !== sequenceId) return
      stopSpeech()
      const message =
        error instanceof Error && error.message ? `Speech playback failed: ${error.message}` : 'Speech playback failed.'
      addNotification({ type: 'error', message })
    } finally {
      if (speechSequenceRef.current === sequenceId) {
        setSpeakingMessageId(null)
        setLoadingSpeechMessageId(null)
      }
      if (audioUrlRef.current && speechSequenceRef.current === sequenceId) {
        URL.revokeObjectURL(audioUrlRef.current)
        audioUrlRef.current = null
      }
      if (audioRef.current) {
        audioRef.current.onended = null
        audioRef.current.onerror = null
      }
      if (speechAudioSourceRef.current && speechSequenceRef.current !== sequenceId) {
        speechAudioSourceRef.current.disconnect()
        speechAudioSourceRef.current = null
      }
    }
  }

  const ensureSpeechSettings = async () => {
    if (speechSpeakerRef.current && speechModelSizeRef.current) {
      return {
        speaker: speechSpeakerRef.current,
        modelSize: speechModelSizeRef.current,
      }
    }

    const status = await api.getComfySpeechStatus()
    const savedSpeaker =
      typeof window !== 'undefined' ? window.localStorage.getItem('nomad_comfy_speaker') : null
    const savedModelSize =
      typeof window !== 'undefined' ? window.localStorage.getItem('nomad_comfy_model_size') : null

    speechSpeakerRef.current =
      (savedSpeaker && status?.speakers?.includes(savedSpeaker) ? savedSpeaker : status?.defaultSpeaker) || 'Ryan'
    speechModelSizeRef.current = savedModelSize === '0.6B' ? '0.6B' : (status?.defaultModelSize || '1.7B')

    return {
      speaker: speechSpeakerRef.current,
      modelSize: speechModelSizeRef.current,
    }
  }

  const resolveSelectedVoice = () => {
    const selectedCharacter =
      selectedVoiceId.startsWith('character:')
        ? voiceCharacters.find((entry) => entry.id === selectedVoiceId.replace(/^character:/, ''))
        : null
    const selectedSpeaker = selectedVoiceId.startsWith('speaker:')
      ? selectedVoiceId.replace(/^speaker:/, '')
      : ''

    if (selectedCharacter) {
      if (selectedCharacter.engine === 'voice_clone') {
        return {
          engine: 'voice_clone' as const,
          characterId: selectedCharacter.id,
        }
      }

      return {
        engine: 'voice_design' as const,
        characterId: selectedCharacter.id,
        gender: selectedCharacter.gender,
        description: selectedCharacter.description,
      }
    }

    const speaker =
      selectedSpeaker && availableSpeakers.includes(selectedSpeaker)
        ? selectedSpeaker
        : speechSpeakerRef.current || 'Ryan'

    return {
      engine: 'custom_voice' as const,
      speaker,
    }
  }

  const speakMessage = async (message: ChatMessage) => {
    if (speakingMessageId === message.id || loadingSpeechMessageId === message.id) {
      stopSpeech()
      return
    }

    stopSpeech()
    const sequenceId = speechSequenceRef.current
    setLoadingSpeechMessageId(message.id)

    try {
      const { speaker, modelSize } = await ensureSpeechSettings()
      const voiceSelection = resolveSelectedVoice()
      const selectedCharacter =
        selectedVoiceId.startsWith('character:')
          ? voiceCharacters.find((entry) => entry.id === selectedVoiceId.replace(/^character:/, '')) || null
          : null
      const baseSpeechText = buildSpeechText(message.content || '')
      const chunks =
        voiceSelection.engine === 'custom_voice'
          ? splitSpeechText(baseSpeechText)
          : baseSpeechText
            ? [baseSpeechText]
            : []
      if (chunks.length === 0) return
      const resolvedDelivery = resolveSpeechDelivery(selectedDeliveryId, message.content || '')

      const buildPayload = (text: string) => ({
          text,
          engine: voiceSelection.engine,
          characterId: voiceSelection.engine !== 'custom_voice' ? voiceSelection.characterId : undefined,
          speaker: voiceSelection.engine === 'custom_voice' ? voiceSelection.speaker || speaker : undefined,
          modelSize,
          language: 'English',
          instruct: buildSpeechInstruction(selectedCharacter?.speakingStyle, resolvedDelivery),
          gender: voiceSelection.engine === 'voice_design' ? voiceSelection.gender : undefined,
          description: voiceSelection.engine === 'voice_design' ? voiceSelection.description : undefined,
          delivery: voiceSelection.engine === 'voice_clone' ? undefined : resolvedDelivery,
        })

      let currentBlobPromise: Promise<Blob> | null = api.synthesizeComfySpeech(buildPayload(chunks[0]))

      for (let index = 0; index < chunks.length; index += 1) {
        if (speechSequenceRef.current !== sequenceId) return
        if (!currentBlobPromise) return
        const blob = await currentBlobPromise
        if (speechSequenceRef.current !== sequenceId) return
        const nextBlobPromise =
          index + 1 < chunks.length ? api.synthesizeComfySpeech(buildPayload(chunks[index + 1])) : null
        await playBlobWithFallback(blob, message.id, sequenceId)
        currentBlobPromise = nextBlobPromise
      }
    } catch (error) {
      stopSpeech()
      addNotification({
        type: 'error',
        message: error instanceof Error ? error.message : 'Speech generation failed.',
      })
    }
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-surface-primary shadow-sm">
      <div className="flex-1 overflow-y-auto space-y-6 px-2 py-4 md:px-6">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md text-center">
              <IconWand className="mx-auto mb-4 h-16 w-16 text-desert-green opacity-50" />
              <h3 className="mb-2 text-lg font-medium text-text-primary">Start a conversation</h3>
              <p className="text-sm text-text-muted">
                Interact with your installed language models directly in the Command Center.
              </p>
              {chatSuggestionsEnabled &&
                chatSuggestions &&
                chatSuggestions.length > 0 &&
                !chatSuggestionsLoading && (
                  <div className="mt-8">
                    <h4 className="mb-2 text-sm font-medium text-text-secondary">Suggestions:</h4>
                    <div className="flex flex-col gap-2">
                      {chatSuggestions.map((suggestion, index) => (
                        <button
                          key={index}
                          onClick={() => {
                            setInput(suggestion)
                            setTimeout(() => {
                              textareaRef.current?.focus()
                            }, 0)
                          }}
                          className="rounded-lg bg-surface-secondary px-4 py-2 text-sm text-text-primary transition-colors hover:bg-surface-secondary"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              {chatSuggestionsEnabled && chatSuggestionsLoading && (
                <BouncingDots text="Thinking" containerClassName="mt-8" />
              )}
              {!chatSuggestionsEnabled && (
                <div className="mt-8 text-sm text-text-muted">
                  Need some inspiration? Enable chat suggestions in settings to get started with
                  example prompts.
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <div
                key={message.id}
                className={classNames(
                  'flex gap-4',
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                )}
              >
                {message.role === 'assistant' && <ChatAssistantAvatar />}
                <ChatMessageBubble
                  message={message}
                  trailingActions={
                    message.role === 'assistant' && !message.isStreaming && message.content?.trim() ? (
                      <button
                        type="button"
                        onClick={() => void speakMessage(message)}
                        className="inline-flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-black/5"
                        aria-label={
                          speakingMessageId === message.id || loadingSpeechMessageId === message.id
                            ? `Stop ${aiAssistantName} speech`
                            : `Play ${aiAssistantName} speech`
                        }
                      >
                        {loadingSpeechMessageId === message.id ? (
                          <IconLoader2 className="h-7 w-7 animate-spin md:h-6 md:w-6" />
                        ) : speakingMessageId === message.id ? (
                          <IconPlayerStopFilled className="h-7 w-7 md:h-6 md:w-6" />
                        ) : (
                          <IconVolume className="h-7 w-7 md:h-6 md:w-6" />
                        )}
                      </button>
                    ) : null
                  }
                />
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start gap-4">
                <ChatAssistantAvatar />
                <div className="max-w-[97%] rounded-lg bg-surface-secondary px-4 py-3 text-text-primary md:max-w-[70%]">
                  <BouncingDots text="Thinking" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>
      <div className="min-h-[156px] flex-shrink-0 border-t border-border-subtle bg-surface-primary px-2 py-4 md:min-h-[45px] md:px-6 md:py-2">
        <audio ref={audioRef} className="hidden" preload="auto" playsInline />
        {queuedMessages.length > 0 && (
          <div className="mb-3 flex flex-col gap-2">
            {queuedMessages.map((queued, idx) => (
              <div
                key={`${idx}-${queued.content}-${queued.attachments.map((attachment) => attachment.id).join('-')}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-secondary px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-wide text-text-muted">Queued</div>
                  <div className="truncate text-sm text-text-primary">{queued.content}</div>
                  {queued.attachments.length > 0 && (
                    <div className="mt-1 text-xs text-text-muted">
                      {queued.attachments.length} attachment{queued.attachments.length === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => steerQueued(idx)}
                    className="inline-flex items-center justify-center rounded-md border border-border-default bg-surface-primary px-2 py-1.5 text-text-secondary transition-colors hover:bg-surface-secondary"
                    title="Steer: stop and send now"
                    aria-label="Steer queued message"
                  >
                    <IconSteeringWheel className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => discardQueued(idx)}
                    className="inline-flex items-center justify-center rounded-md border border-border-default bg-surface-primary px-2 py-1.5 text-text-secondary transition-colors hover:bg-surface-secondary"
                    title="Discard queued message"
                    aria-label="Discard queued message"
                  >
                    <IconX className="h-5 w-5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {pendingAttachments.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {pendingAttachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-secondary px-3 py-2"
              >
                {attachment.kind === 'image' ? (
                  <img
                    src={attachment.viewUrl}
                    alt={attachment.name}
                    className="h-10 w-10 rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-desert-orange/10 text-desert-orange">
                    <IconFileTypePdf className="h-5 w-5" />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="max-w-[180px] truncate text-sm font-medium text-text-primary">
                    {attachment.name}
                  </div>
                  <div className="text-xs text-text-muted">
                    {attachment.kind === 'image' ? 'Image attachment' : 'PDF attachment'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removePendingAttachment(attachment.id)}
                  className="inline-flex items-center justify-center rounded-md p-1 text-text-muted transition-colors hover:bg-surface-primary hover:text-text-primary"
                  aria-label={`Remove ${attachment.name}`}
                >
                  <IconX className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex items-end gap-2 md:gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="hidden"
            onChange={handleAttachmentSelection}
          />
          <button
            type="button"
            onClick={triggerAttachmentPicker}
            disabled={isUploadingAttachment}
            className={classNames(
              'mb-2 inline-flex min-h-[112px] min-w-[84px] flex-shrink-0 items-center justify-center self-stretch rounded-2xl border border-border-default bg-surface-primary text-text-secondary transition-colors hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-60 md:mb-0 md:h-12 md:min-h-[48px] md:min-w-0 md:self-end md:px-3 md:py-2'
            )}
            aria-label="Attach images or PDF files"
            title="Attach images or PDF files"
          >
            {isUploadingAttachment ? (
              <IconLoader2 className="h-6 w-6 animate-spin" />
            ) : (
              <IconPaperclip className="h-6 w-6" />
            )}
          </button>
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={handleTextareaFocus}
              placeholder={`Type your message to ${aiAssistantName}... (Shift+Enter for new line)`}
              className="min-h-[112px] w-full resize-none rounded-2xl border border-border-default px-4 py-5 pr-12 text-[48px] leading-[1.1] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-desert-green disabled:bg-surface-secondary disabled:text-text-muted md:h-12 md:min-h-[48px] md:py-2 md:text-base md:leading-5"
              rows={1}
              style={
                isMobileComposerViewport()
                  ? { maxHeight: '280px', fontSize: '48px', lineHeight: '1.1' }
                  : { maxHeight: '280px' }
              }
            />
          </div>
          <button
            type={isLoading ? 'button' : 'submit'}
            onClick={isLoading ? onStopMessage : undefined}
            disabled={isLoading ? !onStopMessage : !input.trim() && pendingAttachments.length === 0}
            className={classNames(
              'mb-2 inline-flex min-h-[112px] min-w-[84px] flex-shrink-0 items-center justify-center gap-2 self-stretch rounded-2xl transition-all duration-200 md:mb-0 md:h-12 md:min-h-[48px] md:min-w-0 md:self-end',
              isLoading
                ? 'bg-red-600 px-5 py-4 text-white shadow-sm hover:scale-105 hover:bg-red-700 md:px-3 md:py-2'
                : !input.trim() && pendingAttachments.length === 0
                  ? 'cursor-not-allowed bg-border-default px-5 py-4 text-text-muted md:px-3 md:py-2'
                  : 'bg-desert-green px-5 py-4 text-white hover:scale-105 hover:bg-desert-green/90 md:px-3 md:py-2'
            )}
            aria-label={isLoading ? `Stop ${aiAssistantName}` : `Send message to ${aiAssistantName}`}
            title={isLoading ? `Stop ${aiAssistantName}` : 'Send'}
          >
            {isLoading ? (
              <>
                <IconPlayerStopFilled className="h-5 w-5" />
                <span className="text-sm font-medium">Stop</span>
              </>
            ) : (
              <IconSend className="h-6 w-6" />
            )}
          </button>
        </form>
      </div>

      {downloadDialogOpen && (
        <StyledModal
          title="Download Rewrite Model?"
          onConfirm={handleDownloadModel}
          onCancel={() => setDownloadDialogOpen(false)}
          open={downloadDialogOpen}
          confirmText={isDownloading ? 'Downloading…' : 'Download'}
          cancelText="Cancel"
          confirmVariant="primary"
        >
          <p className="text-text-primary">
            Quinn can use an optional rewrite model for better suggestion steering. Download{' '}
            <span className="font-mono">{DEFAULT_QUERY_REWRITE_MODEL}</span> now?
          </p>
        </StyledModal>
      )}
    </div>
  )
}
