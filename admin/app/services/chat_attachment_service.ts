import { inject } from '@adonisjs/core'
import type { MultipartFile } from '@adonisjs/core/bodyparser'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { PDFParse } from 'pdf-parse'
import logger from '@adonisjs/core/services/logger'
import type { NomadUserSpace } from '#services/user_space_service'
import { sanitizeFilename } from '../utils/fs.js'
import type { OllamaChatAttachment } from '../../types/ollama.js'

type StoredAttachment = OllamaChatAttachment & {
  relativePath: string
  extractedText?: string
}

@inject()
export class ChatAttachmentService {
  static STORAGE_ROOT = path.join('storage', 'chat_attachments')
  static MAX_TEXT_LENGTH = 12000

  async storeUpload(file: MultipartFile, userSpace: NomadUserSpace): Promise<StoredAttachment> {
    const kind = this.detectKind(file)
    if (!kind) {
      throw new Error('Only images and PDFs can be attached in chat right now.')
    }

    const ext = (file.extname || this.extFromClientName(file.clientName) || (kind === 'pdf' ? 'pdf' : 'png')).toLowerCase()
    const attachmentId = randomUUID()
    const sanitizedBase = sanitizeFilename(path.parse(file.clientName || `attachment.${ext}`).name || 'attachment')
    const filename = `${sanitizedBase}-${attachmentId}.${ext}`
    const relativeDir = path.join('users', String(userSpace.user.id))
    const relativePath = path.join(relativeDir, filename)
    const absoluteDir = app.makePath(ChatAttachmentService.STORAGE_ROOT, relativeDir)
    const absolutePath = app.makePath(ChatAttachmentService.STORAGE_ROOT, relativePath)

    await mkdir(absoluteDir, { recursive: true })
    await file.move(absoluteDir, { name: filename, overwrite: true })

    const filePath = file.filePath || absolutePath
    const buffer = await readFile(filePath)
    const token = Buffer.from(relativePath).toString('base64url')
    const attachment: StoredAttachment = {
      id: attachmentId,
      name: file.clientName,
      mimeType: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/*'),
      size: file.size || buffer.byteLength,
      kind,
      token,
      viewUrl: `/api/chat/sessions/attachments/view/${token}`,
      relativePath,
    }

    if (kind === 'pdf') {
      attachment.extractedText = await this.extractPdfText(buffer)
    } else {
      try {
        const metadata = await sharp(buffer).metadata()
        if (metadata.width) attachment.width = metadata.width
        if (metadata.height) attachment.height = metadata.height
      } catch (error) {
        logger.warn(`[ChatAttachmentService] Failed to inspect image metadata: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return attachment
  }

  async materializeAttachments(
    attachments: unknown,
    userSpace: NomadUserSpace
  ): Promise<StoredAttachment[]> {
    if (!Array.isArray(attachments)) return []

    const results: StoredAttachment[] = []
    for (const value of attachments) {
      const normalized = this.normalizeIncomingAttachment(value)
      if (!normalized) continue
      if (!(await this.isTokenAccessible(normalized.token, userSpace))) continue
      results.push(normalized)
    }
    return results
  }

  buildTurnAttachmentContext(attachments: StoredAttachment[]): string | null {
    if (attachments.length === 0) return null

    const imageLines = attachments
      .filter((attachment) => attachment.kind === 'image')
      .map((attachment) => {
        const dimensions =
          attachment.width && attachment.height ? ` (${attachment.width}x${attachment.height})` : ''
        return `- Image: ${attachment.name}${dimensions}`
      })

    const pdfLines = attachments
      .filter((attachment) => attachment.kind === 'pdf')
      .map((attachment) => {
        const excerpt = (attachment.extractedText || '').trim()
        const trimmed = excerpt
          ? excerpt.slice(0, ChatAttachmentService.MAX_TEXT_LENGTH).replace(/\s+/g, ' ').trim()
          : ''
        return trimmed
          ? `- PDF: ${attachment.name}\n  Extracted text excerpt: ${trimmed}`
          : `- PDF: ${attachment.name}`
      })

    const sections: string[] = []
    if (imageLines.length > 0) {
      sections.push(
        'Temporary image attachments are available for this turn. Do not claim you directly inspected pixels unless a vision workflow actually ran. If the user references an image for generation or editing, treat it as an attached reference image.',
        ...imageLines
      )
    }
    if (pdfLines.length > 0) {
      sections.push(
        'Temporary PDF attachments are available for this turn. Use their extracted text as ephemeral context only. Do not treat them as saved knowledge base memory.',
        ...pdfLines
      )
    }

    return sections.length > 0 ? sections.join('\n') : null
  }

  async resolveViewPath(token: string, userSpace: NomadUserSpace): Promise<{ absolutePath: string; mimeType?: string } | null> {
    const relativePath = this.decodeToken(token)
    if (!relativePath) return null

    const normalized = path.normalize(relativePath)
    const allowedPrefix = path.normalize(path.join('users', String(userSpace.user.id)))
    if (!normalized.startsWith(allowedPrefix)) return null

    const absolutePath = app.makePath(ChatAttachmentService.STORAGE_ROOT, normalized)
    return { absolutePath }
  }

  private detectKind(file: MultipartFile): 'image' | 'pdf' | null {
    const type = (file.type || '').toLowerCase()
    const ext = (file.extname || this.extFromClientName(file.clientName) || '').toLowerCase()
    if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image'
    if (type === 'application/pdf' || ext === 'pdf') return 'pdf'
    return null
  }

  private extFromClientName(name: string): string | null {
    const ext = path.extname(name || '').replace(/^\./, '')
    return ext || null
  }

  private async extractPdfText(buffer: Buffer): Promise<string> {
    try {
      const parser = new PDFParse({ data: buffer })
      const data = await parser.getText()
      await parser.destroy()
      return (data.text || '').slice(0, ChatAttachmentService.MAX_TEXT_LENGTH)
    } catch (error) {
      logger.warn(`[ChatAttachmentService] Failed to extract PDF text: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  private normalizeIncomingAttachment(value: unknown): StoredAttachment | null {
    if (!value || typeof value !== 'object') return null
    const entry = value as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : ''
    const name = typeof entry.name === 'string' ? entry.name : ''
    const mimeType = typeof entry.mimeType === 'string' ? entry.mimeType : ''
    const size = typeof entry.size === 'number' ? entry.size : Number(entry.size || 0)
    const kind = entry.kind === 'image' || entry.kind === 'pdf' ? entry.kind : null
    const token = typeof entry.token === 'string' ? entry.token : ''
    const relativePath = typeof entry.relativePath === 'string' ? entry.relativePath : this.decodeToken(token)
    if (!id || !name || !mimeType || !size || !kind || !token || !relativePath) return null

    return {
      id,
      name,
      mimeType,
      size,
      kind,
      token,
      viewUrl: `/api/chat/sessions/attachments/view/${token}`,
      relativePath,
      width: typeof entry.width === 'number' ? entry.width : undefined,
      height: typeof entry.height === 'number' ? entry.height : undefined,
      extractedText: typeof entry.extractedText === 'string' ? entry.extractedText : undefined,
    }
  }

  private decodeToken(token: string): string | null {
    try {
      return Buffer.from(token, 'base64url').toString('utf-8')
    } catch {
      return null
    }
  }

  private async isTokenAccessible(token: string, userSpace: NomadUserSpace): Promise<boolean> {
    const relativePath = this.decodeToken(token)
    if (!relativePath) return false
    const normalized = path.normalize(relativePath)
    const allowedPrefix = path.normalize(path.join('users', String(userSpace.user.id)))
    return normalized.startsWith(allowedPrefix)
  }
}
