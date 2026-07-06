import { DateTime } from 'luxon'
import { BaseModel, belongsTo, column, SnakeCaseNamingStrategy } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Family from './family.js'

export type UserRole = 'admin' | 'user'

export default class User extends BaseModel {
  static namingStrategy = new SnakeCaseNamingStrategy()

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare family_id: number

  @column()
  declare slug: string

  @column()
  declare display_name: string

  @column()
  declare pin_hash: string | null

  @column()
  declare role: UserRole

  @column()
  declare is_active: boolean

  @belongsTo(() => Family, {
    foreignKey: 'family_id',
    localKey: 'id',
  })
  declare family: BelongsTo<typeof Family>

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime
}
