import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    const hasUsers = await this.schema.hasTable('users')
    if (!hasUsers) {
      return
    }

    const hasPinHash = await this.schema.hasColumn('users', 'pin_hash')
    if (hasPinHash) {
      return
    }

    this.schema.alterTable('users', (table) => {
      table.text('pin_hash').nullable().after('display_name')
    })
  }

  async down() {
    const hasUsers = await this.schema.hasTable('users')
    if (!hasUsers) {
      return
    }

    const hasPinHash = await this.schema.hasColumn('users', 'pin_hash')
    if (!hasPinHash) {
      return
    }

    this.schema.alterTable('users', (table) => {
      table.dropColumn('pin_hash')
    })
  }
}
