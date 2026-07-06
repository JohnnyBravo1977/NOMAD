import vine from '@vinejs/vine'

const attachmentSchema = vine.object({
  id: vine.string().trim().minLength(1),
  name: vine.string().trim().minLength(1),
  mimeType: vine.string().trim().minLength(1),
  size: vine.number().positive(),
  kind: vine.enum(['image', 'pdf'] as const),
  token: vine.string().trim().minLength(1),
  viewUrl: vine.string().trim().optional(),
  width: vine.number().positive().optional(),
  height: vine.number().positive().optional(),
})

export const createSessionSchema = vine.compile(
  vine.object({
    title: vine.string().trim().minLength(1).maxLength(200),
    model: vine.string().trim().optional(),
  })
)

export const updateSessionSchema = vine.compile(
  vine.object({
    title: vine.string().trim().minLength(1).maxLength(200).optional(),
    model: vine.string().trim().optional(),
  })
)

export const addMessageSchema = vine.compile(
  vine.object({
    role: vine.enum(['system', 'user', 'assistant'] as const),
    content: vine.string().trim().minLength(1),
    attachments: vine.array(attachmentSchema).optional(),
  })
)
