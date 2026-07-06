import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { inject } from '@adonisjs/core'
import { UserSpaceContextService } from '#services/user_space_context_service'
import { UserSpaceService, type NomadUserSpace } from '#services/user_space_service'

type UserSpaceContext = HttpContext & {
  userSpace?: NomadUserSpace
}

@inject()
export default class UserSpaceMiddleware {
  constructor(private userSpaceService: UserSpaceService) {}

  async handle(ctx: HttpContext, next: NextFn) {
    const userSpace = await this.userSpaceService.resolveRequestSpace(ctx.request)
    ;(ctx as UserSpaceContext).userSpace = userSpace || undefined

    return UserSpaceContextService.run(userSpace, () => next())
  }
}
