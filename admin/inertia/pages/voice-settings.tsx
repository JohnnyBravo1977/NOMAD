import { Head, router } from '@inertiajs/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconPencil, IconPlayerPlay, IconVolume, IconWand } from '@tabler/icons-react'
import AppLayout from '~/layouts/AppLayout'
import api from '~/lib/api'
import StyledButton from '~/components/StyledButton'
import { useNotifications } from '~/context/NotificationContext'
import classNames from '~/lib/classNames'
import { VOICE_STYLE_PRESETS } from '~/lib/speechDelivery'

type VoiceDesignCharacter = {
  id: string
  name: string
  engine: 'voice_design'
  gender: 'male' | 'female'
  description: string
  speakingStyle?: string
  createdAt: string
  updatedAt: string
}

type VoiceCloneCharacter = {
  id: string
  name: string
  engine: 'voice_clone'
  referenceText: string
  referenceAudioName: string
  speakingStyle?: string
  createdAt: string
  updatedAt: string
}

type VoiceCharacter = VoiceDesignCharacter | VoiceCloneCharacter

export default function VoiceSettingsPage() {
  const queryClient = useQueryClient()
  const { addNotification } = useNotifications()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const previewSequenceRef = useRef(0)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'voice_design' | 'voice_clone'>('voice_design')
  const [gender, setGender] = useState<'male' | 'female'>('male')
  const [description, setDescription] = useState('')
  const [speakingStyle, setSpeakingStyle] = useState('')
  const [referenceText, setReferenceText] = useState('')
  const [referenceAudio, setReferenceAudio] = useState<File | null>(null)
  const [sampleText, setSampleText] = useState("Hello, I'm Quinn.")
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    return () => {
      previewSequenceRef.current += 1
      if (audioSourceRef.current) {
        try {
          audioSourceRef.current.stop()
        } catch {}
        audioSourceRef.current.disconnect()
        audioSourceRef.current = null
      }
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
        audioUrlRef.current = null
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => {})
        audioContextRef.current = null
      }
    }
  }, [])

  const { data } = useQuery({
    queryKey: ['comfyVoices'],
    queryFn: () => api.getComfyVoices(),
  })

  const characters = data?.characters || []
  const status = data?.status
  const builtInSpeakerCount = status?.speakers?.length || 0

  const stopPreview = () => {
    previewSequenceRef.current += 1
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop()
      } catch {}
      audioSourceRef.current.disconnect()
      audioSourceRef.current = null
    }
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current.src = ''
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
    setPreviewingId(null)
  }

  const ensureAudioContext = async () => {
    if (typeof window === 'undefined') return null
    const AudioContextCtor =
      window.AudioContext || ((window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null)
    if (!AudioContextCtor) return null

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextCtor()
    }

    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume()
    }

    return audioContextRef.current
  }

  const playBlob = async (blob: Blob, marker: string) => {
    stopPreview()
    const sequenceId = previewSequenceRef.current
    const context = await ensureAudioContext()

    if (context) {
      try {
        const decoded = await context.decodeAudioData((await blob.arrayBuffer()).slice(0))
        const source = context.createBufferSource()
        source.buffer = decoded
        source.connect(context.destination)
        audioSourceRef.current = source
        setPreviewingId(marker)
        await new Promise<void>((resolve) => {
          source.onended = () => {
            if (audioSourceRef.current === source) {
              audioSourceRef.current.disconnect()
              audioSourceRef.current = null
            }
            if (previewSequenceRef.current === sequenceId) {
              setPreviewingId(null)
            }
            resolve()
          }
          source.start(0)
        })
        return
      } catch (error) {
        console.warn('Voice Studio Web Audio playback fallback engaged:', error)
      }
    }

    const url = URL.createObjectURL(blob)
    audioUrlRef.current = url
    const audio = audioRef.current || new Audio()
    audioRef.current = audio
    audio.preload = 'auto'
    audio.setAttribute('playsinline', 'true')
    audio.src = url
    audio.onended = () => {
      if (previewSequenceRef.current === sequenceId) {
        setPreviewingId(null)
      }
    }
    audio.onerror = () => {
      stopPreview()
      addNotification({ type: 'error', message: 'Voice preview playback failed.' })
    }
    setPreviewingId(marker)
    try {
      await audio.play()
    } catch (error) {
      stopPreview()
      addNotification({
        type: 'error',
        message: error instanceof Error ? `Voice preview playback failed: ${error.message}` : 'Voice preview playback failed.',
      })
    }
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      mode === 'voice_clone'
        ? api.saveComfyClonedVoice({
            id: editingId || undefined,
            name: name.trim(),
            referenceText: referenceText.trim(),
            speakingStyle: speakingStyle.trim(),
            referenceAudio,
          })
        : api.saveComfyVoice({
            id: editingId || undefined,
            name: name.trim(),
            gender,
            description: description.trim(),
            speakingStyle: speakingStyle.trim(),
          }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comfyVoices'] })
      addNotification({
        type: 'success',
        message: editingId ? 'Voice character updated.' : 'Voice character saved.',
      })
      setName('')
      setMode('voice_design')
      setGender('male')
      setDescription('')
      setSpeakingStyle('')
      setReferenceText('')
      setReferenceAudio(null)
      setEditingId(null)
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to save voice character.',
      })
    },
  })

  const previewDraftMutation = useMutation({
    mutationFn: () => {
      if (mode === 'voice_clone') {
        if (editingId && !referenceAudio) {
          return api.synthesizeComfySpeech({
            text: sampleText.trim(),
            engine: 'voice_clone',
            characterId: editingId,
            instruct: speakingStyle.trim() || undefined,
            language: 'English',
          })
        }
        if (!referenceAudio) {
          throw new Error('Upload a reference audio file to preview this cloned voice.')
        }
        return api.synthesizeComfySpeech({
          text: sampleText.trim(),
          engine: 'voice_clone',
          instruct: speakingStyle.trim() || undefined,
          language: 'English',
          referenceText: referenceText.trim(),
          referenceAudio,
        })
      }

      return api.synthesizeComfySpeech({
        text: sampleText.trim(),
        engine: 'voice_design',
        gender,
        description: description.trim(),
        instruct: speakingStyle.trim() || undefined,
        language: 'English',
      })
    },
    onSuccess: async (blob) => {
      if (!blob) return
      await playBlob(blob, 'draft')
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to preview voice character.',
      })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteComfyVoice(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comfyVoices'] })
      addNotification({ type: 'success', message: 'Voice character deleted.' })
    },
    onError: (error: any) => {
      addNotification({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to delete voice character.',
      })
    },
  })

  const loadCharacterIntoForm = (character: VoiceCharacter) => {
    setEditingId(character.id)
    setName(character.name)
    setReferenceAudio(null)
    if (character.engine === 'voice_clone') {
      setMode('voice_clone')
      setReferenceText(character.referenceText)
      setDescription('')
      setGender('male')
      setSpeakingStyle(character.speakingStyle || '')
      return
    }

    setMode('voice_design')
    setGender(character.gender)
    setDescription(character.description)
    setSpeakingStyle(character.speakingStyle || '')
    setReferenceText('')
  }

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setMode('voice_design')
    setGender('male')
    setDescription('')
    setSpeakingStyle('')
    setReferenceText('')
    setReferenceAudio(null)
  }

  const useCharacterInChat = (character: VoiceCharacter) => {
    try {
      localStorage.setItem('nomad:chat-selected-voice', `character:${character.id}`)
    } catch {}
    addNotification({ type: 'success', message: `${character.name} is ready in chat.` })
    router.visit('/chat')
  }

  const openComfyUi = () => {
    if (typeof window === 'undefined') return
    const url = `${window.location.protocol}//${window.location.hostname}:8188`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const canSave = useMemo(() => {
    if (mode === 'voice_clone') {
      return (
        name.trim().length > 0 &&
        referenceText.trim().length > 0 &&
        (!!referenceAudio || !!editingId)
      )
    }
    return name.trim().length > 0 && description.trim().length > 0
  }, [mode, name, referenceText, referenceAudio, editingId, description])
  const canPreviewDraft =
    sampleText.trim().length > 0 &&
    (mode === 'voice_clone'
      ? referenceText.trim().length > 0 && (!!referenceAudio || !!editingId)
      : description.trim().length > 0)

  return (
    <AppLayout>
      <Head title="Voice Studio" />
      <div className="mx-auto max-w-7xl p-4 md:p-6">
        <div className="overflow-hidden rounded-3xl border-2 border-desert-green bg-surface-primary shadow-sm">
          <div className="bg-gradient-to-r from-desert-green via-desert-green to-desert-tan px-6 py-8 text-white">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="mb-3 inline-flex items-center rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em]">
                  Admin Only
                </div>
                <h1 className="text-3xl font-bold md:text-4xl">Voice Studio</h1>
                <p className="mt-3 max-w-3xl text-sm text-white/85 md:text-base">
                  Build safe Quinn voice characters here, test them against Qwen3-TTS, and make them
                  available in chat without exposing raw ComfyUI nodes to regular users.
                </p>
              </div>
              <div className="rounded-2xl border border-white/15 bg-black/10 px-4 py-3 text-sm shadow-sm backdrop-blur-sm">
                <div className="font-semibold text-white">
                  ComfyUI: {status?.available ? 'Reachable' : 'Unavailable'}
                </div>
                <div className="mt-1 text-white/80">
                  Speakers: {status?.speakers?.length || 0} · Default: {status?.defaultSpeaker || 'Ryan'}
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-3 border-t border-border-subtle bg-surface-secondary/70 px-6 py-4 md:grid-cols-3">
            <div className="rounded-2xl border border-border-subtle bg-surface-primary px-4 py-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                Saved Characters
              </div>
              <div className="mt-2 text-3xl font-bold text-desert-green">{characters.length}</div>
              <div className="mt-1 text-sm text-text-secondary">
                Reusable Quinn voices ready for chat
              </div>
            </div>
            <div className="rounded-2xl border border-border-subtle bg-surface-primary px-4 py-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                Built-In Speakers
              </div>
              <div className="mt-2 text-3xl font-bold text-desert-green">{builtInSpeakerCount}</div>
              <div className="mt-1 text-sm text-text-secondary">
                Qwen custom voices available instantly
              </div>
            </div>
            <div className="rounded-2xl border border-border-subtle bg-surface-primary px-4 py-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                Workflow
              </div>
              <div className="mt-2 text-lg font-bold text-desert-green">Prompt → Test → Save</div>
              <div className="mt-1 text-sm text-text-secondary">
                Create voices here, then let chat use them safely
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="rounded-3xl border border-border-subtle bg-surface-primary p-6 shadow-sm">
            <audio ref={audioRef} className="hidden" preload="auto" playsInline />
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-desert-orange/15 text-desert-orange">
                <IconWand className="h-7 w-7" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-text-primary">
                  {editingId ? 'Edit Character' : 'Create Character'}
                </h2>
                <p className="text-sm text-text-secondary">
                  Describe the performance you want Quinn to use, preview it, then save it as a reusable character.
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-border-subtle bg-surface-secondary px-4 py-3 text-sm text-text-secondary">
              Best prompts mention cadence, warmth, clarity, accent, and attitude. Think in terms
              like “calm British butler,” “warm documentary narrator,” or “playful adventurous guide.”
            </div>

            <div className="mt-6 grid gap-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-text-primary">Character Type</label>
                <div className="grid gap-3 sm:grid-cols-2">
                  {([
                    {
                      id: 'voice_design',
                      title: 'Voice Design',
                      description: 'Describe the voice you want and generate it from a prompt.',
                    },
                    {
                      id: 'voice_clone',
                      title: 'Voice Clone',
                      description: 'Upload a clean voice reference and transcript to clone that voice.',
                    },
                  ] as const).map((option) => {
                    const active = mode === option.id
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setMode(option.id)}
                        className={classNames(
                          'rounded-2xl border px-4 py-3 text-left transition-colors',
                          active
                            ? 'border-desert-green bg-desert-green/10 shadow-sm'
                            : 'border-border-default bg-surface-primary hover:bg-surface-secondary'
                        )}
                      >
                        <div className="font-semibold text-text-primary">{option.title}</div>
                        <div className="mt-1 text-sm text-text-secondary">{option.description}</div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-text-primary">Character Name</label>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="w-full rounded-xl border border-border-default bg-surface-primary px-3 py-3 text-sm shadow-sm"
                  placeholder="Quinn Butler"
                />
              </div>

              {mode === 'voice_design' ? (
                <>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-text-primary">Voice Gender</label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(['male', 'female'] as const).map((option) => {
                        const active = gender === option
                        return (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setGender(option)}
                            className={classNames(
                              'rounded-2xl border px-4 py-3 text-left transition-colors',
                              active
                                ? 'border-desert-green bg-desert-green/10 shadow-sm'
                                : 'border-border-default bg-surface-primary hover:bg-surface-secondary'
                            )}
                          >
                            <div className="font-semibold capitalize text-text-primary">{option}</div>
                            <div className="mt-1 text-sm text-text-secondary">
                              {option === 'male'
                                ? 'Use a masculine base for the generated voice.'
                                : 'Use a feminine base for the generated voice.'}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-text-primary">Voice Prompt</label>
                    <textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      rows={5}
                      className="w-full rounded-xl border border-border-default bg-surface-primary px-3 py-3 text-sm shadow-sm"
                      placeholder="Polished British butler voice with calm precision, dry warmth, and clear diction."
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-text-primary">Reference Transcript</label>
                    <textarea
                      value={referenceText}
                      onChange={(event) => setReferenceText(event.target.value)}
                      rows={4}
                      className="w-full rounded-xl border border-border-default bg-surface-primary px-3 py-3 text-sm shadow-sm"
                      placeholder="Paste the exact words spoken in the reference audio."
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-text-primary">Reference Audio</label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".wav,.flac,.ogg,audio/wav,audio/flac,audio/ogg"
                      onChange={(event) => setReferenceAudio(event.target.files?.[0] || null)}
                      className="block w-full rounded-xl border border-border-default bg-surface-primary px-3 py-3 text-sm shadow-sm file:mr-3 file:rounded-lg file:border-0 file:bg-desert-green file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
                    />
                    <div className="mt-2 text-sm text-text-secondary">
                      Upload a clean WAV, FLAC, or OGG clip with one speaker and an exact transcript.
                    </div>
                    {(referenceAudio || (editingId && mode === 'voice_clone')) && (
                      <div className="mt-2 rounded-xl border border-border-subtle bg-surface-secondary px-3 py-2 text-sm text-text-secondary">
                        {referenceAudio
                          ? `Selected file: ${referenceAudio.name}`
                          : 'Using the saved reference audio for this cloned voice.'}
                      </div>
                    )}
                  </div>
                </>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium text-text-primary">Speaking Style</label>
                <div className="mb-3 flex flex-wrap gap-2">
                  {VOICE_STYLE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setSpeakingStyle(preset.prompt)}
                      className="rounded-full border border-border-default bg-surface-primary px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-secondary"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <textarea
                  value={speakingStyle}
                  onChange={(event) => setSpeakingStyle(event.target.value)}
                  rows={4}
                  className="w-full rounded-xl border border-border-default bg-surface-primary px-3 py-3 text-sm shadow-sm"
                  placeholder="Optional reusable speaking style for this character, like a pirate captain, polished butler, or cinematic storyteller."
                />
                <div className="mt-2 text-sm text-text-secondary">
                  This saved style travels with the character into chat, so Quinn can keep the same performance without you restating it every turn.
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-text-primary">Preview Text</label>
                <textarea
                  value={sampleText}
                  onChange={(event) => setSampleText(event.target.value)}
                  rows={3}
                  className="w-full rounded-xl border border-border-default bg-surface-primary px-3 py-3 text-sm shadow-sm"
                />
              </div>

              <div className="flex flex-wrap gap-3">
                <StyledButton
                  variant="action"
                  onClick={() => previewDraftMutation.mutate()}
                  disabled={!canPreviewDraft}
                  loading={previewDraftMutation.isPending}
                  size="lg"
                >
                  {previewingId === 'draft' ? 'Playing Draft' : 'Test Voice'}
                </StyledButton>
                <StyledButton
                  variant="primary"
                  onClick={() => saveMutation.mutate()}
                  disabled={!canSave}
                  loading={saveMutation.isPending}
                  size="lg"
                >
                  {editingId ? 'Save Changes' : 'Save Character'}
                </StyledButton>
                {(editingId || name || description) && (
                  <StyledButton variant="outline" onClick={resetForm} size="lg">
                    {editingId ? 'Cancel Edit' : 'Clear'}
                  </StyledButton>
                )}
                {previewingId && (
                  <StyledButton variant="outline" onClick={stopPreview} size="lg">
                    Stop Preview
                  </StyledButton>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-border-subtle bg-surface-primary p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-desert-green/10 text-desert-green">
                <IconVolume className="h-7 w-7" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-text-primary">Saved Characters</h2>
                <p className="text-sm text-text-secondary">
                  These are the voices users can choose from in chat.
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {characters.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border-default bg-surface-secondary p-5 text-sm text-text-muted">
                  No saved characters yet. Create one on the left, test it, and save it to make it available in chat.
                </div>
              ) : (
                characters.map((character: VoiceCharacter) => (
                  <div
                    key={character.id}
                    className="rounded-2xl border border-border-subtle bg-surface-secondary p-4 shadow-sm"
                  >
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="min-w-0 text-base font-semibold text-text-primary">
                          {character.name}
                        </div>
                        <span
                          className={classNames(
                            'rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                            character.engine === 'voice_clone'
                              ? 'bg-desert-green text-white'
                              : character.gender === 'male'
                                ? 'bg-desert-tan text-white'
                                : 'bg-desert-orange text-white'
                          )}
                        >
                          {character.engine === 'voice_clone' ? 'clone' : character.gender}
                        </span>
                        <div className="text-xs text-text-muted">
                          Updated {new Date(character.updatedAt).toLocaleString()}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <StyledButton
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              const blob = await api.synthesizeComfySpeech({
                                text: sampleText.trim(),
                                engine: character.engine,
                                characterId: character.id,
                                instruct: character.speakingStyle || undefined,
                                gender: character.engine === 'voice_design' ? character.gender : undefined,
                                description:
                                  character.engine === 'voice_design' ? character.description : undefined,
                                language: 'English',
                              })
                              await playBlob(blob, character.id)
                            } catch (error) {
                              addNotification({
                                type: 'error',
                                message:
                                  error instanceof Error
                                    ? error.message
                                    : 'Failed to preview saved voice character.',
                              })
                            }
                          }}
                        >
                          {previewingId === character.id ? 'Playing' : 'Test'}
                        </StyledButton>
                        <StyledButton
                          size="sm"
                          variant="outline"
                          onClick={() => loadCharacterIntoForm(character)}
                        >
                          <span className="inline-flex items-center gap-1">
                            <IconPencil className="h-4 w-4" />
                            Edit
                          </span>
                        </StyledButton>
                        <StyledButton
                          size="sm"
                          variant="action"
                          onClick={() => useCharacterInChat(character)}
                        >
                          <span className="inline-flex items-center gap-1">
                            <IconPlayerPlay className="h-4 w-4" />
                            Use In Chat
                          </span>
                        </StyledButton>
                        <StyledButton
                          size="sm"
                          variant="danger"
                          onClick={() => deleteMutation.mutate(character.id)}
                          loading={deleteMutation.isPending}
                        >
                          Delete
                        </StyledButton>
                      </div>

                      <div className="rounded-xl border border-border-subtle bg-surface-primary px-4 py-3 text-sm leading-6 text-text-secondary whitespace-pre-wrap break-words">
                        {character.engine === 'voice_clone' ? (
                          <>
                            <div className="font-medium text-text-primary">{character.referenceAudioName}</div>
                            {character.speakingStyle ? (
                              <div className="mt-2 whitespace-pre-wrap break-words text-text-primary">
                                {character.speakingStyle}
                              </div>
                            ) : null}
                            <div className="mt-2 whitespace-pre-wrap break-words text-text-secondary">
                              {character.referenceText}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="whitespace-pre-wrap break-words">{character.description}</div>
                            {character.speakingStyle ? (
                              <div className="mt-2 whitespace-pre-wrap break-words text-text-primary">
                                {character.speakingStyle}
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <section className="mt-6 rounded-3xl border border-border-subtle bg-surface-primary p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-text-primary">Open Raw ComfyUI</h2>
              <p className="mt-1 max-w-3xl text-sm text-text-secondary">
                Jump straight into the ComfyUI workflow editor when you need direct node access for deeper Qwen TTS work.
              </p>
            </div>
            <StyledButton variant="outline" size="lg" onClick={openComfyUi}>
              Open ComfyUI
            </StyledButton>
          </div>
        </section>
      </div>
    </AppLayout>
  )
}
