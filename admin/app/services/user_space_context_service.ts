import { AsyncLocalStorage } from 'node:async_hooks'
import type { NomadUserSpace } from '#services/user_space_service'

type UserSpaceStore = {
  userSpace: NomadUserSpace | null
}

export class UserSpaceContextService {
  private static readonly storage = new AsyncLocalStorage<UserSpaceStore>()

  static run<T>(userSpace: NomadUserSpace | null, callback: () => T): T {
    return this.storage.run({ userSpace }, callback)
  }

  static get(): NomadUserSpace | null {
    return this.storage.getStore()?.userSpace ?? null
  }
}
