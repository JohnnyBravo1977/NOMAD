import KVStore from '#models/kv_store'
import { BenchmarkService } from '#services/benchmark_service'
import { ConversationGateService } from '#services/conversation_gate_service'
import { MapService } from '#services/map_service'
import { OllamaService } from '#services/ollama_service'
import { SystemService } from '#services/system_service'
import { getSettingSchema, updateSettingSchema } from '#validators/settings'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'

@inject()
export default class SettingsController {
  constructor(
    private systemService: SystemService,
    private mapService: MapService,
    private benchmarkService: BenchmarkService,
    private ollamaService: OllamaService,
    private conversationGateService: ConversationGateService
  ) {}

  async system({ inertia }: HttpContext) {
    const systemInfo = await this.systemService.getSystemInfo()
    return inertia.render('settings/system', {
      system: {
        info: systemInfo,
      },
    })
  }

  async apps({ inertia }: HttpContext) {
    const services = await this.systemService.getServices({ installedOnly: false })
    return inertia.render('settings/apps', {
      system: {
        services,
      },
    })
  }

  async legal({ inertia }: HttpContext) {
    return inertia.render('settings/legal')
  }

  async support({ inertia }: HttpContext) {
    return inertia.render('settings/support')
  }

  async maps({ inertia }: HttpContext) {
    const baseAssetsCheck = await this.mapService.ensureBaseAssets()
    const regionFiles = await this.mapService.listRegions()
    return inertia.render('settings/maps', {
      maps: {
        baseAssetsExist: baseAssetsCheck,
        regionFiles: regionFiles.files,
      },
    })
  }

  async models({ inertia }: HttpContext) {
    const availableModels = await this.ollamaService.getAvailableModels({
      sort: 'pulls',
      recommendedOnly: false,
      query: null,
      limit: 15,
    })
    const installedModels = await this.ollamaService.getModels().catch(() => [])
    const chatSuggestionsEnabled = await KVStore.getValue('chat.suggestionsEnabled')
    const aiAssistantCustomName = await KVStore.getValue('ai.assistantCustomName')
    const remoteOllamaUrl = await KVStore.getValue('ai.remoteOllamaUrl')
    const ollamaFlashAttention = await KVStore.getValue('ai.ollamaFlashAttention')
    return inertia.render('settings/models', {
      models: {
        availableModels: availableModels?.models || [],
        installedModels: installedModels || [],
        settings: {
          chatSuggestionsEnabled: chatSuggestionsEnabled ?? false,
          aiAssistantCustomName: aiAssistantCustomName ?? '',
          remoteOllamaUrl: remoteOllamaUrl ?? '',
          ollamaFlashAttention: ollamaFlashAttention ?? true,
        },
      },
    })
  }

  async update({ inertia }: HttpContext) {
    const updateInfo = await this.systemService.checkLatestVersion()
    return inertia.render('settings/update', {
      system: {
        updateAvailable: updateInfo.updateAvailable,
        latestVersion: updateInfo.latestVersion,
        currentVersion: updateInfo.currentVersion,
      },
    })
  }

  async zim({ inertia }: HttpContext) {
    return inertia.render('settings/zim/index')
  }

  async zimRemote({ inertia }: HttpContext) {
    return inertia.render('settings/zim/remote-explorer')
  }

  async benchmark({ inertia }: HttpContext) {
    const latestResult = await this.benchmarkService.getLatestResult()
    const status = this.benchmarkService.getStatus()
    return inertia.render('settings/benchmark', {
      benchmark: {
        latestResult,
        status: status.status,
        currentBenchmarkId: status.benchmarkId,
      },
    })
  }

  async getSetting({ request, response }: HttpContext) {
    const { key } = await getSettingSchema.validate({ key: request.qs().key });
    const value = await KVStore.getValue(key);
    return response.status(200).send({ key, value });
  }

  async updateSetting({ request, response }: HttpContext) {
    const reqData = await request.validateUsing(updateSettingSchema)
    const gatedKeys = new Set(['ai.systemPrompt', 'ai.assistantCustomName'])
    const shouldGate = gatedKeys.has(reqData.key)

    const previousValue = shouldGate ? await KVStore.getValue(reqData.key as any) : undefined
    await this.systemService.updateSetting(reqData.key, reqData.value)

    if (shouldGate) {
      if (reqData.key === 'ai.systemPrompt') {
        void this.runBackgroundConversationGate(reqData.key, previousValue, reqData.value)
        return response.status(200).send({
          success: true,
          message: 'Chat style saved. Background conversation check started.',
          gatePending: true,
        })
      }

      try {
        const gate = await this.runConversationGateWithTimeout(reqData.key)

        if (!gate.ok) {
          // Roll back the setting to keep the runtime stable.
          await this.systemService.updateSetting(reqData.key, previousValue)
          return response.status(400).send({
            success: false,
            message: `Conversation/personality gate failed. Reverted ${reqData.key}.`,
            gate,
          })
        }
      } catch (error) {
        await this.systemService.updateSetting(reqData.key, previousValue)
        return response.status(500).send({
          success: false,
          message: `Conversation/personality gate errored. Reverted ${reqData.key}.`,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return response.status(200).send({ success: true, message: 'Setting updated successfully' })
  }

  private buildGateArgs(key: string) {
    return key === 'ai.assistantCustomName'
      ? {
          modes: ['json' as const],
          onlyCaseIds: ['assistant_identity', 'status_check_basic', 'greeting'],
        }
      : {
          modes: ['json' as const],
          onlyCaseIds: [
            'status_check_basic',
            'assistant_identity',
            'greeting',
            'gratitude',
            'relationship_after_shortcut_history',
            'critique_flatness_after_shortcut_history',
            'future_plan_excitement_chat',
          ],
        }
  }

  private async runConversationGateWithTimeout(key: string) {
    const gateTimeoutMs = key === 'ai.assistantCustomName' ? 90_000 : 150_000
    return Promise.race([
      this.conversationGateService.runConversationGate(this.buildGateArgs(key)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Conversation/personality gate timed out after ${gateTimeoutMs}ms.`)), gateTimeoutMs)
      ),
    ])
  }

  private async runBackgroundConversationGate(
    key: string,
    previousValue: any,
    nextValue: any
  ): Promise<void> {
    try {
      const gate = await this.runConversationGateWithTimeout(key)
      if (gate.ok) return

      const currentValue = await KVStore.getValue(key as any)
      if (currentValue === nextValue) {
        await this.systemService.updateSetting(key as any, previousValue)
      }
    } catch (error) {
      const currentValue = await KVStore.getValue(key as any)
      if (currentValue === nextValue) {
        await this.systemService.updateSetting(key as any, previousValue)
      }
    }
  }
}
