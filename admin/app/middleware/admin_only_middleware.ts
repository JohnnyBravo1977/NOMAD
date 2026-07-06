import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { inject } from '@adonisjs/core'
import { UserSpaceService, type NomadUserSpace } from '#services/user_space_service'

type UserSpaceContext = HttpContext & {
  userSpace?: NomadUserSpace
}

@inject()
export default class AdminOnlyMiddleware {
  constructor(private userSpaceService: UserSpaceService) {}

  async handle(ctx: HttpContext, next: NextFn) {
    const existing = (ctx as UserSpaceContext).userSpace
    const userSpace = existing || (await this.userSpaceService.resolveRequestSpace(ctx.request))

    if (!userSpace?.canAccessAdminTools) {
      return ctx.response.status(403).send({
        error: 'Admin access required.',
      })
    }

    return next()
  }
}
