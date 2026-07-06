import { DateTime } from 'luxon'
import { BaseModel, column, SnakeCaseNamingStrategy } from '@adonisjs/lucid/orm'

export type MemoryEntryScope = 'user_private' | 'family_shared'

export default class MemoryEntry extends BaseModel {
  static namingStrategy = new SnakeCaseNamingStrategy()

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare family_id: number

  @column()
  declare owner_user_id: number | null

  @column()
  declare scope: MemoryEntryScope

  @column()
  declare subject_name: string

  @column()
  declare fact: string

  @column()
  declare normalized_fact: string

  @column()
  declare created_by_user_id: number | null

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime
}
