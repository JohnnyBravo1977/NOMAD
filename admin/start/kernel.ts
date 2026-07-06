/*
|--------------------------------------------------------------------------
| HTTP kernel file
|--------------------------------------------------------------------------
|
| The HTTP kernel file is used to register the middleware with the server
| or the router.
|
*/

import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

const serverMiddleware: Array<() => Promise<any>> = [
  () => import('#middleware/container_bindings_middleware'),
  () => import('@adonisjs/cors/cors_middleware'),
  () => import('@adonisjs/inertia/inertia_middleware'),
  () => import('@adonisjs/static/static_middleware'),
  () => import('#middleware/maps_static_middleware'),
]

if (process.env.NODE_ENV !== 'test') {
  serverMiddleware.splice(2, 0, () => import('@adonisjs/vite/vite_middleware'))
}

/**
 * The error handler is used to convert an exception
 * to an HTTP response.
 */
server.errorHandler(() => import('#exceptions/handler'))

/**
 * The server middleware stack runs middleware on all the HTTP
 * requests, even if there is no route registered for
 * the request URL.
 */
server.use([...serverMiddleware])

/**
 * The router middleware stack runs middleware on all the HTTP
 * requests with a registered route.
 */
router.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
  () => import('#middleware/auth_required_middleware'),
  () => import('#middleware/user_space_middleware'),
  () => import('#middleware/no_store_html_middleware'),
  // () => import('@adonisjs/session/session_middleware'),
  () => import('@adonisjs/shield/shield_middleware'),
  () => import('#middleware/compression_middleware'),
])

/**
 * Named middleware collection must be explicitly assigned to
 * the routes or the routes group.
 */
export const middleware = router.named({
  adminOnly: () => import('#middleware/admin_only_middleware'),
})
