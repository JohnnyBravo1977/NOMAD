import { inject } from '@adonisjs/core'
import env from '#start/env'
import { DockerService } from '#services/docker_service'

type ComfyTask =
  | { kind: 'open_ui' }
  | { kind: 'status' }
  | { kind: 'tts_lane' }
  | { kind: 'stt_lane' }
  | { kind: 'image_lane' }
  | { kind: 'vision_lane' }

type ComfyCapabilitySnapshot = {
  available: boolean
  customVoice: boolean
  voiceClone: boolean
  voiceDesign: boolean
  asr: boolean
  whisper: boolean
  imageShell: boolean
}

export type ComfySpeechRequest = {
  text: string
  engine?: 'custom_voice' | 'voice_design'
  speaker?: string
  modelSize?: '0.6B' | '1.7B'
  language?: string
  instruct?: string
  gender?: 'male' | 'female'
  description?: string
}

export type ComfySpeechResult = {
  audio: Buffer
  contentType: string
  filename: string
}

type SpeechCacheEntry = {
  audio: Buffer
  contentType: string
  filename: string
  expiresAt: number
}

@inject()
export class ComfyUiWorkerService {
  private static speechCache = new Map<string, SpeechCacheEntry>()

  constructor(private dockerService: DockerService) {}

  async describeCapabilities(): Promise<string> {
    const snapshot = await this.inspectCapabilities()

    return [
      'ComfyUI worker capabilities:',
      snapshot.available ? '- ComfyUI is currently reachable' : '- ComfyUI is currently not reachable',
      '- Open the ComfyUI multimodal workspace from Quinn chat',
      snapshot.customVoice ? '- Qwen3-TTS custom voice workflows are installed' : '- Qwen3-TTS custom voice workflows are not confirmed',
      snapshot.voiceClone ? '- Qwen3-TTS voice clone workflows are installed' : '- Qwen3-TTS voice clone workflows are not confirmed',
      snapshot.voiceDesign ? '- Qwen3-TTS voice design workflows are installed' : '- Qwen3-TTS voice design workflows are not confirmed',
      snapshot.asr ? '- Qwen ASR / speech-to-text nodes are installed' : '- Qwen ASR / speech-to-text nodes are not confirmed',
      snapshot.whisper ? '- Whisper-style transcription helpers are installed' : '- Whisper-style transcription helpers are not confirmed',
      snapshot.imageShell
        ? '- Core ComfyUI image workflow nodes are available'
        : '- Core ComfyUI image workflow nodes are not confirmed',
      '- Quinn-to-ComfyUI direct workflow dispatch is being staged through Hermes',
    ].join('\n')
  }

  async getSpeechStatus(): Promise<{
    available: boolean
    speakers: string[]
    defaultSpeaker: string
    defaultModelSize: '0.6B' | '1.7B'
  }> {
    const available = await this.isAvailable()
    return {
      available,
      speakers: ['Aiden', 'Dylan', 'Eric', 'Ono_Anna', 'Ryan', 'Serena', 'Sohee', 'Uncle_Fu', 'Vivian'],
      defaultSpeaker: 'Ryan',
      defaultModelSize: '1.7B',
    }
  }

