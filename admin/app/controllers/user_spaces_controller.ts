import Family from '#models/family'
import { UserSpaceService } from '#services/user_space_service'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'

const createUserSchema = vine.compile(
  vine.object({
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

const updateUserSchema = vine.compile(
  vine.object({
    displayName: vine.string().trim().minLength(1).optional(),
    username: vine
      .string()
      .trim()
      .minLength(3)
      .maxLength(32)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    pin: vine.string().trim().minLength(4).maxLength(12).regex(/^\d+$/).optional(),
    role: vine.enum(['admin', 'user'] as const).optional(),
    isActive: vine.boolean().optional(),
  })
)

const selectUserSchema = vine.compile(
  vine.object({
    userId: vine.number().positive(),
  })
)

const updateFamilySchema = vine.compile(
  vine.object({
    allowMemberFamilyUploads: vine.boolean(),
  })
)

@inject()
export default class UserSpacesController {
  constructor(private userSpaceService: UserSpaceService) {}

  async settings({ inertia, request }: HttpContext) {
    const current = await this.userSpaceService.resolveRequestSpace(request)
    if (!current) {
      return inertia.render('auth/login')
    }
    const users = await this.userSpaceService.listUsers(current.family.id)
    const family = await Family.findOrFail(current.family.id)

    return inertia.render('settings/users', {
      userSpaces: {
        current,
        users: users.map((user) => this.serializeUser(user)),
        family: {
          id: family.id,
          name: family.name,
          slug: family.slug,
          allowMemberFamilyUploads: family.allow_member_family_uploads,
        },
      },
    })
  }

  async context({ request, response }: HttpContext) {
    const current = await this.userSpaceService.resolveRequestSpace(request)
    if (!current) {
      return response.status(401).json({ error: 'Authentication required.' })
    }
    const switchableUsers = current.canAccessAdminTools
      ? await this.userSpaceService.listSwitchableUsers(current.family.id)
      : [
          {
            id: current.user.id,
            displayName: current.user.displayName,
            role: current.user.role,
            isActive: true,
          },
        ]
    return response.status(200).json({
      current,
      users: switchableUsers,
      family: current.family,
    })
  }

  async index({ request, response }: HttpContext) {
    const current = await this.userSpaceService.resolveRequestSpace(request)
    if (!current) {
      return response.status(401).json({ error: 'Authentication required.' })
    }
    const users = await this.userSpaceService.listUsers(current.family.id)
    return response.status(200).json({ users: users.map((user) => this.serializeUser(user)) })
  }

  async store({ request, response }: HttpContext) {
    const current = await this.userSpaceService.resolveRequestSpace(request)
    if (!current) {
      return response.status(401).json({ error: 'Authentication required.' })
    }
    const payload = await request.validateUsing(createUserSchema)
    const user = await this.userSpaceService.createUser(current.family.id, payload)
    return response.status(201).json({ user: this.serializeUser(user) })
  }

  async update({ params, request, response }: HttpContext) {
    const current = await this.userSpaceService.resolveRequestSpace(request)
    if (!current) {
      return response.status(401).json({ error: 'Authentication required.' })
    }
    const payload = await request.validateUsing(updateUserSchema)
    const user = await this.userSpaceService.updateUser(current.family.id, Number(params.id), payload)
    return response.status(200).json({ user: this.serializeUser(user) })
  }

  async updateFamily({ request, response }: HttpContext) {
    const current = await this.userSpaceService.resolveRequestSpace(request)
    if (!current) {
      return response.status(401).json({ error: 'Authentication required.' })
    }
    const payload = await request.validateUsing(updateFamilySchema)
    const family = await this.userSpaceService.updateFamily(current.family.id, payload)
    return response.status(200).json({
      family: {
        id: family.id,
        name: family.name,
        slug: family.slug,
        allowMemberFamilyUploads: family.allow_member_family_uploads,
      },
    })
  }

  async select({ request, response }: HttpContext) {
    await request.validateUsing(selectUserSchema)
    return response.status(410).json({
      error: 'Direct user switching has been replaced by username and PIN login.',
    })
  }

  private serializeUser(user: {
    id: number
    family_id: number
    slug: string
    display_name: string
    role: 'admin' | 'user'
    is_active: boolean
    created_at?: unknown
    updated_at?: unknown
  }) {
    return {
      id: user.id,
      family_id: user.family_id,
      slug: user.slug,
      display_name: user.display_name,
      role: user.role,
      is_active: user.is_active,
      created_at: user.created_at,
      updated_at: user.updated_at,
    }
  }
}
