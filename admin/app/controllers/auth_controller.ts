import { UserSpaceService } from '#services/user_space_service'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'

const loginSchema = vine.compile(
  vine.object({
    username: vine.string().trim().minLength(1),
    pin: vine.string().trim().minLength(4).maxLength(12).regex(/^\d+$/),
  })
)

const quickCreateUserSchema = vine.compile(
  vine.object({
    adminUsername: vine.string().trim().minLength(1),
    adminPin: vine.string().trim().minLength(4).maxLength(12).regex(/^\d+$/),
    displayName: vine.string().trim().minLength(1),
    username: vine
      .string()
      .trim()
      .minLength(3)
      .maxLength(32)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    pin: vine.string().trim().minLength(4).maxLength(12).regex(/^\d+$/),
    role: vine.enum(['admin', 'user'] as const),
  })
)

@inject()
export default class AuthController {
  constructor(private userSpaceService: UserSpaceService) {}

  async loginPage({ inertia, request, response }: HttpContext) {
    const current = await this.userSpaceService.resolveRequestSpace(request)
    if (current) {
      return response.redirect().toPath('/home')
    }

    return inertia.render('auth/login', {
      loginSupport: {
        defaultRole: 'user',
        privateDataNotice:
          'Each user keeps their own chats and private memory. Only family-shared memory is shared across users.',
      },
    })
  }

  async login({ request, response }: HttpContext) {
    const payload = await request.validateUsing(loginSchema)
    const user = await this.userSpaceService.authenticate(payload.username, payload.pin)

    if (!user) {
      return response.status(401).json({
        error: 'Invalid username or PIN.',
      })
    }

    const forwardedProto = request.header('x-forwarded-proto')
    const protocol =
      typeof forwardedProto === 'string' && forwardedProto.length > 0
        ? forwardedProto
        : request.protocol()
    const isSecure = protocol.split(',')[0].trim().toLowerCase() === 'https'

    response.cookie('nomad_user_id', String(user.id), {
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure: isSecure,
    })

    const current = this.userSpaceService.toUserSpace(user)
    return response.status(200).json({ current })
  }

  async logout({ request, response }: HttpContext) {
    const forwardedProto = request.header('x-forwarded-proto')
    const protocol =
      typeof forwardedProto === 'string' && forwardedProto.length > 0
        ? forwardedProto
        : request.protocol()
    const isSecure = protocol.split(',')[0].trim().toLowerCase() === 'https'

    response.clearCookie('nomad_user_id', {
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure: isSecure,
    })

    return response.status(200).json({ success: true })
  }

  async quickCreateUser({ request, response }: HttpContext) {
    const payload = await request.validateUsing(quickCreateUserSchema)
    const adminUser = await this.userSpaceService.authenticate(payload.adminUsername, payload.adminPin)

    if (!adminUser) {
      return response.status(401).json({
        error: 'Invalid admin username or PIN.',
      })
    }

    if (adminUser.role !== 'admin') {
      return response.status(403).json({
        error: 'Only an admin can create users from the login screen.',
      })
    }

    try {
      const user = await this.userSpaceService.createUser(adminUser.family_id, {
        displayName: payload.displayName,
        username: payload.username,
        pin: payload.pin,
        role: payload.role,
      })

      return response.status(201).json({
        user: {
          id: user.id,
          displayName: user.display_name,
          username: user.slug,
          role: user.role,
        },
      })
    } catch (error: any) {
      return response.status(422).json({
        error: error?.message || 'Failed to create user.',
      })
    }
  }
}