  async synthesizeSpeech(request: ComfySpeechRequest): Promise<ComfySpeechResult> {
    const text = request.text?.trim()
    if (!text) {
      throw new Error('Speech text is required.')
    }

    const status = await this.getSpeechStatus()
    if (!status.available) {
      throw new Error('ComfyUI is not reachable right now.')
    }

    const engine = request.engine === 'voice_design' ? 'voice_design' : 'custom_voice'
    const speaker = status.speakers.includes(request.speaker || '') ? String(request.speaker) : status.defaultSpeaker
    const modelSize = request.modelSize === '0.6B' ? '0.6B' : status.defaultModelSize
    const language = request.language?.trim() || 'English'
    const instruct = buildVoiceInstruction(request)
    const filenamePrefix = `audio/quinn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const cacheKey = JSON.stringify({
      text,
      engine,
      speaker,
      modelSize,
      language,
      instruct,
      gender: request.gender || '',
      description: request.description || '',
    })

    const cached = this.getCachedSpeech(cacheKey)
    if (cached) {
      return cached
    }

    const prompt =
      engine === 'voice_design'
        ? {
            '1': {
              class_type: 'AILab_Qwen3TTSVoiceDesign_Advanced',
              inputs: {
                text,
                instruct,
                model_size: '1.7B',
                device: 'auto',
                precision: 'fp16',
                language,
                max_new_tokens: 512,
                do_sample: false,
                top_p: 0.9,
                top_k: 50,
                temperature: 0.9,
                repetition_penalty: 1.0,
                attention: 'sdpa',
                unload_models: false,
                seed: -1,
              },
            },
            '2': {
              class_type: 'SaveAudioMP3',
              inputs: {
                audio: ['1', 0],
                filename_prefix: filenamePrefix,
                quality: '128k',
              },
            },
          }
        : {
            '1': {
              class_type: 'AILab_Qwen3TTSCustomVoice_Advanced',
              inputs: {
                text,
                speaker,
                model_size: modelSize,
                device: 'auto',
                precision: 'fp16',
                language,
                instruct,
                max_new_tokens: 512,
                do_sample: false,
                top_p: 0.9,
                top_k: 50,
                temperature: 0.9,
                repetition_penalty: 1.0,
                attention: 'sdpa',
                unload_models: false,
                seed: -1,
              },
            },
            '2': {
              class_type: 'SaveAudioMP3',
              inputs: {
                audio: ['1', 0],
                filename_prefix: filenamePrefix,
                quality: '128k',
              },
            },
          }

    const submitResponse = await fetch(`${this.getBaseUrl()}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(this.getSubmitTimeoutMs()),
    })

    if (!submitResponse.ok) {
      throw new Error(`ComfyUI rejected the TTS prompt (${submitResponse.status}).`)
    }

    const submitJson = (await submitResponse.json()) as { prompt_id?: string }
    if (!submitJson?.prompt_id) {
      throw new Error('ComfyUI did not return a prompt id.')
    }

    const output = await this.waitForAudioOutput(submitJson.prompt_id)
    const query = new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder || '',
      type: output.type || 'output',
    })
    const audioResponse = await fetch(`${this.getBaseUrl()}/view?${query.toString()}`, {
      signal: AbortSignal.timeout(this.getViewTimeoutMs()),
    })
    if (!audioResponse.ok) {
      throw new Error(`ComfyUI audio fetch failed (${audioResponse.status}).`)
    }

    const audio = Buffer.from(await audioResponse.arrayBuffer())
    const result = {
      audio,
      contentType: audioResponse.headers.get('content-type') || 'audio/mpeg',
      filename: output.filename,
    }
    this.setCachedSpeech(cacheKey, result)
    return result
  }

  async tryHandle(userText: string): Promise<string | null> {
    const task = this.classify(userText)
    if (!task) return null

    const snapshot = await this.inspectCapabilities()

    switch (task.kind) {
      case 'open_ui':
        return this.openUiReply(snapshot)
      case 'status':
        return this.statusReply(snapshot)
      case 'tts_lane':
        return this.laneReply(
          'speech / TTS',
          snapshot,
          snapshot.customVoice || snapshot.voiceClone || snapshot.voiceDesign,
          'Qwen3-TTS nodes are installed there, so Voice, clone, and design workflows should be the first Hermes-backed lane to finish.'
        )
      case 'stt_lane':
        return this.laneReply(
          'speech-to-text / transcription',
          snapshot,
          snapshot.asr || snapshot.whisper,
          'Qwen ASR and transcription helpers are installed there, so this lane is a good candidate once we wire the Hermes bridge.'
        )
      case 'image_lane':
        return this.laneReply(
          'image generation',
          snapshot,
          snapshot.imageShell,
          'ComfyUI is the right backend shell for image generation here, but we still need to choose and wire the exact NOMAD-facing workflow set.'
        )
      case 'vision_lane':
        return this.laneReply(
          'vision / image understanding',
          snapshot,
          snapshot.imageShell,
          'ComfyUI can host that lane, but Quinn-to-workflow routing for vision is not wired yet.'
        )
      default:
        return null
    }
  }

  classify(userText: string): ComfyTask | null {
    const text = userText.trim()

    if (
      /\b(?:open|launch|show|start)\s+(?:the\s+)?(?:comfyui|voice\s*(?:and|&)\s*settings)\b/i.test(text) ||
      /\b(?:voice\s*(?:and|&)\s*settings|comfyui)\b/i.test(text) && /\b(?:open|launch|show)\b/i.test(text)
    ) {
      return { kind: 'open_ui' }
    }

    if (
      /\b(?:comfyui|qwen tts)\b/i.test(text) &&
      /\b(?:status|running|reachable|available|healthy|up)\b/i.test(text)
    ) {
      return { kind: 'status' }
    }

    if (
      /\b(?:tts|text to speech|speech|voice clone|voice design|custom voice)\b/i.test(text) &&
      /\b(?:comfyui|qwen|voice settings|speak|speaker)\b/i.test(text)
    ) {
      return { kind: 'tts_lane' }
    }

    if (/\b(?:stt|speech to text|transcribe|transcription|asr)\b/i.test(text)) {
      return { kind: 'stt_lane' }
    }

    if (
      /\b(?:image generation|generate (?:an )?image|make (?:an )?image|draw|render an image|create an image)\b/i.test(
        text
      ) && /\b(?:comfyui|workflow|backend|route|hermes)\b/i.test(text)
    ) {
      return { kind: 'image_lane' }
    }

    if (/\b(?:vision|analyze (?:an )?image|inspect (?:an )?image|image understanding)\b/i.test(text)) {
      return { kind: 'vision_lane' }
    }

    return null
  }

  private async inspectCapabilities(): Promise<ComfyCapabilitySnapshot> {
    const available = await this.isAvailable()
    if (!available) {
      return {
        available: false,
        customVoice: false,
        voiceClone: false,
        voiceDesign: false,
        asr: false,
        whisper: false,
        imageShell: false,
      }
    }

    const objectInfo = await this.fetchObjectInfo()
    const names = new Set(Object.keys(objectInfo || {}))

    return {
      available: true,
      customVoice: names.has('AILab_Qwen3TTSCustomVoice') || names.has('Qwen3TTSCustomVoice'),
      voiceClone: names.has('AILab_Qwen3TTSVoiceClone_Advanced') || names.has('Qwen3TTSVoiceClone'),
      voiceDesign: names.has('AILab_Qwen3TTSVoiceDesign') || names.has('Qwen3TTSVoiceDesign'),
      asr: names.has('AILab_Qwen3ASR') || names.has('Qwen3ASR'),
      whisper: names.has('AILab_Qwen3TTSWhisperSTT') || names.has('Qwen3TTSWhisperSTT'),
      imageShell:
        names.has('CheckpointLoaderSimple') &&
        names.has('CLIPTextEncode') &&
        names.has('KSampler') &&
        names.has('VAEDecode'),
    }
  }

  private async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/object_info`, { signal: AbortSignal.timeout(3000) })
      return response.ok
    } catch {
      try {
        const statuses = await this.dockerService.getServicesStatus()
        return statuses.some((entry) => entry.service_name === 'nomad_comfyui' && entry.status === 'running')
      } catch {
        return false
      }
    }
  }

  private async fetchObjectInfo(): Promise<Record<string, any> | null> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/object_info`, {
        signal: AbortSignal.timeout(this.getObjectInfoTimeoutMs()),
      })
      if (!response.ok) return null
      const data = await response.json()
      return data && typeof data === 'object' ? (data as Record<string, any>) : null
    } catch {
      return null
    }
  }

  private async waitForAudioOutput(
    promptId: string
  ): Promise<{ filename: string; subfolder?: string; type?: string }> {
    const deadline = Date.now() + this.getWorkflowTimeoutMs()

    while (Date.now() < deadline) {
      const response = await fetch(`${this.getBaseUrl()}/history/${promptId}`, {
        signal: AbortSignal.timeout(15000),
      })
      if (response.ok) {
        const history = (await response.json()) as Record<string, any>
        const promptHistory = history?.[promptId]
        const status = promptHistory?.status?.status_str
        if (status === 'error') {
          throw new Error('ComfyUI reported a workflow error while generating speech.')
        }

        const outputs = promptHistory?.outputs
        if (outputs && typeof outputs === 'object') {
          for (const value of Object.values(outputs)) {
            const audioEntries = (value as Record<string, any>)?.audio
            if (Array.isArray(audioEntries) && audioEntries[0]?.filename) {
              return audioEntries[0]
            }
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    throw new Error('Timed out waiting for ComfyUI speech output.')
  }

  private openUiReply(snapshot: ComfyCapabilitySnapshot): string {
    const statusLine = snapshot.available
      ? 'ComfyUI is up.'
      : 'ComfyUI does not look reachable right now.'

    return [
      statusLine,
      'Use the Voice & Settings button in Quinn chat to open it directly.',
      'That ComfyUI workspace is the multimodal backend shell we can route through for TTS, image generation, vision, and transcription.',
    ].join('\n')
  }

  private statusReply(snapshot: ComfyCapabilitySnapshot): string {
    return [
      snapshot.available ? 'ComfyUI is reachable.' : 'ComfyUI is not reachable right now.',
      `Qwen TTS custom voice: ${snapshot.customVoice ? 'installed' : 'not confirmed'}`,
      `Qwen TTS voice clone: ${snapshot.voiceClone ? 'installed' : 'not confirmed'}`,
      `Qwen TTS voice design: ${snapshot.voiceDesign ? 'installed' : 'not confirmed'}`,
      `Speech-to-text: ${snapshot.asr || snapshot.whisper ? 'installed' : 'not confirmed'}`,
      `Core image workflow shell: ${snapshot.imageShell ? 'available' : 'not confirmed'}`,
    ].join('\n')
  }

  private laneReply(
    lane: string,
    snapshot: ComfyCapabilitySnapshot,
    laneReady: boolean,
    detail: string
  ): string {
    if (!snapshot.available) {
      return `ComfyUI is the planned backend for ${lane}, but it is not reachable right now.`
    }

    return [
      `ComfyUI is the routed backend lane for ${lane}.`,
      detail,
      laneReady
        ? 'Open it from Voice & Settings if you want to work in the raw workflow UI for now.'
        : 'The backend shell is there, but we still need to finish the exact workflow bridge before Quinn can dispatch it directly.',
    ].join('\n')
  }

  private getBaseUrl(): string {
    return env.get('NOMAD_COMFYUI_URL') || 'http://comfyui:8188'
  }

  private getSubmitTimeoutMs(): number {
    return Math.max(3000, Number(env.get('NOMAD_COMFYUI_SUBMIT_TIMEOUT_MS') || 30000))
  }

  private getViewTimeoutMs(): number {
    return Math.max(5000, Number(env.get('NOMAD_COMFYUI_VIEW_TIMEOUT_MS') || 120000))
  }

  private getObjectInfoTimeoutMs(): number {
    return Math.max(1000, Number(env.get('NOMAD_COMFYUI_OBJECT_INFO_TIMEOUT_MS') || 5000))
  }

  private getWorkflowTimeoutMs(): number {
    return Math.max(10000, Number(env.get('NOMAD_COMFYUI_WORKFLOW_TIMEOUT_MS') || 120000))
  }

  private getCachedSpeech(cacheKey: string): ComfySpeechResult | null {
    const entry = ComfyUiWorkerService.speechCache.get(cacheKey)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      ComfyUiWorkerService.speechCache.delete(cacheKey)
      return null
    }

    return {
      audio: Buffer.from(entry.audio),
      contentType: entry.contentType,
      filename: entry.filename,
    }
  }

  private setCachedSpeech(cacheKey: string, result: ComfySpeechResult) {
    ComfyUiWorkerService.speechCache.set(cacheKey, {
      audio: Buffer.from(result.audio),
      contentType: result.contentType,
      filename: result.filename,
      expiresAt: Date.now() + 10 * 60 * 1000,
    })

    if (ComfyUiWorkerService.speechCache.size > 64) {
      const oldestKey = ComfyUiWorkerService.speechCache.keys().next().value
      if (oldestKey) {
        ComfyUiWorkerService.speechCache.delete(oldestKey)
      }
    }
  }
}

function buildVoiceInstruction(request: ComfySpeechRequest): string {
  const explicit = request.instruct?.trim()
  if (explicit) return explicit

  if (request.engine === 'voice_design') {
    const gender = request.gender === 'male' ? 'male' : request.gender === 'female' ? 'female' : 'human'
    const description = request.description?.trim() || 'a warm, natural speaking voice'
    return `Create a distinctly recognizable ${gender} voice with these traits: ${description}. Keep the requested accent, cadence, and vocal character clearly audible while staying natural and easy to understand.`
  }

  return ''
}
