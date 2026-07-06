import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    const hasFamilies = await this.schema.hasTable('families')
    if (!hasFamilies) {
      this.schema.createTable('families', (table) => {
        table.increments('id')
        table.string('slug').notNullable().unique()
        table.string('name').notNullable()
        table.boolean('allow_member_family_uploads').notNullable().defaultTo(false)
        table.timestamp('created_at')
        table.timestamp('updated_at')
      })
    }

    const hasUsers = await this.schema.hasTable('users')
    if (!hasUsers) {
      this.schema.createTable('users', (table) => {
        table.increments('id')
        table.integer('family_id').unsigned().notNullable().references('id').inTable('families').onDelete('CASCADE')
        table.string('slug').notNullable().unique()
        table.string('display_name').notNullable()
        table.text('pin_hash').nullable()
        table.enum('role', ['admin', 'user']).notNullable().defaultTo('user')
        table.boolean('is_active').notNullable().defaultTo(true)
        table.timestamp('created_at')
        table.timestamp('updated_at')
      })
    } else {
      const hasPinHash = await this.schema.hasColumn('users', 'pin_hash')
      if (!hasPinHash) {
        this.schema.alterTable('users', (table) => {
          table.text('pin_hash').nullable().after('display_name')
        })
      }
    }

    const hasChatFamilyId = await this.schema.hasColumn('chat_sessions', 'family_id')
    const hasChatOwnerUserId = await this.schema.hasColumn('chat_sessions', 'owner_user_id')
    const hasChatScope = await this.schema.hasColumn('chat_sessions', 'scope')
    if (!hasChatFamilyId || !hasChatOwnerUserId || !hasChatScope) {
      this.schema.alterTable('chat_sessions', (table) => {
        if (!hasChatFamilyId) {
          table.integer('family_id').unsigned().nullable().references('id').inTable('families').onDelete('CASCADE')
          table.index(['family_id'])
        }
        if (!hasChatOwnerUserId) {
          table.integer('owner_user_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE')
          table.index(['owner_user_id'])
        }
        if (!hasChatScope) {
          table.enum('scope', ['user_private']).notNullable().defaultTo('user_private')
        }
      })
    }

    const hasLibraryItems = await this.schema.hasTable('library_items')
    if (!hasLibraryItems) {
      this.schema.createTable('library_items', (table) => {
        table.increments('id')
        table.string('source', 1024).notNullable().unique()
        table.string('storage_path', 1024).notNullable()
        table.string('display_name').notNullable()
        table.enum('scope', ['user_private', 'family_shared']).notNullable()
        table.enum('status', ['pending', 'approved']).notNullable().defaultTo('pending')
        table.integer('family_id').unsigned().notNullable().references('id').inTable('families').onDelete('CASCADE')
        table.integer('owner_user_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE')
        table.integer('uploaded_by_user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
        table.integer('approved_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
        table.timestamp('created_at')
        table.timestamp('updated_at')
        table.index(['family_id', 'scope', 'status'])
        table.index(['owner_user_id'])
      })
    }

    const hasMemoryEntries = await this.schema.hasTable('memory_entries')
    if (!hasMemoryEntries) {
      this.schema.createTable('memory_entries', (table) => {
        table.increments('id')
        table.integer('family_id').unsigned().notNullable().references('id').inTable('families').onDelete('CASCADE')
        table.integer('owner_user_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE')
        table.enum('scope', ['user_private', 'family_shared']).notNullable()
        table.string('subject_name').notNullable()
        table.text('fact').notNullable()
        table.text('normalized_fact').notNullable()
        table.integer('created_by_user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
        table.timestamp('created_at')
        table.timestamp('updated_at')
        table.index(['family_id', 'scope', 'subject_name'])
        table.index(['owner_user_id', 'scope', 'subject_name'])
      })
    }
  }

  async down() {
    this.schema.dropTable('memory_entries')
    this.schema.dropTable('library_items')

    this.schema.alterTable('chat_sessions', (table) => {
      table.dropColumn('scope')
      table.dropColumn('owner_user_id')
      table.dropColumn('family_id')
    })

    this.schema.dropTable('users')
    this.schema.dropTable('families')
  }
}
