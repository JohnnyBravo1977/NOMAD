/*
|--------------------------------------------------------------------------
| HTTP server entrypoint
|--------------------------------------------------------------------------
|
| The "server.ts" file is the entrypoint for starting the AdonisJS HTTP
| server. Either you can run this file directly or use the "serve"
| command to run this file and monitor file changes
|
*/

import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'

/**
 * URL to the application root. AdonisJS need it to resolve
 * paths to file and directories for scaffolding commands
 */
const APP_ROOT = new URL('../', import.meta.url)

/**
 * The importer is used to import files in context of the
 * application.
 */
const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    const startOpenHandsPrewarm = async () => {
      const maxAttempts = 20
      const retryDelayMs = 15000

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const { OpenHandsWorkerService } = await import('#services/openhands_worker_service')
          const openHandsWorkerService = new OpenHandsWorkerService()
          const result = await openHandsWorkerService.ensureWarmRuntime()

          if (result.ok) {
            console.info(
              `[OpenHandsPrewarm] Warm runtime ${result.created ? 'created' : 'already available'} (${result.conversationId || 'unknown conversation'}).`
            )
            return
          }

          console.info(
            `[OpenHandsPrewarm] Warm runtime not ready yet (attempt ${attempt}/${maxAttempts}): ${result.message || 'service unavailable'}`
          )
        } catch (error: any) {
          console.warn(
            `[OpenHandsPrewarm] Warm runtime attempt ${attempt}/${maxAttempts} failed: ${error?.message || error}`
          )
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }

      console.warn('[OpenHandsPrewarm] Gave up trying to prewarm OpenHands after repeated startup attempts.')
    }

    app.booting(async () => {
      await import('#start/env')
    })
    app.listen('SIGTERM', () => app.terminate())
    app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
    app.ready(async () => {
      void startOpenHandsPrewarm()

      try {
        const collectionManifestService = new (await import('#services/collection_manifest_service')).CollectionManifestService()
        await collectionManifestService.reconcileFromFilesystem()
      } catch (error) {
        // Catch and log any errors during reconciliation to prevent the server from crashing
        console.error('Error during collection manifest reconciliation:', error)
      }
    })
  })
  .httpServer()
  .start()
  .catch((error) => {
    process.exitCode = 1
    prettyPrintError(error)
  })
