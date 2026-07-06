import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

export default class NoStoreHtmlMiddleware {
  async handle({ request, response }: HttpContext, next: NextFn) {
    await next()

    const contentType = response.getHeader('content-type')
    const normalizedContentType = Array.isArray(contentType) ? contentType.join(';') : String(contentType || '')
    const isHtmlLikeRequest =
      request.method() === 'GET' &&
      !request.url().startsWith('/api') &&
      normalizedContentType.includes('text/html')

    if (!isHtmlLikeRequest) return

    response.response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    response.response.setHeader('Pragma', 'no-cache')
    response.response.setHeader('Expires', '0')
  }
}
