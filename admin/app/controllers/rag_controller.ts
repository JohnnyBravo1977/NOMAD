import { RagService } from '#services/rag_service'
import { EmbedFileJob } from '#jobs/embed_file_job'
import LibraryItem from '#models/library_item'
import { UserSpaceService } from '#services/user_space_service'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { sanitizeFilename } from '../utils/fs.js'
import { deleteFileSchema, getJobStatusSchema, uploadFileSchema } from '#validators/rag'

@inject()
export default class RagController {
  constructor(
    private ragService: RagService,
    private userSpaceService: UserSpaceService
  ) { }

  public async upload({ request, response }: HttpContext) {
    const userSpace = await this.userSpaceService.resolveRequestSpace(request)
    if (!userSpace) {
      return response.status(401).json({ error: 'Authentication required.' })
    }
    const uploadData = await uploadFileSchema.validate({
      scope: request.input('scope'),
    })
    const uploadedFile = request.file('file')
    if (!uploadedFile) {
      return response.status(400).json({ error: 'No file uploaded' })
    }

    const scope = uploadData.scope || 'user_private'
    if (scope === 'family_shared' && !userSpace.canUploadFamilyShared) {
      return response.status(403).json({
        error: 'This account cannot upload into family shared space without admin approval.',
      })
    }

    if ((uploadedFile.extname || '').toLowerCase() === 'zip') {
      const tempName = `${randomBytes(8).toString('hex')}.zip`
      await uploadedFile.move('/tmp', { name: tempName, overwrite: true })

      if (!uploadedFile.filePath) {
        return response.status(500).json({ error: 'Failed to store uploaded ZIP file.' })
      }

      try {
        const result = await this.ragService.importZipUpload(
          uploadedFile.filePath,
          uploadedFile.clientName,
          scope,
          userSpace
        )

        if (!result.success) {
          return response.status(400).json({ error: result.message })
        }

        return response.status(202).json({
          message: result.message,
          queuedFiles: result.queuedFiles,
          skippedFiles: result.skippedFiles,
          filePaths: result.filePaths,
          scope,
        })
      } finally {
        await rm(uploadedFile.filePath, { force: true }).catch(() => {})
      }
    }

    const randomSuffix = randomBytes(6).toString('hex')
    const sanitizedName = sanitizeFilename(uploadedFile.clientName)

    const fileName = `${sanitizedName}-${randomSuffix}.${uploadedFile.extname || 'txt'}`
    const storageSegments =
      scope === 'family_shared'
        ? ['families', userSpace.family.slug, 'shared']
        : ['users', userSpace.user.slug]
    const storagePath = join(RagService.UPLOADS_STORAGE_PATH, ...storageSegments)
    const fullPath = app.makePath(storagePath, fileName)

    await uploadedFile.move(app.makePath(storagePath), {
      name: fileName,
    })

    const source = fullPath

    await LibraryItem.updateOrCreate(
      { source },
      {
        source,
        storage_path: storagePath,
        display_name: uploadedFile.clientName,
        scope,
        status: scope === 'family_shared' ? 'approved' : 'approved',
        family_id: userSpace.family.id,
        owner_user_id: scope === 'user_private' ? userSpace.user.id : null,
        uploaded_by_user_id: userSpace.user.id,
        approved_by_user_id: scope === 'family_shared' && userSpace.canAccessAdminTools ? userSpace.user.id : null,
      }
    )

    // Dispatch background job for embedding
    const result = await EmbedFileJob.dispatch({
      filePath: fullPath,
      fileName,
    })

    return response.status(202).json({
      message: result.message,
      jobId: result.jobId,
      fileName,
      filePath: `/${storagePath}/${fileName}`,
      alreadyProcessing: !result.created,
      scope,
    })
  }

  public async getActiveJobs({ response }: HttpContext) {
    const jobs = await EmbedFileJob.listActiveJobs()
    return response.status(200).json(jobs)
  }

  public async getJobStatus({ request, response }: HttpContext) {
    const reqData = await request.validateUsing(getJobStatusSchema)

    const fullPath = app.makePath(RagService.UPLOADS_STORAGE_PATH, reqData.filePath)
    const status = await EmbedFileJob.getStatus(fullPath)

    if (!status.exists) {
      return response.status(404).json({ error: 'Job not found for this file' })
    }

    return response.status(200).json(status)
  }

  public async getStoredFiles({ request, response }: HttpContext) {
    const userSpace = await this.userSpaceService.resolveRequestSpace(request)
    if (!userSpace) {
      return response.status(401).json({ error: 'Authentication required.' })
    }
    const files = await this.ragService.getUploadedStoredFiles(userSpace)
    return response.status(200).json({ files })
  }

  public async deleteFile({ request, response }: HttpContext) {
    const userSpace = await this.userSpaceService.resolveRequestSpace(request)
    if (!userSpace) {
      return response.status(401).json({ error: 'Authentication required.' })
    }
    const { source } = await request.validateUsing(deleteFileSchema)
    const result = await this.ragService.deleteFileBySource(source, userSpace)
    if (!result.success) {
      return response.status(500).json({ error: result.message })
    }
    return response.status(200).json({ message: result.message })
  }

  public async getFailedJobs({ response }: HttpContext) {
    const jobs = await EmbedFileJob.listFailedJobs()
    return response.status(200).json(jobs)
  }

  public async cleanupFailedJobs({ response }: HttpContext) {
    const result = await EmbedFileJob.cleanupFailedJobs()
    return response.status(200).json({
      message: `Cleaned up ${result.cleaned} failed job${result.cleaned !== 1 ? 's' : ''}${result.filesDeleted > 0 ? `, deleted ${result.filesDeleted} file${result.filesDeleted !== 1 ? 's' : ''}` : ''}.`,
      ...result,
    })
  }

  public async scanAndSync({ response }: HttpContext) {
    try {
      const syncResult = await this.ragService.scanAndSyncStorage()
      return response.status(200).json(syncResult)
    } catch (error) {
      return response.status(500).json({ error: 'Error scanning and syncing storage', details: error.message })
    }
  }
}
