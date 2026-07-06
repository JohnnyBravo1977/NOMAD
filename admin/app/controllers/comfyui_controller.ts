import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import type { MultipartFile } from '@adonisjs/core/bodyparser'
import { QwenTtsService } from '#services/qwen_tts_service'
import KVStore from '#models/kv_store'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeFilename } from '../utils/fs.js'

type VoiceDesignCharacter = {
  id: string
  name: string
  engine: 'voice_design'
  gender: 'male' | 'female'
  description: string
  speakingStyle: string
  createdAt: string
  updatedAt: string
}

type VoiceCloneCharacter = {
  id: string
  name: string
  engine: 'voice_clone'
  referenceText: string
  referenceAudioPath: string
  referenceAudioName: string
  speakingStyle: string
  createdAt: string
  updatedAt: string
}

type VoiceCharacter = VoiceDesignCharacter | VoiceCloneCharacter

const VOICE_CHARACTERS_KEY = 'comfy.voiceCharacters'
const VOICE_REFERENCES_STORAGE_PATH = 'storage/voice-studio/references'
const SUPPORTED_CLONE_AUDIO_EXTENSIONS = new Set(['wav', 'flac', 'ogg'])
const execFileAsync = promisify(execFile)

@inject()
export default class ComfyUiController {
  constructor(private qwenTtsService: QwenTtsService) {}

  async studio({ inertia }: HttpContext) {
    return inertia.render('voice-settings')
  }

