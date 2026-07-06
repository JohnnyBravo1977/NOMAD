import Family from '#models/family'
import KVStore from '#models/kv_store'
import MemoryEntry from '#models/memory_entry'
import User, { type UserRole } from '#models/user'
import hash from '@adonisjs/core/services/hash'
import { inject } from '@adonisjs/core'
import type { Request } from '@adonisjs/core/http'

export type NomadUserSpace = {
  user: {
    id: number
    slug: string
    displayName: string
    role: UserRole
  }
  family: {
    id: number
    slug: string
    name: string
    allowMemberFamilyUploads: boolean
  }
  canAccessAdminTools: boolean
  canUploadFamilyShared: boolean
}

const DEFAULT_FAMILY_SLUG = 'default-family'
const DEFAULT_ADMIN_SLUG = 'admin'
const DEFAULT_ADMIN_PIN = '1234'

@inject()
export class UserSpaceService {
  async resolveRequestSpace(request: Request): Promise<NomadUserSpace | null> {
    await this.ensureBootstrapData()
    const user = await this.resolveRequestUser(request)
    if (!user) {
      return null
    }
    await this.importLegacyProfilesIfNeeded(user.family_id, user.id)
    return this.toUserSpace(user)
  }

  async resolveRequestUser(request: Request): Promise<User | null> {
    await this.ensureBootstrapData()
    const requestedUserId = Number.parseInt(String(request.header('x-nomad-user-id') || ''), 10)
    const requestedUserSlug = String(request.header('x-nomad-user-slug') || '').trim().toLowerCase()
    const cookieUserId = Number.parseInt(String(this.readCookie(request, 'nomad_user_id') || ''), 10)

    let user: User | null = null
    if (Number.isFinite(cookieUserId) && cookieUserId > 0) {
      user = await User.query().where('id', cookieUserId).where('is_active', true).preload('family').first()
    }

    if (!user && Number.isFinite(requestedUserId) && requestedUserId > 0) {
      user = await User.query().where('id', requestedUserId).where('is_active', true).preload('family').first()
    }

    if (!user && requestedUserSlug) {
      user = await User.query()
        .where('slug', requestedUserSlug)
        .where('is_active', true)
        .preload('family')
        .first()
    }

    return user
  }

  async listUsers(familyId: number): Promise<User[]> {
    return User.query().where('family_id', familyId).orderBy('display_name', 'asc')
  }

  async listSwitchableUsers(familyId: number): Promise<Array<{ id: number; displayName: string; role: UserRole; isActive: boolean }>> {
    const users = await User.query().where('family_id', familyId).where('is_active', true).orderBy('display_name', 'asc')
    return users.map((user) => ({
      id: user.id,
      displayName: user.display_name,
      role: user.role,
      isActive: user.is_active,
    }))
  }

  async createUser(
    familyId: number,
    payload: { displayName: string; username: string; pin: string; role: UserRole }
  ): Promise<User> {
    const baseSlug =
      payload.username.trim().toLowerCase() ||
      payload.displayName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') ||
      `user-${Date.now()}`

    const slug = this.normalizeUsername(baseSlug)
    await this.ensureUsernameAvailable(slug)
    return User.create({
      family_id: familyId,
      slug,
      display_name: payload.displayName.trim(),
      pin_hash: await hash.make(payload.pin),
      role: payload.role,
      is_active: true,
    })
  }

  async updateUser(
    familyId: number,
    userId: number,
    payload: { displayName?: string; username?: string; pin?: string; role?: UserRole; isActive?: boolean }
  ): Promise<User> {
    const user = await User.query().where('family_id', familyId).where('id', userId).firstOrFail()
    if (payload.displayName) {
      user.display_name = payload.displayName.trim()
    }
    if (payload.username) {
      const requestedSlug = this.normalizeUsername(payload.username)
      if (requestedSlug && requestedSlug !== user.slug) {
        await this.ensureUsernameAvailable(requestedSlug, user.id)
        user.slug = requestedSlug
      }
    }
    if (payload.pin) {
      user.pin_hash = await hash.make(payload.pin)
    }
    if (payload.role) {
      user.role = payload.role
    }
    if (typeof payload.isActive === 'boolean') {
      user.is_active = payload.isActive
    }
    await user.save()
    return user
  }

  async updateFamily(
    familyId: number,
    payload: { allowMemberFamilyUploads: boolean }
  ): Promise<Family> {
    const family = await Family.findOrFail(familyId)
    family.allow_member_family_uploads = payload.allowMemberFamilyUploads
    await family.save()
    return family
  }

  async selectUserById(userId: number): Promise<User> {
    const user = await User.query().where('id', userId).where('is_active', true).preload('family').firstOrFail()
    return user
  }

  async authenticate(username: string, pin: string): Promise<User | null> {
    await this.ensureBootstrapData()
    const normalizedUsername = username.trim().toLowerCase()
    if (!normalizedUsername || !pin.trim()) return null

    const user = await User.query()
      .where('slug', normalizedUsername)
      .where('is_active', true)
      .preload('family')
      .first()

    if (!user?.pin_hash) {
      return null
    }

    const valid = await hash.verify(user.pin_hash, pin)
    return valid ? user : null
  }

