
export const KV_STORE_SCHEMA = {
  'chat.suggestionsEnabled':    'boolean',
  'chat.lastModel':             'string',
  'rag.docsEmbedded':           'boolean',
  'system.updateAvailable':     'boolean',
  'system.latestVersion':       'string',
  'system.earlyAccess':         'boolean',
  'ui.hasVisitedEasySetup':     'boolean',
  'ui.theme':                   'string',
  'ai.assistantCustomName':     'string',
  'ai.systemPrompt':            'string',
  'ai.userName':                'string',
  'ai.userProfiles':            'string',
  'ai.activeUserName':          'string',
  'ai.userProfilesLastSync':    'string',
  'gpu.type':                   'string',
  'ai.remoteOllamaUrl':         'string',
  'ai.ollamaFlashAttention':    'boolean',
} as const

type KVTagToType<T extends string> = T extends 'boolean' ? boolean : string

export type KVStoreKey = keyof typeof KV_STORE_SCHEMA
export type KVStoreValue<K extends KVStoreKey> = KVTagToType<(typeof KV_STORE_SCHEMA)[K]>
