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

export const chatSchema = vine.compile(
  vine.object({
    model: vine.string().trim().minLength(1),
    messages: vine.array(
      vine.object({
        role: vine.enum(['system', 'user', 'assistant'] as const),
        content: vine.string(),
        attachments: vine.array(attachmentSchema).optional(),
      })
    ),
    stream: vine.boolean().optional(),
    think: vine.boolean().optional(),
    sessionId: vine.number().positive().optional(),
    debug: vine.boolean().optional(),
  })
)

export const getAvailableModelsSchema = vine.compile(
  vine.object({
    sort: vine.enum(['pulls', 'name'] as const).optional(),
    recommendedOnly: vine.boolean().optional(),
    query: vine.string().trim().optional(),
    limit: vine.number().positive().optional(),
    force: vine.boolean().optional(),
  })
)