  async ensureBootstrapData(): Promise<{ family: Family; user: User }> {
    let family = await Family.query().where('slug', DEFAULT_FAMILY_SLUG).first()
    if (!family) {
      try {
        family = await Family.create({
          slug: DEFAULT_FAMILY_SLUG,
          name: 'Default Family',
          allow_member_family_uploads: false,
        })
      } catch (error: any) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error
        family = await Family.query().where('slug', DEFAULT_FAMILY_SLUG).firstOrFail()
      }
    }

    let user = await User.query().where('slug', DEFAULT_ADMIN_SLUG).preload('family').first()
    if (!user) {
      const preferredName =
        this.normalizeDisplayName(await KVStore.getValue('ai.activeUserName')) ||
        this.normalizeDisplayName(await KVStore.getValue('ai.userName')) ||
        'Admin'

      try {
        user = await User.create({
          family_id: family.id,
          slug: DEFAULT_ADMIN_SLUG,
          display_name: preferredName,
          pin_hash: await hash.make(DEFAULT_ADMIN_PIN),
          role: 'admin',
          is_active: true,
        })
      } catch (error: any) {
        if (error?.code !== 'ER_DUP_ENTRY') throw error
        user = await User.query().where('slug', DEFAULT_ADMIN_SLUG).preload('family').firstOrFail()
      }

      if (!(user as any).family) {
        await user.load('family')
      }
    }

    if (!user.pin_hash) {
      user.pin_hash = await hash.make(DEFAULT_ADMIN_PIN)
      await user.save()
    }

    return { family, user }
  }

  async importLegacyProfilesIfNeeded(familyId: number, actingUserId: number): Promise<void> {
    const migrated = await KVStore.getValue('ai.userProfilesMigratedToScopedMemory')
    if (String(migrated) === 'true') return

    const existingCount = await MemoryEntry.query().where('family_id', familyId).count('* as total')
    const total = Number(existingCount[0]?.$extras?.total || 0)
    if (total > 0) {
      await KVStore.setValue('ai.userProfilesMigratedToScopedMemory' as any, 'true')
      return
    }

    const raw = await KVStore.getValue('ai.userProfiles')
    if (!raw) {
      await KVStore.setValue('ai.userProfilesMigratedToScopedMemory' as any, 'true')
      return
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      await KVStore.setValue('ai.userProfilesMigratedToScopedMemory' as any, 'true')
      return
    }

    const rows: Array<{
      family_id: number
      owner_user_id: null
      scope: 'family_shared'
      subject_name: string
      fact: string
      normalized_fact: string
      created_by_user_id: number
    }> = []

    for (const [subjectName, facts] of Object.entries(parsed || {})) {
      if (!Array.isArray(facts)) continue
      const cleanedSubject = this.normalizeDisplayName(subjectName)
      if (!cleanedSubject) continue

      const seen = new Set<string>()
      for (const factValue of facts) {
        if (typeof factValue !== 'string') continue
        const fact = factValue.trim()
        if (!fact) continue
        const normalizedFact = fact.toLowerCase()
        if (seen.has(normalizedFact)) continue
        seen.add(normalizedFact)
        rows.push({
          family_id: familyId,
          owner_user_id: null,
          scope: 'family_shared',
          subject_name: cleanedSubject,
          fact,
          normalized_fact: normalizedFact,
          created_by_user_id: actingUserId,
        })
      }
    }

    if (rows.length > 0) {
      await MemoryEntry.createMany(rows)
    }

    await KVStore.setValue('ai.userProfilesMigratedToScopedMemory' as any, 'true')
  }

  private normalizeDisplayName(value: string | null | undefined): string | null {
    if (!value || typeof value !== 'string') return null
    const cleaned = value.trim()
    if (!cleaned) return null
    return cleaned
      .split(/\s+/)
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join(' ')
  }

  toUserSpace(user: User): NomadUserSpace {
    const family = user.family as Family
    const canAccessAdminTools = user.role === 'admin'
    return {
      user: {
        id: user.id,
        slug: user.slug,
        displayName: user.display_name,
        role: user.role,
      },
      family: {
        id: family.id,
        slug: family.slug,
        name: family.name,
        allowMemberFamilyUploads: family.allow_member_family_uploads,
      },
      canAccessAdminTools,
      canUploadFamilyShared: canAccessAdminTools || family.allow_member_family_uploads,
    }
  }

  private normalizeUsername(value: string): string {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || `user-${Date.now()}`
    )
  }

  private async ensureUsernameAvailable(username: string, ignoreUserId?: number): Promise<void> {
    const existing = await User.query()
      .where('slug', username)
      .if(typeof ignoreUserId === 'number', (query) => query.whereNot('id', ignoreUserId as number))
      .first()

    if (existing) {
      throw new Error('That username is already in use.')
    }
  }

  private readCookie(request: Request, key: string): string | null {
    try {
      const cookieFn = (request as any).cookie
      if (typeof cookieFn === 'function') {
        const value = cookieFn.call(request, key)
        return value == null ? null : String(value)
      }
    } catch {}

    const header = String(request.header('cookie') || '')
    if (!header) return null
    const parts = header.split(';').map((part) => part.trim())
    for (const part of parts) {
      const [name, ...rest] = part.split('=')
      if (name === key) {
        return decodeURIComponent(rest.join('='))
      }
    }
    return null
  }
}
