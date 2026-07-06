import { DateTime } from 'luxon'
import { BaseModel, column, SnakeCaseNamingStrategy } from '@adonisjs/lucid/orm'

export type LibraryItemScope = 'user_private' | 'family_shared'
export type LibraryItemStatus = 'pending' | 'approved'

export default class LibraryItem extends BaseModel {
  static namingStrategy = new SnakeCaseNamingStrategy()

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare source: string

  @column()
  declare storage_path: string

  @column()
  declare display_name: string

  @column()
  declare scope: LibraryItemScope

  @column()
  declare status: LibraryItemStatus

  @column()
  declare family_id: number

  @column()
  declare owner_user_id: number | null

  @column()
  declare uploaded_by_user_id: number

  @column()
  declare approved_by_user_id: number | null

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime
}