  async ttsStatus({ response }: HttpContext) {
    try {
      return response.status(200).json(await this.qwenTtsService.getSpeechStatus())
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to fetch ComfyUI speech status.',
      })
    }
  }

  async voices({ response }: HttpContext) {
    try {
      const status = await this.qwenTtsService.getSpeechStatus()
      const characters = await loadVoiceCharacters()
      return response.status(200).json({ status, characters })
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to load voice data.',
      })
    }
  }

  async saveVoice({ request, response }: HttpContext) {
    try {
      const name = String(request.input('name') || '').trim()
      const gender = request.input('gender')
      const description = String(request.input('description') || '').trim()
      const speakingStyle = String(request.input('speakingStyle') || '').trim()
      const id = typeof request.input('id') === 'string' ? String(request.input('id')).trim() : ''

      if (!name) {
        return response.status(422).json({ error: 'Voice name is required.' })
      }
      if (gender !== 'male' && gender !== 'female') {
        return response.status(422).json({ error: 'Voice gender must be male or female.' })
      }
      if (!description) {
        return response.status(422).json({ error: 'Voice description is required.' })
      }

      const characters = await loadVoiceCharacters()
      const now = new Date().toISOString()
      const existing = id ? characters.find((character) => character.id === id) : null

      const next: VoiceDesignCharacter = {
        id: existing?.id || randomUUID(),
        name,
        engine: 'voice_design',
        gender,
        description,
        speakingStyle,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      }

      const updated = existing
        ? characters.map((character) => (character.id === existing.id ? next : character))
        : [...characters, next]

      await saveVoiceCharacters(updated)
      return response.status(200).json({ character: next, characters: updated })
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to save voice character.',
      })
    }
  }

  async saveClonedVoice({ request, response }: HttpContext) {
    try {
      const name = String(request.input('name') || '').trim()
      const referenceText = String(request.input('referenceText') || '').trim()
      const speakingStyle = String(request.input('speakingStyle') || '').trim()
      const id = typeof request.input('id') === 'string' ? String(request.input('id')).trim() : ''
      const uploadedFile = request.file('referenceAudio')

      if (!name) {
        return response.status(422).json({ error: 'Voice name is required.' })
      }
      if (!referenceText) {
        return response.status(422).json({ error: 'Reference transcript is required.' })
      }

      const characters = await loadVoiceCharacters()
      const existing = id ? characters.find((character) => character.id === id) : null
      if (existing && existing.engine !== 'voice_clone') {
        return response.status(422).json({ error: 'Only saved clone voices can be updated here.' })
      }

      const storedReference =
        uploadedFile ? await this.storeCloneReferenceAudio(uploadedFile) : null

      if (!storedReference && (!existing || existing.engine !== 'voice_clone')) {
        return response.status(422).json({ error: 'Reference audio is required for cloned voices.' })
      }

      const now = new Date().toISOString()
      const next: VoiceCloneCharacter = {
        id: existing?.id || randomUUID(),
        name,
        engine: 'voice_clone',
        referenceText,
        speakingStyle,
        referenceAudioPath:
          storedReference?.referenceAudioPath ||
          (existing && existing.engine === 'voice_clone' ? existing.referenceAudioPath : ''),
        referenceAudioName:
          storedReference?.referenceAudioName ||
          (existing && existing.engine === 'voice_clone' ? existing.referenceAudioName : ''),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      }

      const updated = existing
        ? characters.map((character) => (character.id === existing.id ? next : character))
        : [...characters, next]

      await saveVoiceCharacters(updated)

      if (
        storedReference &&
        existing &&
        existing.engine === 'voice_clone' &&
        existing.referenceAudioPath &&
        existing.referenceAudioPath !== storedReference.referenceAudioPath
      ) {
        await this.deleteCloneReferenceAudio(existing.referenceAudioPath)
      }

      return response.status(200).json({ character: next, characters: updated })
    } catch (error) {
      console.error('saveClonedVoice failed', error)
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to save cloned voice character.',
      })
    }
  }

  async deleteVoice({ params, response }: HttpContext) {
    try {
      const id = String(params.id || '').trim()
      if (!id) {
        return response.status(422).json({ error: 'Voice id is required.' })
      }

      const characters = await loadVoiceCharacters()
      const existing = characters.find((character) => character.id === id)
      const updated = characters.filter((character) => character.id !== id)
      await saveVoiceCharacters(updated)
      if (existing?.engine === 'voice_clone') {
        await this.deleteCloneReferenceAudio(existing.referenceAudioPath)
      }
      return response.status(200).json({ success: true, characters: updated })
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete voice character.',
      })
    }
  }

  async speak({ request, response }: HttpContext) {
    try {
      const text = String(request.input('text') || '').trim()
      const speaker = request.input('speaker')
      const engine = request.input('engine')
      const modelSize = request.input('modelSize')
      const language = request.input('language')
      const instruct = request.input('instruct')
      const gender = request.input('gender')
      const description = request.input('description')
      const delivery = request.input('delivery')
      const characterId = typeof request.input('characterId') === 'string' ? String(request.input('characterId')).trim() : ''
      const referenceTextInput =
        typeof request.input('referenceText') === 'string' ? String(request.input('referenceText')).trim() : ''
      const referenceAudioBase64Input =
        typeof request.input('referenceAudioBase64') === 'string'
          ? String(request.input('referenceAudioBase64')).trim()
          : ''
      const referenceAudioFilenameInput =
        typeof request.input('referenceAudioFilename') === 'string'
          ? String(request.input('referenceAudioFilename')).trim()
          : ''

      if (!text) {
        return response.status(422).json({ error: 'Speech text is required.' })
      }

      const resolvedCharacter = characterId ? await this.resolveVoiceCharacter(characterId) : null
      const cloneReference = resolvedCharacter?.engine === 'voice_clone'
        ? await this.readCloneReferenceAudio(resolvedCharacter.referenceAudioPath)
        : null
      const resolvedInstruct =
        typeof instruct === 'string' && instruct.trim()
          ? instruct.trim()
          : resolvedCharacter?.speakingStyle || undefined

      const result = await this.qwenTtsService.synthesizeSpeech({
        text,
        engine:
          resolvedCharacter?.engine === 'voice_clone'
            ? 'voice_clone'
            : resolvedCharacter?.engine === 'voice_design'
              ? 'voice_design'
              : engine === 'voice_design'
                ? 'voice_design'
                : engine === 'voice_clone'
                  ? 'voice_clone'
                  : 'custom_voice',
        speaker: typeof speaker === 'string' ? speaker : undefined,
        modelSize: modelSize === '0.6B' ? '0.6B' : modelSize === '1.7B' ? '1.7B' : undefined,
        language: typeof language === 'string' ? language : undefined,
        instruct: resolvedInstruct,
        gender:
          resolvedCharacter?.engine === 'voice_design'
            ? resolvedCharacter.gender
            : gender === 'male' || gender === 'female'
              ? gender
              : undefined,
        description:
          resolvedCharacter?.engine === 'voice_design'
            ? resolvedCharacter.description
            : typeof description === 'string'
              ? description
              : undefined,
        delivery: typeof delivery === 'string' ? delivery : undefined,
        referenceAudioBase64: cloneReference?.referenceAudioBase64 || referenceAudioBase64Input || undefined,
        referenceAudioFilename:
          (resolvedCharacter?.engine === 'voice_clone' ? resolvedCharacter.referenceAudioName : undefined) ||
          referenceAudioFilenameInput ||
          undefined,
        referenceText:
          (resolvedCharacter?.engine === 'voice_clone' ? resolvedCharacter.referenceText : undefined) ||
          referenceTextInput ||
          undefined,
      })

      response.header('Content-Type', result.contentType)
      response.header('Content-Disposition', `inline; filename="${result.filename}"`)
      return response.send(result.audio)
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to generate speech.',
      })
    }
  }

  async speakStream({ request, response }: HttpContext) {
    try {
      const text = String(request.input('text') || '').trim()
      const speaker = request.input('speaker')
      const engine = request.input('engine')
      const modelSize = request.input('modelSize')
      const language = request.input('language')
      const instruct = request.input('instruct')
      const gender = request.input('gender')
      const description = request.input('description')
      const delivery = request.input('delivery')
      const characterId = typeof request.input('characterId') === 'string' ? String(request.input('characterId')).trim() : ''
      const referenceTextInput =
        typeof request.input('referenceText') === 'string' ? String(request.input('referenceText')).trim() : ''
      const referenceAudioBase64Input =
        typeof request.input('referenceAudioBase64') === 'string'
          ? String(request.input('referenceAudioBase64')).trim()
          : ''
      const referenceAudioFilenameInput =
        typeof request.input('referenceAudioFilename') === 'string'
          ? String(request.input('referenceAudioFilename')).trim()
          : ''

      if (!text) {
        return response.status(422).json({ error: 'Speech text is required.' })
      }

      const resolvedCharacter = characterId ? await this.resolveVoiceCharacter(characterId) : null
      const cloneReference = resolvedCharacter?.engine === 'voice_clone'
        ? await this.readCloneReferenceAudio(resolvedCharacter.referenceAudioPath)
        : null
      const resolvedInstruct =
        typeof instruct === 'string' && instruct.trim()
          ? instruct.trim()
          : resolvedCharacter?.speakingStyle || undefined

      const result = await this.qwenTtsService.streamSpeech({
        text,
        engine:
          resolvedCharacter?.engine === 'voice_clone'
            ? 'voice_clone'
            : resolvedCharacter?.engine === 'voice_design'
              ? 'voice_design'
              : engine === 'voice_design'
                ? 'voice_design'
                : engine === 'voice_clone'
                  ? 'voice_clone'
                  : 'custom_voice',
        speaker: typeof speaker === 'string' ? speaker : undefined,
        modelSize: modelSize === '0.6B' ? '0.6B' : modelSize === '1.7B' ? '1.7B' : undefined,
        language: typeof language === 'string' ? language : undefined,
        instruct: resolvedInstruct,
        gender:
          resolvedCharacter?.engine === 'voice_design'
            ? resolvedCharacter.gender
            : gender === 'male' || gender === 'female'
              ? gender
              : undefined,
        description:
          resolvedCharacter?.engine === 'voice_design'
            ? resolvedCharacter.description
            : typeof description === 'string'
              ? description
              : undefined,
        delivery: typeof delivery === 'string' ? delivery : undefined,
        referenceAudioBase64: cloneReference?.referenceAudioBase64 || referenceAudioBase64Input || undefined,
        referenceAudioFilename:
          (resolvedCharacter?.engine === 'voice_clone' ? resolvedCharacter.referenceAudioName : undefined) ||
          referenceAudioFilenameInput ||
          undefined,
        referenceText:
          (resolvedCharacter?.engine === 'voice_clone' ? resolvedCharacter.referenceText : undefined) ||
          referenceTextInput ||
          undefined,
      })

      response.header('Content-Type', result.contentType)
      response.header('Cache-Control', 'no-store')
      response.header('X-Audio-Format', result.format)
      response.header('X-Audio-Sample-Rate', String(result.sampleRate))
      response.header('X-Audio-Channels', String(result.channels))

      const webStream = result.response.body
      if (!webStream) {
        return response.status(500).json({ error: 'Speech stream body missing.' })
      }

      return response.stream(Readable.fromWeb(webStream as any))
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to generate streamed speech.',
      })
    }
  }

  private async resolveVoiceCharacter(id: string): Promise<VoiceCharacter | null> {
    if (!id) return null
    const characters = await loadVoiceCharacters()
    return characters.find((character) => character.id === id) || null
  }

  private async storeCloneReferenceAudio(uploadedFile: MultipartFile) {
    const ext = String(uploadedFile.extname || '').toLowerCase()
    if (!SUPPORTED_CLONE_AUDIO_EXTENSIONS.has(ext)) {
      throw new Error('Reference audio must be a WAV, FLAC, or OGG file.')
    }

    const sourcePath = uploadedFile.filePath || uploadedFile.tmpPath
    if (!sourcePath) {
      console.error('clone reference missing temp path', {
        clientName: uploadedFile.clientName,
        extname: uploadedFile.extname,
        size: uploadedFile.size,
        state: uploadedFile.state,
        filePath: uploadedFile.filePath,
        tmpPath: uploadedFile.tmpPath,
        errors: uploadedFile.errors,
      })
      throw new Error('Reference audio was not available for normalization.')
    }

    const sourceName = typeof uploadedFile.clientName === 'string' && uploadedFile.clientName.trim()
      ? uploadedFile.clientName
      : `voice-reference.${ext || 'wav'}`

    const safeName = sanitizeFilename(sourceName.replace(/\.[^.]+$/, '')) || 'voice-reference'
    const fileName = `${safeName}-${randomUUID()}.wav`
    const targetDir = app.makePath(VOICE_REFERENCES_STORAGE_PATH)
    const targetPath = join(targetDir, fileName)
    await mkdir(targetDir, { recursive: true })

    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        sourcePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '24000',
        '-c:a',
        'pcm_s16le',
        targetPath,
      ])
    } catch (error: any) {
      console.error('clone reference normalization failed', {
        clientName: uploadedFile.clientName,
        extname: uploadedFile.extname,
        size: uploadedFile.size,
        state: uploadedFile.state,
        sourcePath,
        targetPath,
        message: error?.message,
        stdout: error?.stdout,
        stderr: error?.stderr,
      })
      await rm(targetPath, { force: true }).catch(() => {})
      throw new Error('Reference audio could not be normalized. Please upload a valid WAV, FLAC, or OGG voice clip.')
    } finally {
      if (uploadedFile.filePath) {
        await rm(uploadedFile.filePath, { force: true }).catch(() => {})
      }
      if (uploadedFile.tmpPath && uploadedFile.tmpPath !== uploadedFile.filePath) {
        await rm(uploadedFile.tmpPath, { force: true }).catch(() => {})
      }
    }

    return {
      referenceAudioPath: join(VOICE_REFERENCES_STORAGE_PATH, fileName),
      referenceAudioName: `${safeName}.wav`,
    }
  }

  private async readCloneReferenceAudio(referenceAudioPath: string) {
    const absolutePath = app.makePath(referenceAudioPath)
    const audio = await readFile(absolutePath)
    return {
      referenceAudioBase64: audio.toString('base64'),
    }
  }

  private async deleteCloneReferenceAudio(referenceAudioPath: string) {
    if (!referenceAudioPath) return
    await rm(app.makePath(referenceAudioPath), { force: true }).catch(() => {})
  }
}

