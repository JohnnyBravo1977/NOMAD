import { KVStoreKey } from "../types/kv_store.js";

export const SETTINGS_KEYS: KVStoreKey[] = [
  'chat.suggestionsEnabled',
  'chat.lastModel',
  'ui.hasVisitedEasySetup',
  'ui.theme',
  'system.earlyAccess',
  'ai.assistantCustomName',
  'ai.systemPrompt',
  'ai.userName',
  'ai.userProfiles',
  'ai.activeUserName',
  'ai.userProfilesLastSync',
  'ai.remoteOllamaUrl',
  'ai.openhandsUrl',
  'ai.openhandsLastConversationId',
  'ai.openhandsWarmConversationId',
  'ai.ollamaFlashAttention',
]
