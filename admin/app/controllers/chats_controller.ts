import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { ChatService } from '#services/chat_service'
import { ChatAttachmentService } from '#services/chat_attachment_service'
import { createSessionSchema, updateSessionSchema, addMessageSchema } from '#validators/chat'
import KVStore from '#models/kv_store'
import { SystemService } from '#services/system_service'
import { UserSpaceService } from '#services/user_space_service'
import { SERVICE_NAMES } from '../../constants/service_names.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

@inject()
export default class ChatsController {
  constructor(
    private chatService: ChatService,
    private systemService: SystemService,
    private userSpaceService: UserSpaceService,
    private chatAttachmentService: ChatAttachmentService
  ) {}

  async inertia({ inertia, response }: HttpContext) {
    const aiAssistantInstalled = await this.systemService.checkServiceInstalled(SERVICE_NAMES.OLLAMA)
    if (!aiAssistantInstalled) {
      return response.status(404).json({ error: 'AI Assistant service not installed' })
    }
    
    const chatSuggestionsEnabled = await KVStore.getValue('chat.suggestionsEnabled')
    return inertia.render('chat', {
      settings: {
        chatSuggestionsEnabled: chatSuggestionsEnabled ?? false,
      },
    })
  }

  async index({ request }: HttpContext) {
    const userSpace = await this.userSpaceService.resolveRequestSpace(request)
    if (!userSpace) return []
    return await this.chatService.getAllSessions(userSpace)
  }

  async show({ params, request, response }: HttpContext) {
    const userSpace = await this.userSpaceService.resolveRequestSpace(request)
    if (!userSpace) {
      return response.status(401).json({ error: 'Authentication required.' })
    }
    const sessionId = parseInt(params.id)
    const session = await this.chatService.getSession(sessionId, userSpace)

    if (!session) {
      return response.status(404).json({ error: 'Session not found' })
    }

    return session
  }

  async store({ request, response }: HttpContext) {
    try {
      const userSpace = await this.userSpaceService.resolveRequestSpace(request)
      if (!userSpace) {
        return response.status(401).json({ error: 'Authentication required.' })
      }
      const data = await request.validateUsing(createSessionSchema)
      const session = await this.chatService.createSession(data.title, data.model, userSpace)
      return response.status(201).json(session)
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create session',
      })
    }
  }

  async suggestions({ response }: HttpContext) {
    try {
      const suggestions = await this.chatService.getChatSuggestions()
      return response.status(200).json({ suggestions })
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get suggestions',
      })
    }
  }

  async update({ params, request, response }: HttpContext) {
    try {
      const userSpace = await this.userSpaceService.resolveRequestSpace(request)
      if (!userSpace) {
        return response.status(401).json({ error: 'Authentication required.' })
      }
      const sessionId = parseInt(params.id)
      const data = await request.validateUsing(updateSessionSchema)
      const session = await this.chatService.updateSession(sessionId, data, userSpace)
      return session
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to update session',
      })
    }
  }

  async destroy({ params, request, response }: HttpContext) {
    try {
      const userSpace = await this.userSpaceService.resolveRequestSpace(request)
      if (!userSpace) {
        return response.status(401).json({ error: 'Authentication required.' })
      }
      const sessionId = parseInt(params.id)
      await this.chatService.deleteSession(sessionId, userSpace)
      return response.status(204)
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete session',
      })
    }
  }

  async addMessage({ params, request, response }: HttpContext) {
    try {
      const userSpace = await this.userSpaceService.resolveRequestSpace(request)
      if (!userSpace) {
        return response.status(401).json({ error: 'Authentication required.' })
      }
      const sessionId = parseInt(params.id)
      const data = await request.validateUsing(addMessageSchema)
      const message = await this.chatService.addMessage(
        sessionId,
        data.role,
        data.content,
        userSpace,
        data.attachments
      )
      return response.status(201).json(message)
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to add message',
      })
    }
  }

  async destroyAll({ request, response }: HttpContext) {
    try {
      const userSpace = await this.userSpaceService.resolveRequestSpace(request)
      if (!userSpace) {
        return response.status(401).json({ error: 'Authentication required.' })
      }
      const result = await this.chatService.deleteAllSessionsForUser(userSpace)
      return response.status(200).json(result)
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete all sessions',
      })
    }
  }

  async uploadAttachment({ request, response }: HttpContext) {
    try {
      const userSpace = await this.userSpaceService.resolveRequestSpace(request)
      if (!userSpace) {
        return response.status(401).json({ error: 'Authentication required.' })
      }

      const uploadedFile = request.file('file')
      if (!uploadedFile) {
        return response.status(400).json({ error: 'No file uploaded.' })
      }

      const attachment = await this.chatAttachmentService.storeUpload(uploadedFile, userSpace)
      return response.status(201).json({ attachment })
    } catch (error) {
      return response.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to upload chat attachment.',
      })
    }
  }

  async viewAttachment({ params, request, response }: HttpContext) {
    const userSpace = await this.userSpaceService.resolveRequestSpace(request)
    if (!userSpace) {
      return response.status(401).json({ error: 'Authentication required.' })
    }

    const resolved = await this.chatAttachmentService.resolveViewPath(String(params.token || ''), userSpace)
    if (!resolved) {
      return response.status(404).json({ error: 'Attachment not found.' })
    }

    const ext = path.extname(resolved.absolutePath).toLowerCase()
    const mimeType =
      ext === '.pdf'
        ? 'application/pdf'
        : ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : 'application/octet-stream'

    response.header('Content-Type', mimeType)
    response.header('Content-Disposition', 'inline')
    return response.send(await readFile(resolved.absolutePath))
  }
}
