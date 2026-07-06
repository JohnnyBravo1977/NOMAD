import { inject } from '@adonisjs/core'
import env from '#start/env'

export type QwenSpeechRequest = {
  text: string
  engine?: 'custom_voice' | 'voice_design' | 'voice_clone'
  speaker?: string
  modelSize?: '0.6B' | '1.7B'
  language?: string
  instruct?: string
  gender?: 'male' | 'female'
  description?: string
  delivery?: string
  referenceAudioBase64?: string
  referenceAudioFilename?: string
  referenceText?: string
}

export type QwenSpeechResult = {
  audio: Buffer
  contentType: string
  filename: string
}

export type QwenSpeechStreamResult = {
  response: globalThis.Response
  contentType: string
  sampleRate: number
  channels: number
  format: string
}

@inject()
export class QwenTtsService {
  async getSpeechStatus(): Promise<{
    available: boolean
    speakers: string[]
    defaultSpeaker: string
    defaultModelSize: '0.6B' | '1.7B'
  }> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/voices`, {
        signal: AbortSignal.timeout(this.getStatusTimeoutMs()),
      })
      if (!response.ok) {
        throw new Error(`Qwen TTS status failed (${response.status})`)
      }
      const data = (await response.json()) as {
        available?: boolean
        speakers?: string[]
        defaultSpeaker?: string
        defaultModelSize?: '0.6B' | '1.7B'
      }
      return {
        available: data.available !== false,
        speakers: Array.isArray(data.speakers) ? data.speakers : [],
        defaultSpeaker: data.defaultSpeaker || 'Ryan',
        defaultModelSize: data.defaultModelSize === '0.6B' ? '0.6B' : '1.7B',
      }
    } catch {
      return {
        available: false,
        speakers: ['Aiden', 'Dylan', 'Eric', 'Ono_Anna', 'Ryan', 'Serena', 'Sohee', 'Uncle_Fu', 'Vivian'],
        defaultSpeaker: 'Ryan',
        defaultModelSize: '1.7B',
      }
    }
  }

  async synthesizeSpeech(request: QwenSpeechRequest): Promise<QwenSpeechResult> {
    const response = await fetch(`${this.getBaseUrl()}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.getSpeakTimeoutMs(request)),
    })

    if (!response.ok) {
      let message = `Qwen TTS request failed (${response.status})`
      try {
        const data = (await response.json()) as { detail?: string; error?: string }
        if (typeof data.detail === 'string' && data.detail.trim()) {
          message = data.detail.trim()
        } else if (typeof data.error === 'string' && data.error.trim()) {
          message = data.error.trim()
        }
      } catch {
        // Ignore parse errors and fall back to generic message
      }
      throw new Error(message)
    }

    const audio = Buffer.from(await response.arrayBuffer())
    const disposition = response.headers.get('content-disposition') || ''
    const filenameMatch = disposition.match(/filename="?([^"]+)"?/)

    return {
      audio,
      contentType: response.headers.get('content-type') || 'audio/wav',
      filename: filenameMatch?.[1] || 'quinn.wav',
    }
  }

  async streamSpeech(request: QwenSpeechRequest): Promise<QwenSpeechStreamResult> {
    const response = await fetch(`${this.getBaseUrl()}/speak/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.getStreamTimeoutMs(request)),
    })

    if (!response.ok || !response.body) {
      let message = `Qwen TTS stream failed (${response.status})`
      try {
        const data = (await response.json()) as { detail?: string; error?: string }
        if (typeof data.detail === 'string' && data.detail.trim()) {
          message = data.detail.trim()
        } else if (typeof data.error === 'string' && data.error.trim()) {
          message = data.error.trim()
        }
      } catch {
        // ignore parse errors
      }
      throw new Error(message)
    }

    return {
      response,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      sampleRate: Number(response.headers.get('x-audio-sample-rate') || '24000'),
      channels: Number(response.headers.get('x-audio-channels') || '1'),
      format: response.headers.get('x-audio-format') || 'pcm_s16le',
    }
  }

  private getBaseUrl(): string {
    return env.get('NOMAD_QWEN_TTS_URL') || 'http://qwen_tts:8000'
  }

  private getStatusTimeoutMs(): number {
    return Math.max(1000, Number(env.get('NOMAD_QWEN_TTS_STATUS_TIMEOUT_MS') || 5000))
  }

  private getSpeakTimeoutMs(request: QwenSpeechRequest): number {
    const configured = Math.max(5000, Number(env.get('NOMAD_QWEN_TTS_SPEAK_TIMEOUT_MS') || 120000))
    return request.engine === 'voice_clone' ? Math.max(configured, 180000) : configured
  }

  private getStreamTimeoutMs(request: QwenSpeechRequest): number {
    const configured = Math.max(5000, Number(env.get('NOMAD_QWEN_TTS_STREAM_TIMEOUT_MS') || 120000))
    return request.engine === 'voice_clone' ? Math.max(configured, 180000) : configured
  }
}