async function loadVoiceCharacters(): Promise<VoiceCharacter[]> {
  try {
    const raw = await KVStore.getValue(VOICE_CHARACTERS_KEY)
    const parsed = raw ? JSON.parse(String(raw)) : []
    if (!Array.isArray(parsed)) return []

    return parsed
      .map((entry) => normalizeVoiceCharacter(entry))
      .filter((entry): entry is VoiceCharacter => !!entry)
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

async function saveVoiceCharacters(characters: VoiceCharacter[]) {
  await KVStore.setValue(VOICE_CHARACTERS_KEY, JSON.stringify(characters))
}

function normalizeVoiceCharacter(value: any): VoiceCharacter | null {
  if (!value || typeof value !== 'object') return null
  const engine = value.engine === 'voice_clone' ? 'voice_clone' : 'voice_design'
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString()
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : createdAt

  if (!id || !name) return null

  if (engine === 'voice_clone') {
    const referenceText = typeof value.referenceText === 'string' ? value.referenceText.trim() : ''
    const referenceAudioPath =
      typeof value.referenceAudioPath === 'string' ? value.referenceAudioPath.trim() : ''
    const referenceAudioName =
      typeof value.referenceAudioName === 'string' ? value.referenceAudioName.trim() : ''
    const speakingStyle = typeof value.speakingStyle === 'string' ? value.speakingStyle.trim() : ''

    if (!referenceText || !referenceAudioPath || !referenceAudioName) return null

    return {
      id,
      name,
      engine: 'voice_clone',
      referenceText,
      referenceAudioPath,
      referenceAudioName,
      speakingStyle,
      createdAt,
      updatedAt,
    }
  }

  const gender = value.gender === 'male' ? 'male' : value.gender === 'female' ? 'female' : null
  const description = typeof value.description === 'string' ? value.description.trim() : ''
  const speakingStyle = typeof value.speakingStyle === 'string' ? value.speakingStyle.trim() : ''

  if (!gender || !description) return null

  return {
    id,
    name,
    engine,
    gender,
    description,
    speakingStyle,
    createdAt,
    updatedAt,
  }
}
