import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { inject } from '@adonisjs/core'
import { UserSpaceService } from '#services/user_space_service'

@inject()
export default class AuthRequiredMiddleware {
  constructor(private userSpaceService: UserSpaceService) {}

  async handle(ctx: HttpContext, next: NextFn) {
    const path = ctx.request.url()
    if (
      path === '/login' ||
      path === '/api/auth/login' ||
      path === '/api/auth/quick-create-user' ||
      path === '/api/auth/logout' ||
      path === '/api/health'
    ) {
      return next()
    }

    const user = await this.userSpaceService.resolveRequestUser(ctx.request)
    if (user) {
      return next()
    }

    if (path.startsWith('/api/')) {
      return ctx.response.status(401).send({
        error: 'Authentication required.',
      })
    }

    return ctx.response.redirect().toPath('/login')
  }
}
