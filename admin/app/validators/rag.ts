import vine from '@vinejs/vine'

export const uploadFileSchema = vine.compile(
  vine.object({
    scope: vine.enum(['user_private', 'family_shared'] as const).optional(),
  })
)

export const getJobStatusSchema = vine.compile(
  vine.object({
    filePath: vine.string(),
  })
)

export const deleteFileSchema = vine.compile(
  vine.object({
    source: vine.string(),
  })
)
