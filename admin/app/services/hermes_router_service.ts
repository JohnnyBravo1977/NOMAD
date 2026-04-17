import { inject } from '@adonisjs/core'
import { ChatOrchestratorService } from '#services/chat_orchestrator_service'

@inject()
export class HermesRouterService {
  constructor(private chatOrchestratorService: ChatOrchestratorService) {}

  async runChatTurn(args: Parameters<ChatOrchestratorService['runChatTurn']>[0]) {
    return this.chatOrchestratorService.runChatTurn(args)
  }

  async describeRuntimeCapabilities() {
    return this.chatOrchestratorService.describeRuntimeCapabilities()
  }
}
