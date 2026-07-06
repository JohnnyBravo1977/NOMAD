import { inject } from '@adonisjs/core'
import { ChatOrchestratorService } from '#services/chat_orchestrator_service'
import { ComfyUiWorkerService } from '#services/comfyui_worker_service'
import { DirectToolMatch, DirectToolRegistryService } from '#services/direct_tool_registry_service'
import { EditWorkerService } from '#services/edit_worker_service'
import { HomeAssistantWorkerService } from '#services/home_assistant_worker_service'
import { OllamaService } from '#services/ollama_service'
import { ReadWorkerService } from '#services/read_worker_service'
import { SystemWorkerService } from '#services/system_worker_service'
import { TerminalWorkerService } from '#services/terminal_worker_service'
import { WorkerFlowMatch, WorkerFlowRegistryService } from '#services/worker_flow_registry_service'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'

type ChatRequestInput = Parameters<ChatOrchestratorService['runChatTurn']>[0]['requestData']

type ChatMessage = ChatRequestInput['messages'][number]

export type HermesTurnType = 'chat' | 'task' | 'mixed' | 'task_followup' | 'clarification'

const STRUCTURAL_TYPO_VOCABULARY = new Set([
  'what',
  'whats',
  'who',
  'how',
  'can',
  'could',
  'would',
  'my',
  'me',
  'your',
  'you',
  'name',
  'names',
  'wife',
  'kids',
  'children',
  'stored',
  'memory',
  'remember',
  'about',
  'tell',
  'know',
  'list',
  'show',
  'inspect',
  'read',
  'open',
  'check',
  'run',
  'create',
  'make',
  'add',
  'remove',
  'delete',
  'erase',
  'diagnose',
  'repair',
  'restart',
  'verify',
  'patch',
  'replace',
  'write',
  'edit',
  'container',
  'containers',
  'docker',
  'file',
  'files',
  'service',
  'logs',
  'config',
  'terminal',
  'shortcut',
  'launcher',
  'desktop',
  'house',
  'home',
  'assistant',
  'lights',
  'light',
  'lamp',
  'door',
  'doors',
  'lock',
  'unlock',
  'turn',
  'thermostat',
  'temperature',
  'mode',
  'water',
  'pressure',
  'tank',
  'level',
  'living',
  'room',
  'humidity',
  'sprinklers',
  'porch',
  'front',
  'attention',
  'status',
  'summary',
  'time',
  'date',
  'day',
  'today',
  'todays',
  'safe',
  'command',
  'pwd',
  'homeassistant',
  'nomad',
  'pin',
  'unpin',
  'again',
  'retry',
  'followup',
])

export type HermesStructuredIntent = {
  intent?: string
  route:
    | 'chat'
    | 'direct_tool'
    | 'worker_flow'
    | 'home_assistant'
    | 'comfyui'
    | 'system'
    | 'terminal'
    | 'read'
    | 'edit'
  tool?: string
  canonical_request?: string
  args?: Record<string, any>
  confidence?: number
}

export type HermesChatSegment = {
  order: number
  source_text: string
}

export type HermesTaskPayload = {
  order: number
  source_text: string
  intent?: string
  route: Exclude<HermesStructuredIntent['route'], 'chat'>
  tool?: string
  canonical_request: string
  args?: Record<string, any>
  depends_on?: string
}

export type HermesTurnContract = {
  turn_type: HermesTurnType
  source_text: string
  should_execute: boolean
  chat_segments: HermesChatSegment[]
  tasks: HermesTaskPayload[]
  confidence?: number
  clarification_reason?: string
  support_need?: {
    kind: 'emotional' | 'medical' | 'self_harm'
    urgency: 'routine' | 'urgent'
    reason?: string
  } | null
  response_mode?: 'supportive' | 'teaching' | 'assistant' | 'practical' | 'conversational' | null
}

@inject()
export class HermesRouterService {
  constructor(
    private chatOrchestratorService: ChatOrchestratorService,
    private ollamaService: OllamaService,
    private directToolRegistryService: DirectToolRegistryService,
    private workerFlowRegistryService: WorkerFlowRegistryService,
    private homeAssistantWorkerService: HomeAssistantWorkerService,
    private comfyUiWorkerService: ComfyUiWorkerService,
    private systemWorkerService: SystemWorkerService,
    private terminalWorkerService: TerminalWorkerService,
    private editWorkerService: EditWorkerService,
    private readWorkerService: ReadWorkerService
  ) {}

  async runChatTurn(
    args: Parameters<ChatOrchestratorService['runChatTurn']>[0]
  ): Promise<{
    result: Awaited<ReturnType<ChatOrchestratorService['runChatTurn']>>
    hermesTurn: HermesTurnContract | null
  }> {
    const hermesTurn = await this.classifyLatestIntent(args.requestData)
    const requestData = hermesTurn
      ? {
          ...args.requestData,
          hermesTurn,
        }
      : args.requestData

    const result = await this.chatOrchestratorService.runChatTurn({
      ...args,
      requestData,
    })
    return { result, hermesTurn }
  }

  async describeRuntimeCapabilities() {
    return this.chatOrchestratorService.describeRuntimeCapabilities()
  }

  private async classifyLatestIntent(
    requestData: ChatRequestInput
  ): Promise<HermesTurnContract | null> {
    const latestUserMessage = [...requestData.messages]
      .reverse()
      .find((message) => message.role === 'user')
    const userText = latestUserMessage?.content?.trim()
    if (!userText) return null

    // Keep routing stable even if the user swaps chat models for personality.
    // Override with NOMAD_HERMES_ROUTER_MODEL if you want a different router.
    const routingModel = env.get('NOMAD_HERMES_ROUTER_MODEL') || 'qwen2.5:7b-instruct-q4_K_M'
    const turnContract = await this.classifyTurnContract(
      userText,
      routingModel,
      requestData.messages
    )
    if (turnContract) {
      logger.info(
        `[HermesRouterService] Turn contract "${userText}" -> ${turnContract.turn_type} chat=${turnContract.chat_segments.length} tasks=${turnContract.tasks.map((task) => `${task.route}:${task.canonical_request}`).join(' | ')}`
      )
    }
    return turnContract
  }

  private async classifySingleIntent(
    userText: string,
    interpretedText: string,
    model: string
  ): Promise<HermesStructuredIntent | null> {
    const deterministic = this.classifyDeterministically(interpretedText)
    if (deterministic) {
      logger.info(
        `[HermesRouterService] Deterministic route "${userText}" -> ${deterministic.route}${deterministic.tool ? `/${deterministic.tool}` : ''} :: ${deterministic.canonical_request}`
      )
      return deterministic
    }

    try {
      const response = await this.ollamaService.chat({
        model,
        ...getHermesSamplingPreset(model),
        messages: [
          {
            role: 'system',
            content: [
              'You are Hermes, the routing brain behind Quinn.',
              'Decide whether the request requires external action right now or is only conversation.',
              'If it requires action outside the model right now, route it as a task.',
              'If the user is only talking about the task, planning, reflecting, or asking what should be done, route it as chat.',
              'Quinn interprets the human request naturally. Hermes decides the route, intent, tool, args, and canonical request.',
              'Return exactly one JSON object. No markdown. No explanation.',
              'Choose the single best route from: chat, direct_tool, worker_flow, home_assistant, comfyui, system, terminal, read, edit.',
              'If the request is an actionable task, produce a canonical_request that a deterministic worker can execute now.',
              'If the request is ordinary conversation or discussion-only, return route chat and omit the tool.',
              'Use intent as a short structural label like list_containers, inspect_file, read_file, create_shortcut, get_time, get_house_status, set_light_brightness, restart_service, or discuss_workflow.',
              'Use args only for structured execution values that can be extracted directly without paraphrasing meaning.',
              'Use these direct tools when they fit:',
              '- list_containers',
              '- inspect_docker_container',
              '- inspect_files',
              '- read_files',
              '- write_file',
              '- edit_file',
              '- create_shortcut',
              '- run_safe_command',
              'Use these worker-flow tools when they fit:',
              '- diagnose_container',
              '- patch_file_and_verify',
              '- restart_and_verify_service',
              '- inspect_logs_config_and_files',
              '- diagnose_home_assistant',
              '- repair_service_from_logs',
              'Canonical request examples:',
              '- create shortcut for home assistant',
              '- create shortcut for nomad',
              '- list containers',
              '- inspect docker container homeassistant',
              '- read file /app/package.json',
              '- inspect file /app/start/routes.js',
              '- run safe command pwd',
              '- diagnose container homeassistant',
              '- inspect logs, config, and files for homeassistant',
              '- diagnose home assistant',
              '- turn off the dining room light',
              '- set the dining room light brightness to 50%',
              '- house status summary',
              '- what needs attention in the house',
              '- open comfyui',
              '- open voice and settings',
              '- show comfyui status',
              '- what time is it',
              '- what time and day is it',
              '- use terminal to ls -1 /home/nomad/Desktop',
              'Decision rule:',
              '- If this requires a tool or external action right now, it is not chat.',
              '- If this only asks for discussion, reflection, planning, workflow, policy, memory, or what should be done, it is chat.',
              '- If unsure whether execution is required, prefer chat or low confidence instead of inventing a task.',
              'Be robust to polite phrasing and indirect wording.',
              'If the user asks for a desktop shortcut, route to direct_tool/create_shortcut and normalize the target.',
              'JSON schema:',
              '{"route":"direct_tool","intent":"create_shortcut","tool":"create_shortcut","canonical_request":"create shortcut for home assistant","args":{"target_name":"home assistant"},"confidence":0.98}',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [`User request: ${userText}`, `Routing text: ${interpretedText}`].join('\n'),
          },
        ],
      })

      const parsed = parseHermesStructuredIntent(response.message.content)
      if (!parsed) return null
      if (!parsed.canonical_request) return null
      if ((parsed.confidence ?? 0) < 0.72) return null

      logger.info(
        `[HermesRouterService] Routed "${userText}" -> ${parsed.route}${parsed.tool ? `/${parsed.tool}` : ''} :: ${parsed.canonical_request}`
      )
      return parsed
    } catch (error) {
      logger.warn(
        `[HermesRouterService] Intent classification failed: ${error instanceof Error ? error.message : error}`
      )
      return null
    }
  }

  private async classifyTurnContract(
    userText: string,
    model: string,
    messages: ChatMessage[]
  ): Promise<HermesTurnContract | null> {
    if (looksLikeMultiIntentTurn(userText)) {
      const mixedTurn = await this.classifyMixedTurnContract(userText, model, messages)
      if (mixedTurn) return mixedTurn
    }

    return this.classifySingleTurnContract(userText, model, messages)
  }

  private async classifyMixedTurnContract(
    userText: string,
    model: string,
    messages: ChatMessage[]
  ): Promise<HermesTurnContract | null> {
    if (!looksLikeMultiIntentTurn(userText)) return null

    const candidateSegments = splitTurnIntoCandidateSegments(userText)
    if (candidateSegments.length < 2) return null

    const chatSegments: HermesChatSegment[] = []
    const tasks: HermesTaskPayload[] = []

    for (let index = 0; index < candidateSegments.length; index += 1) {
      const candidateText = candidateSegments[index]
      const segmentText = candidateText.trim()
      if (!segmentText) continue

      const segmentType = await this.classifyTurnSegmentType(segmentText, userText, model)
      if (segmentType === 'task' || segmentType === 'task_followup') {
        const previousTaskContext =
          tasks.length > 0 ? tasks[tasks.length - 1].canonical_request : null
        const task = await this.buildTaskPayload(
          segmentText,
          model,
          messages,
          index + 1,
          previousTaskContext
        )
        if (task) {
          tasks.push(task)
          continue
        }
      }

      chatSegments.push({
        order: index + 1,
        source_text: segmentText,
      })
    }

    if (tasks.length === 0) {
      return {
        turn_type: 'chat',
        source_text: userText,
        should_execute: false,
        chat_segments:
          chatSegments.length > 0 ? chatSegments : [{ order: 1, source_text: userText }],
        tasks: [],
        confidence: 0.92,
      }
    }

    return {
      turn_type: 'mixed',
      source_text: userText,
      should_execute: true,
      chat_segments: chatSegments,
      tasks,
      confidence: 0.92,
    }
  }

  private async classifySingleTurnContract(
    userText: string,
    model: string,
    messages: ChatMessage[]
  ): Promise<HermesTurnContract | null> {
    const supportNeed = await this.assessSupportNeed(userText, model)
    const responseMode = await this.assessResponseMode(userText, model)
    if (supportNeed) {
      return {
        turn_type: 'chat',
        source_text: userText,
        should_execute: false,
        chat_segments: [{ order: 1, source_text: userText }],
        tasks: [],
        confidence: supportNeed.urgency === 'urgent' ? 0.99 : 0.95,
        support_need: supportNeed,
        response_mode:
          supportNeed.kind === 'medical' ||
          supportNeed.kind === 'emotional' ||
          supportNeed.kind === 'self_harm'
            ? 'supportive'
            : responseMode,
      }
    }

    const rawDeterministicTask = inferDeterministicHermesTask(userText)
    if (
      rawDeterministicTask &&
      rawDeterministicTask.route !== 'chat' &&
      rawDeterministicTask.canonical_request
    ) {
      return {
        turn_type: 'task',
        source_text: userText,
        should_execute: true,
        chat_segments: [],
        tasks: [
          {
            order: 1,
            source_text: userText,
            intent: rawDeterministicTask.intent,
            route: rawDeterministicTask.route,
            tool: rawDeterministicTask.tool,
            canonical_request: rawDeterministicTask.canonical_request,
            args: rawDeterministicTask.args,
          },
        ],
        confidence: rawDeterministicTask.confidence ?? 0.99,
      }
    }

    if (shouldStayInChatLane(userText)) {
      return {
        turn_type: 'chat',
        source_text: userText,
        should_execute: false,
        chat_segments: [{ order: 1, source_text: userText }],
        tasks: [],
        confidence: 0.99,
        response_mode: responseMode,
      }
    }

    if (looksLikeNegativeConfirmation(userText)) {
      return {
        turn_type: 'chat',
        source_text: userText,
        should_execute: false,
        chat_segments: [{ order: 1, source_text: userText }],
        tasks: [],
        confidence: 0.95,
        response_mode: responseMode,
      }
    }

    if (looksLikeAffirmativeConfirmation(userText)) {
      const confirmed = inferConfirmedTaskFromRecentAssistant(messages)
      if (confirmed) {
        return {
          turn_type: 'task',
          source_text: userText,
          should_execute: true,
          chat_segments: [],
          tasks: [
            {
              order: 1,
              source_text: userText,
              intent: 'confirmed_task',
              route: confirmed.route,
              canonical_request: confirmed.canonical_request,
            },
          ],
          confidence: 0.98,
        }
      }
    }

    const segmentType = await this.classifyTurnSegmentType(userText, userText, model)
    if (segmentType === 'chat') {
      return {
        turn_type: 'chat',
        source_text: userText,
        should_execute: false,
        chat_segments: [{ order: 1, source_text: userText }],
        tasks: [],
        confidence: 0.99,
        response_mode: responseMode,
      }
    }

    if (segmentType === 'clarification') {
      return {
        turn_type: 'clarification',
        source_text: userText,
        should_execute: false,
        chat_segments: [{ order: 1, source_text: userText }],
        tasks: [],
        confidence: 0.75,
        clarification_reason:
          'Hermes could not safely determine an executable target from the request alone.',
      }
    }

    const task = await this.buildTaskPayload(userText, model, messages, 1)
    if (task) {
      return {
        turn_type: task.depends_on ? 'task_followup' : 'task',
        source_text: userText,
        should_execute: true,
        chat_segments: [],
        tasks: [task],
        confidence: 0.99,
      }
    }

    return {
      turn_type: 'clarification',
      source_text: userText,
      should_execute: false,
      chat_segments: [{ order: 1, source_text: userText }],
      tasks: [],
      confidence: 0.7,
      clarification_reason: 'Hermes could not safely map the request to an executable task.',
    }
  }

  private async buildTaskPayload(
    sourceText: string,
    model: string,
    messages: ChatMessage[],
    order: number,
    inTurnDependencyText?: string | null
  ): Promise<HermesTaskPayload | null> {
    const rawDeterministicTask = inferDeterministicHermesTask(sourceText)
    if (
      rawDeterministicTask &&
      rawDeterministicTask.route !== 'chat' &&
      rawDeterministicTask.canonical_request
    ) {
      return {
        order,
        source_text: sourceText,
        intent: rawDeterministicTask.intent,
        route: rawDeterministicTask.route,
        tool: rawDeterministicTask.tool,
        canonical_request: rawDeterministicTask.canonical_request,
        args: rawDeterministicTask.args,
      }
    }

    if (looksLikeNegativeConfirmation(sourceText)) {
      return null
    }

    if (looksLikeAffirmativeConfirmation(sourceText)) {
      const confirmed = inferConfirmedTaskFromRecentAssistant(messages)
      if (confirmed) {
        return {
          order,
          source_text: sourceText,
          intent: 'confirmed_task',
          route: confirmed.route,
          canonical_request: confirmed.canonical_request,
        }
      }
    }

    if (isTaskFollowUpText(sourceText)) {
      const followUp = resolveTaskFollowUp(sourceText, messages, order, inTurnDependencyText)
      if (followUp) {
        if (looksLikeUnsupportedShortcutPinFollowUp(followUp)) {
          return followUp
        }

        const resolvedFollowUp = resolveFollowUpTaskPayload(followUp)
        if (
          !resolvedFollowUp &&
          /^(?:remove|delete|erase)\b.*\b(?:shortcut|launcher)\b/i.test(followUp.source_text)
        ) {
          // Shortcut removals like "remove the shortcut you just created" must not be
          // normalized into a bogus target. Keep as unresolved follow-up.
          return followUp
        }
        const followUpText = resolvedFollowUp?.canonical_request || followUp.canonical_request
        const deterministicFollowUp = this.classifyDeterministically(followUpText)
        if (
          deterministicFollowUp &&
          deterministicFollowUp.route !== 'chat' &&
          deterministicFollowUp.canonical_request
        ) {
          return {
            order,
            source_text: sourceText,
            intent: deterministicFollowUp.intent,
            route: deterministicFollowUp.route,
            tool: deterministicFollowUp.tool,
            canonical_request: deterministicFollowUp.canonical_request,
            args: deterministicFollowUp.args,
          }
        }

        const followUpIntent = await this.classifySingleIntent(sourceText, followUpText, model)
        if (followUpIntent && followUpIntent.route !== 'chat' && followUpIntent.canonical_request) {
          return {
            order,
            source_text: sourceText,
            intent: followUpIntent.intent,
            route: followUpIntent.route,
            tool: followUpIntent.tool,
            canonical_request: followUpIntent.canonical_request,
            args: followUpIntent.args,
          }
        }

        return resolvedFollowUp || followUp
      }
    }

    const interpretedSegment = normalizeNaturalRequestForHermes(sourceText)
    const classified = await this.classifySingleIntent(sourceText, interpretedSegment, model)
    if (classified && classified.route !== 'chat' && classified.canonical_request) {
      return {
        order,
        source_text: sourceText,
        intent: classified.intent,
        route: classified.route,
        tool: classified.tool,
        canonical_request: classified.canonical_request,
        args: classified.args,
      }
    }
    return null
  }

  private async assessSupportNeed(
    userText: string,
    model: string
  ): Promise<HermesTurnContract['support_need']> {
    const normalized = normalizeNaturalRequestForHermes(userText)
    const heuristic =
      inferSupportNeedHeuristically(userText) || inferSupportNeedHeuristically(normalized)
    if (heuristic?.urgency === 'urgent') {
      return heuristic
    }

    try {
      const response = await this.ollamaService.chat({
        model,
        ...getHermesSamplingPreset(model),
        messages: [
          {
            role: 'system',
            content: [
              'You are Hermes, the routing brain behind Quinn.',
              'Decide whether the user message needs an empathetic supportive response before any task routing.',
              'Return exactly one JSON object. No markdown. No explanation.',
              'Schema: {"support_need":"none|emotional|medical|self_harm","urgency":"routine|urgent","confidence":0.0,"reason":"short reason"}',
              'Rules:',
              '- Choose medical when the user describes symptoms, diagnoses, serious medical uncertainty, or possible medical danger.',
              '- Choose self_harm when the user expresses wanting to die, self-harm, suicide risk, or similar crisis signals.',
              '- Choose emotional when the user mainly needs empathy, comfort, or emotional support rather than tool action.',
              '- Choose none when this is a normal task request or ordinary discussion.',
              '- If the message likely needs empathy, triage, reassurance, or explanation before action, do not choose none.',
              '- If the message sounds urgent or dangerous, mark urgency urgent.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: userText,
          },
        ],
      })

      const parsed = parseSupportNeedAssessment(response.message.content)
      if (parsed && parsed.support_need !== 'none' && (parsed.confidence ?? 0) >= 0.7) {
        return {
          kind: parsed.support_need,
          urgency: parsed.urgency || 'routine',
          reason: parsed.reason,
        }
      }
    } catch (error) {
      logger.warn(
        `[HermesRouterService] Support-need classification failed: ${error instanceof Error ? error.message : error}`
      )
    }

    return heuristic
  }

  private async assessResponseMode(
    userText: string,
    model: string
  ): Promise<HermesTurnContract['response_mode']> {
    const normalized = normalizeNaturalRequestForHermes(userText)
    const heuristic =
      inferResponseModeHeuristically(userText) || inferResponseModeHeuristically(normalized)
    if (heuristic && heuristic !== 'conversational') {
      return heuristic
    }

    try {
      const response = await this.ollamaService.chat({
        model,
        ...getHermesSamplingPreset(model),
        messages: [
          {
            role: 'system',
            content: [
              'You are Hermes, the routing brain behind Quinn.',
              'Classify what kind of response posture the user most needs from Quinn right now.',
              'Return exactly one JSON object. No markdown. No explanation.',
              'Schema: {"response_mode":"supportive|teaching|assistant|practical|conversational","confidence":0.0,"reason":"short reason"}',
              'Rules:',
              '- supportive: empathy, reassurance, emotional presence, painful personal topics, fear, grief, illness, vulnerability.',
              '- teaching: the user wants to really understand something, learn deeply, build expertise, or be taught step by step.',
              '- assistant: the user wants Quinn to help organize, compare, plan, think through, or carry forward a serious project or body of information like a real aide.',
              '- practical: the user mainly needs concise concrete next steps, troubleshooting, or task-ready guidance.',
              '- conversational: ordinary back-and-forth where no strong special posture is needed.',
              '- Choose the dominant posture Quinn should take in the next reply, not the long-term topic category.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: userText,
          },
        ],
      })

      const parsed = parseResponseModeAssessment(response.message.content)
      if (parsed && (parsed.confidence ?? 0) >= 0.68) {
        return parsed.response_mode
      }
    } catch (error) {
      logger.warn(
        `[HermesRouterService] Response-mode classification failed: ${error instanceof Error ? error.message : error}`
      )
    }

    return heuristic || 'conversational'
  }

  private async classifyTurnSegmentType(
    segmentText: string,
    fullTurn: string,
    model: string
  ): Promise<HermesTurnType> {
    const deterministicKind = this.classifyTurnSegmentDeterministically(segmentText)
    if (deterministicKind) {
      return deterministicKind
    }

    const response = await this.ollamaService.chat({
      model,
      ...getHermesSamplingPreset(model),
      messages: [
        {
          role: 'system',
          content: [
            'You are Hermes, the routing brain behind Quinn.',
            'Classify one already-segmented span from a user turn.',
            'Return exactly one JSON object. No markdown. No explanation.',
            'Schema: {"turn_type":"chat|task|task_followup|clarification","confidence":0.0}',
            'Rules:',
            '- Ask one question first: does this segment require external action or a tool right now?',
            '- chat: the user is talking, reflecting, planning, asking why, asking what should be done, or discussing a task without requesting action now.',
            '- task: the user is requesting external action, external inspection, external retrieval, or tool execution now.',
            '- task_followup: the user is referring to prior task context like "set it to 50%" and the span depends on earlier task state.',
            '- clarification: the span is ambiguous enough that Hermes should ask for clarification instead of guessing.',
            '- Do not create a task for hypothetical, planning, speculative, or example phrasing.',
            '- If the span asks about capabilities, workflow, memory, policy, or strategy without needing execution, classify it as chat.',
            '- If you are unsure whether execution is required right now, classify it as clarification.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [`Full user turn:\n${fullTurn}`, `\nSegment to classify:\n${segmentText}`].join(
            '\n'
          ),
        },
      ],
    })

    const parsed = parseHermesTurnType(response.message.content)
    if (parsed) {
      const correctedKind = this.classifyTurnSegmentDeterministically(segmentText)
      if (correctedKind && correctedKind !== parsed.turn_type) {
        return correctedKind
      }
      return parsed.turn_type
    }
    return fallbackTurnSegmentClassification(segmentText)
  }

  private classifyTurnSegmentDeterministically(text: string): HermesTurnType | null {
    const rawText = text.trim()
    const interpretedText = normalizeNaturalRequestForHermes(text)
    const deterministicText = inferDeterministicHermesTask(rawText) ? rawText : interpretedText

    if (inferDeterministicHermesTask(deterministicText)) {
      return 'task'
    }

    if (
      isDeterministicExternalRead(rawText, {
        homeAssistantWorkerService: this.homeAssistantWorkerService,
        systemWorkerService: this.systemWorkerService,
        readWorkerService: this.readWorkerService,
        directToolRegistryService: this.directToolRegistryService,
      }) ||
      isDeterministicExternalRead(interpretedText, {
        homeAssistantWorkerService: this.homeAssistantWorkerService,
        systemWorkerService: this.systemWorkerService,
        readWorkerService: this.readWorkerService,
        directToolRegistryService: this.directToolRegistryService,
      })
    ) {
      return 'task'
    }

    if (shouldStayInChatLane(rawText) || shouldStayInChatLane(interpretedText)) {
      return 'chat'
    }

    if (isTaskFollowUpText(rawText) || isTaskFollowUpText(interpretedText)) {
      return 'task_followup'
    }

    if (needsClarification(rawText) || needsClarification(interpretedText)) {
      return 'clarification'
    }

    if (
      this.terminalWorkerService.parseRequestedCommand(rawText)?.source === 'shell_request' ||
      this.terminalWorkerService.parseRequestedCommand(interpretedText)?.source === 'shell_request'
    ) {
      return 'task'
    }

    if (
      this.directToolRegistryService.classify(rawText) ||
      this.directToolRegistryService.classify(interpretedText)
    ) {
      return 'task'
    }

    if (
      this.workerFlowRegistryService.classify(rawText) ||
      this.workerFlowRegistryService.classify(interpretedText)
    ) {
      return 'task'
    }

    if (
      this.homeAssistantWorkerService.classify(rawText) ||
      this.homeAssistantWorkerService.classify(interpretedText)
    ) {
      return 'task'
    }

    if (
      this.comfyUiWorkerService.classify(rawText) ||
      this.comfyUiWorkerService.classify(interpretedText)
    ) {
      return 'task'
    }

    if (
      this.systemWorkerService.classify(rawText) ||
      this.systemWorkerService.classify(interpretedText)
    ) {
      return 'task'
    }

    if (
      this.editWorkerService.classify(rawText) ||
      this.editWorkerService.classify(interpretedText)
    ) {
      return 'task'
    }

    if (
      this.readWorkerService.classify(rawText) ||
      this.readWorkerService.classify(interpretedText)
    ) {
      return 'task'
    }

    return null
  }

  private classifyDeterministically(interpretedText: string): HermesStructuredIntent | null {
    const deterministicHermesTask = inferDeterministicHermesTask(interpretedText)
    if (deterministicHermesTask) {
      return deterministicHermesTask
    }

    if (
      isDeterministicExternalRead(interpretedText, {
        homeAssistantWorkerService: this.homeAssistantWorkerService,
        systemWorkerService: this.systemWorkerService,
        readWorkerService: this.readWorkerService,
        directToolRegistryService: this.directToolRegistryService,
      })
    ) {
      if (this.homeAssistantWorkerService.classify(interpretedText)) {
        return {
          intent: inferHomeAssistantIntent(interpretedText),
          route: 'home_assistant',
          canonical_request: interpretedText,
          confidence: 0.99,
        }
      }

      if (this.comfyUiWorkerService.classify(interpretedText)) {
        return {
          intent: inferComfyUiIntent(interpretedText),
          route: 'comfyui',
          canonical_request: interpretedText,
          confidence: 0.99,
        }
      }

      if (this.systemWorkerService.classify(interpretedText)) {
        return {
          intent: inferSystemIntent(interpretedText),
          route: 'system',
          canonical_request: interpretedText,
          confidence: 0.99,
        }
      }

      if (this.readWorkerService.classify(interpretedText)) {
        return {
          intent: 'read_file',
          route: 'read',
          canonical_request: interpretedText,
          confidence: 0.99,
        }
      }

      if (this.directToolRegistryService.classify(interpretedText)) {
        const directMatch = this.directToolRegistryService.classify(interpretedText)
        if (directMatch) {
          return {
            intent: directMatch.tool,
            route: directMatch.tool === 'run_safe_command' ? 'terminal' : 'direct_tool',
            tool: directMatch.tool,
            canonical_request: canonicalizeDirectToolMatch(directMatch),
            confidence: 0.99,
          }
        }
      }
    }

    if (shouldStayInChatLane(interpretedText)) {
      return {
        intent: 'chat',
        route: 'chat',
        canonical_request: interpretedText,
        confidence: 0.99,
      }
    }

    const terminalTask = this.terminalWorkerService.parseRequestedCommand(interpretedText)
    if (terminalTask) {
      return {
        intent: 'run_command',
        route: 'terminal',
        tool:
          terminalTask.source === 'sidebar_request'
            ? terminalTask.brokerAction?.action || 'host_broker_action'
            : 'run_safe_command',
        canonical_request: interpretedText,
        confidence: 0.99,
      }
    }

    const directMatch = this.directToolRegistryService.classify(interpretedText)
    if (directMatch) {
      return {
        intent: directMatch.tool,
        route: directMatch.tool === 'run_safe_command' ? 'terminal' : 'direct_tool',
        tool: directMatch.tool,
        canonical_request: canonicalizeDirectToolMatch(directMatch),
        confidence: 0.99,
      }
    }

    const workerFlowMatch = this.workerFlowRegistryService.classify(interpretedText)
    if (workerFlowMatch) {
      return {
        intent: workerFlowMatch.tool,
        route: 'worker_flow',
        tool: workerFlowMatch.tool,
        canonical_request: canonicalizeWorkerFlowMatch(workerFlowMatch),
        confidence: 0.99,
      }
    }

    if (this.homeAssistantWorkerService.classify(interpretedText)) {
      return {
        intent: inferHomeAssistantIntent(interpretedText),
        route: 'home_assistant',
        canonical_request: interpretedText,
        confidence: 0.99,
      }
    }

    if (this.comfyUiWorkerService.classify(interpretedText)) {
      return {
        intent: inferComfyUiIntent(interpretedText),
        route: 'comfyui',
        canonical_request: interpretedText,
        confidence: 0.99,
      }
    }

    if (this.systemWorkerService.classify(interpretedText)) {
      return {
        intent: inferSystemIntent(interpretedText),
        route: 'system',
        canonical_request: interpretedText,
        confidence: 0.99,
      }
    }

    if (this.editWorkerService.classify(interpretedText)) {
      return {
        intent: 'edit_file',
        route: 'edit',
        canonical_request: interpretedText,
        confidence: 0.99,
      }
    }

    if (this.readWorkerService.classify(interpretedText)) {
      return {
        intent: 'read_file',
        route: 'read',
        canonical_request: interpretedText,
        confidence: 0.99,
      }
    }

    return null
  }
}

function parseHermesStructuredIntent(raw: string): HermesStructuredIntent | null {
  const json = extractFirstJsonObject(raw)
  if (!json) return null

  try {
    const parsed = JSON.parse(json) as Partial<HermesStructuredIntent>
    if (
      parsed.route !== 'chat' &&
      parsed.route !== 'direct_tool' &&
      parsed.route !== 'worker_flow' &&
      parsed.route !== 'home_assistant' &&
      parsed.route !== 'comfyui' &&
      parsed.route !== 'system' &&
      parsed.route !== 'terminal' &&
      parsed.route !== 'read' &&
      parsed.route !== 'edit'
    ) {
      return null
    }

    return {
      intent: parsed.intent && typeof parsed.intent === 'string' ? parsed.intent.trim() : undefined,
      route: parsed.route,
      tool: typeof parsed.tool === 'string' ? parsed.tool.trim() : undefined,
      canonical_request:
        typeof parsed.canonical_request === 'string' ? parsed.canonical_request.trim() : undefined,
      args:
        parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, any>)
          : undefined,
      confidence:
        typeof parsed.confidence === 'number'
          ? parsed.confidence
          : typeof parsed.confidence === 'string'
            ? Number(parsed.confidence)
            : undefined,
    }
  } catch {
    return null
  }
}

function parseHermesTurnType(
  raw: string
): { turn_type: HermesTurnType; confidence?: number } | null {
  const json = extractJsonObject(raw)
  if (!json) return null

  try {
    const parsed = JSON.parse(json) as Partial<{ turn_type: HermesTurnType; confidence?: number }>
    const turnType =
      parsed.turn_type === 'chat' ||
      parsed.turn_type === 'task' ||
      parsed.turn_type === 'task_followup' ||
      parsed.turn_type === 'clarification'
        ? parsed.turn_type
        : null
    if (!turnType) return null
    return {
      turn_type: turnType,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
    }
  } catch {
    return null
  }
}

function parseSupportNeedAssessment(
  raw: string
): {
  support_need: 'none' | 'emotional' | 'medical' | 'self_harm'
  urgency?: 'routine' | 'urgent'
  confidence?: number
  reason?: string
} | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  const json = jsonMatch ? jsonMatch[0] : raw

  try {
    const parsed = JSON.parse(json) as Partial<{
      support_need: 'none' | 'emotional' | 'medical' | 'self_harm'
      urgency?: 'routine' | 'urgent'
      confidence?: number
      reason?: string
    }>

    if (
      parsed.support_need !== 'none' &&
      parsed.support_need !== 'emotional' &&
      parsed.support_need !== 'medical' &&
      parsed.support_need !== 'self_harm'
    ) {
      return null
    }

    return {
      support_need: parsed.support_need,
      urgency: parsed.urgency === 'urgent' ? 'urgent' : 'routine',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined,
    }
  } catch {
    return null
  }
}

function parseResponseModeAssessment(
  raw: string
): {
  response_mode: 'supportive' | 'teaching' | 'assistant' | 'practical' | 'conversational'
  confidence?: number
  reason?: string
} | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  const json = jsonMatch ? jsonMatch[0] : raw

  try {
    const parsed = JSON.parse(json) as Partial<{
      response_mode: 'supportive' | 'teaching' | 'assistant' | 'practical' | 'conversational'
      confidence?: number
      reason?: string
    }>

    if (
      parsed.response_mode !== 'supportive' &&
      parsed.response_mode !== 'teaching' &&
      parsed.response_mode !== 'assistant' &&
      parsed.response_mode !== 'practical' &&
      parsed.response_mode !== 'conversational'
    ) {
      return null
    }

    return {
      response_mode: parsed.response_mode,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined,
    }
  } catch {
    return null
  }
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim()
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim()
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null
  return trimmed.slice(firstBrace, lastBrace + 1)
}

function extractFirstJsonObject(raw: string): string | null {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1] || raw
  const start = candidate.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return candidate.slice(start, index + 1)
      }
    }
  }

  return null
}

function normalizeNaturalRequestForHermes(text: string): string {
  let normalized = text.trim()

  normalized = normalized.replace(/^\s*(?:hey|hi|hello)\s+quinn[,\s:!-]*/i, '')
  normalized = normalized.replace(/^\s*quinn[,\s:!-]*/i, '')
  normalized = normalized.replace(/\s+please[.!?]*$/i, '')
  normalized = normalized.replace(/\bef\s+of\s+(\d{1,2})\b/gi, 'ejection fraction of $1')
  normalized = normalized.replace(/\bef\s+(\d{1,2})\b/gi, 'ejection fraction $1')
  normalized = normalized.replace(
    /^\s*make\s+(?:a\s+)?desktop\s+shortcut\b/i,
    'create desktop shortcut'
  )
  normalized = normalized.replace(/^\s*make\s+shortcut\b/i, 'create shortcut')
  if (/\b(shortcut|launcher)\b/i.test(normalized) && /\bdesktop\b/i.test(normalized)) {
    normalized = normalized.replace(/\s+and\s+put\s+it\s+(?:on|to)\s+the\s+desktop\b.*$/i, '')
    normalized = normalized.replace(/\s+(?:on|to|for)\s+the\s+desktop\b.*$/i, '')
  }
  normalized = normalized.replace(/\s+/g, ' ').trim()

  if (/desktop shortcut/i.test(normalized) && !/\bcreate\b|\bmake\b|\badd\b/i.test(normalized)) {
    normalized = `create ${normalized}`
  }

  normalized = normalizeStructuralTypos(normalized)

  return normalized
}

function normalizeStructuralTypos(text: string): string {
  const protectedLiterals = extractProtectedLiteralSpans(text)
  let working = text
  for (const literal of protectedLiterals) {
    working = working.replace(literal.value, literal.token)
  }

  const protectedPhrases = [
    /home assistant/gi,
    /project nomad/gi,
    /n\.o\.m\.a\.d\./gi,
    /run safe command/gi,
    /what needs attention in the house/gi,
    /inspect logs,\s*config,\s*and files/gi,
  ]

  const placeholders = protectedPhrases.map((pattern, index) => {
    const matches = [...working.matchAll(pattern)]
    if (matches.length === 0) return null

    const replacements: Array<{ token: string; value: string }> = []
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const value = matches[matchIndex][0]
      const token = `__HERMES_PROTECTED_${index}_${matchIndex}__`
      working = working.replace(value, token)
      replacements.push({ token, value })
    }
    return replacements
  })

  const normalized = working.replace(/\b([a-z][a-z0-9_-]{2,})\b/gi, (token) => {
    const corrected = correctStructuralToken(token)
    return corrected || token
  })

  let restored = normalized
  for (const replacementGroup of placeholders) {
    if (!replacementGroup) continue
    for (const replacement of replacementGroup) {
      restored = restored.replace(replacement.token, replacement.value)
    }
  }

  for (const literal of protectedLiterals) {
    restored = restored.replace(literal.token, literal.value)
  }

  return restored
}

function extractProtectedLiteralSpans(text: string): Array<{ token: string; value: string }> {
  const spans: Array<{ token: string; value: string }> = []
  const seen = new Set<string>()
  const patterns = [
    /"[^"\n]*"/g,
    /'[^'\n]*'/g,
    /(?:^|\s)(\/[A-Za-z0-9._\-\/]+(?:\.[A-Za-z0-9._-]+)?)(?=\s|$)/g,
    /(?:^|\s)([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9._-]+)?)(?=\s|$)/g,
  ]

  let counter = 0
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] || match[0] || '').trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      spans.push({
        token: `__HERMES_LITERAL_${counter}__`,
        value,
      })
      counter += 1
    }
  }

  return spans
}

function correctStructuralToken(token: string): string | null {
  const lower = token.toLowerCase()
  if (STRUCTURAL_TYPO_VOCABULARY.has(lower)) return null
  if (/^\d+$/.test(lower)) return null
  if (looksLikeAcceptableInflection(lower, STRUCTURAL_TYPO_VOCABULARY)) return null

  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of STRUCTURAL_TYPO_VOCABULARY) {
    const lengthDelta = Math.abs(candidate.length - lower.length)
    if (lengthDelta > 2) continue

    const distance = levenshteinDistance(lower, candidate)
    const threshold = candidate.length >= 7 ? 2 : 1
    if (distance > threshold) continue

    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
      continue
    }

    if (distance === bestDistance && best && candidate.length > best.length) {
      best = candidate
    }
  }

  return best && best !== lower ? matchTokenCase(token, best) : null
}

function looksLikeAcceptableInflection(token: string, vocabulary: Set<string>): boolean {
  if (token.length < 4) return false

  const singularCandidates = [token.slice(0, -1)]
  if (token.endsWith('es')) {
    singularCandidates.push(token.slice(0, -2))
  }

  return singularCandidates.some((candidate) => candidate.length >= 3 && vocabulary.has(candidate))
}

function matchTokenCase(source: string, replacement: string): string {
  if (source.toUpperCase() === source) return replacement.toUpperCase()
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1)
  }
  return replacement
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0
  if (!left.length) return right.length
  if (!right.length) return left.length

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const current = new Array<number>(right.length + 1)

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j]
    }
  }

  return previous[right.length]
}

function looksLikeMultiIntentTurn(text: string): boolean {
  const raw = text.trim()
  if (!raw) return false

  const nonEmptyLines = raw
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (nonEmptyLines.length >= 2 && nonEmptyLines.length <= 6) return true

  if (/\s+[—–]\s+/.test(raw)) return true

  const sentenceBoundaries = (raw.match(/[?!](?=\s|$)/g) || []).length
  if (sentenceBoundaries >= 2) return true

  if (/[;]\s*/.test(raw)) return true

  if (/[,.]\s*(?:then|and then|also)\b/i.test(raw)) return true

  // Common single-line mixed turns: a question plus an action joined with "and".
  if (/\b(and|also|then)\b/i.test(raw)) {
    const hasQuestion =
      /\b(?:what|whats|what['’]?s|what is|how|can you|could you|would you)\b/i.test(raw) ||
      /\?/.test(raw)
    const hasAction =
      /\b(?:set|turn|lock|unlock|dim|brighten|restart|repair|inspect|read|open|list|run|create|remove|diagnose|patch)\b/i.test(
        raw
      )
    if (hasQuestion && hasAction) return true
  }

  if (/[.?!]\s+(?:what|set|turn|read|inspect|create|remove|restart|run|lock|unlock)\b/i.test(raw)) {
    return true
  }

  const longClauses = raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12)
  return longClauses.length >= 2
}

function splitTurnIntoCandidateSegments(text: string): string[] {
  const raw = text.trim()
  if (!raw) return []

  const newlineParts = raw
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (newlineParts.length >= 2 && newlineParts.length <= 6) {
    return newlineParts
  }

  const protectedPhrases = [
    /inspect logs,\s*config,\s*and files/i,
    /what tools do you have access to/i,
    /what can you do right now/i,
  ]

  let working = raw.replace(/\s+/g, ' ').trim()
  const placeholders = protectedPhrases.map((pattern, index) => {
    const match = working.match(pattern)
    if (!match) return null
    const token = `__PROTECTED_${index}__`
    working = working.replace(pattern, token)
    return { token, value: match[0] }
  })

  const sentenceParts = splitIntoSentenceLikeParts(working)
  const primaryParts = sentenceParts.length > 0 ? sentenceParts : [working]

  const expandedParts = primaryParts.flatMap((part) =>
    part
      .split(
        /\s+(?:and then|then|also)\s+|\s+\band\b\s+(?=(?:what|how|can|could|would|will|do|is|are|inspect|read|run|create|remove|diagnose|restart|repair|set|turn|lock|unlock|pin|unpin|retry|try)\b)/i
      )
      .map((item) => item.trim())
      .filter(Boolean)
  )

  const restored = expandedParts.map((part) => {
    let restoredPart = part
    for (const placeholder of placeholders) {
      if (!placeholder) continue
      restoredPart = restoredPart.replace(placeholder.token, placeholder.value)
    }
    return restoredPart.trim()
  })

  return restored.length >= 2 && restored.length <= 6 ? restored : []
}

function splitIntoSentenceLikeParts(text: string): string[] {
  const normalized = text
    .replace(/\.{3,}/g, '; ')
    .replace(/\s+[—–]\s+/g, '; ')
    .replace(
      /\.\s+(?=(?:what|set|turn|read|inspect|create|remove|restart|run|lock|unlock|hello|hi|hey|i|how|why|can|could|would)\b)/gi,
      '; '
    )
  const matches = normalized.match(/[^?!;]+(?:[?!;]+|$)/g) || []
  return matches.map((part) => part.trim()).filter(Boolean)
}

function inferDeterministicHermesTask(text: string): HermesStructuredIntent | null {
  const cleaned = text.trim()
  if (!cleaned) return null

  if (
    /^(?:what(?:['’]?s|s| is)\s+(?:today'?s\s+)?(?:date\s+and\s+time|time\s+and\s+(?:day|date)|day\s+and\s+time)|what\s+time\s+and\s+(?:day|date)\s+is\s+it|what\s+day\s+and\s+time\s+is\s+it)\b/i.test(
      cleaned
    ) ||
    /^(?:what(?:['’]?s|s| is)\s+(?:the\s+)?)?(?:date\s+and\s+time|time\s+and\s+date)\b/i.test(
      cleaned
    ) ||
    /^(?:current|today'?s)\s+(?:date\s+and\s+time|time\s+and\s+date)\b/i.test(cleaned)
  ) {
    return {
      intent: 'get_time_and_date',
      route: 'system',
      canonical_request: cleaned,
      confidence: 0.99,
    }
  }

  if (
    /^what(?:['’]?s| is)\s+the\s+(water pressure|tank level|living room temperature|living room humidity|thermostat target temperature|thermostat mode|front door|porch light|sprinklers|water main|water supply alert)\b/i.test(
      cleaned
    )
  ) {
    return {
      intent: 'get_state',
      route: 'home_assistant',
      canonical_request: cleaned,
      confidence: 0.99,
    }
  }

  return null
}

function isDeterministicExternalRead(
  text: string,
  services: {
    homeAssistantWorkerService: HomeAssistantWorkerService
    systemWorkerService: SystemWorkerService
    readWorkerService: ReadWorkerService
    directToolRegistryService: DirectToolRegistryService
  }
): boolean {
  const cleaned = text.trim()
  if (!cleaned) return false

  const looksLikeImmediateRead =
    /^(?:what(?:['’]?s| is)|show|list|inspect|read|open|check|get)\b/i.test(cleaned) ||
    /\bstatus summary\b/i.test(cleaned)

  if (!looksLikeImmediateRead) return false

  return Boolean(
    services.homeAssistantWorkerService.classify(cleaned) ||
    services.systemWorkerService.classify(cleaned) ||
    services.readWorkerService.classify(cleaned) ||
    services.directToolRegistryService.classify(cleaned)
  )
}

function fallbackTurnSegmentClassification(segmentText: string): HermesTurnType {
  const cleaned = segmentText.trim().toLowerCase()
  if (!cleaned) {
    return 'chat'
  }

  if (looksLikeReflectiveFuturePlanningStatement(cleaned)) {
    return 'chat'
  }

  if (looksLikeMedicalConversationNeedingReasoning(cleaned)) {
    return 'chat'
  }

  if (/^just\s+(?:ok|okay)\b/.test(cleaned)) {
    return 'chat'
  }

  if (
    /^(hi|hello|hey|thanks|thank you|how are you|how's it going)\b/.test(cleaned) ||
    /^(?:i(?:'|’)m|im|i am)\s+(?:fine|good|okay|ok|great|alright|all right|doing good|doing well|doing okay|doing ok)\b/.test(
      cleaned
    )
  ) {
    return 'chat'
  }

  if (isTaskFollowUpText(cleaned)) {
    return 'task_followup'
  }

  if (
    /(what tools do you have|what can you do|workflow|memory|remember about me|my name|can you write to my desktop|can you create a shortcut)/i.test(
      cleaned
    )
  ) {
    return 'chat'
  }

  if (
    /\bwhat you (?:yourself )?can do now\b/i.test(cleaned) ||
    /\btools you can use\b/i.test(cleaned) ||
    /\bwhat are you capable of\b/i.test(cleaned)
  ) {
    return 'chat'
  }

  if (needsClarification(cleaned)) {
    return 'clarification'
  }

  return 'task'
}

function shouldStayInChatLane(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return false

  if (looksLikeReflectiveFuturePlanningStatement(cleaned)) {
    return true
  }

  if (looksLikeMedicalConversationNeedingReasoning(cleaned)) {
    return true
  }

  if (/^just\s+(?:ok|okay)\b[.!?]*$/.test(cleaned)) {
    return true
  }

  if (
    /\b(i(?:'|’)m|im|i am)\s+excited\b/.test(cleaned) ||
    /\b(in the future|future plan|someday|eventually|down the road|later on)\b/.test(cleaned) ||
    /^(?:not right now|not yet|later)[.!?]*$/.test(cleaned)
  ) {
    return true
  }

  if (
    /^([a-z][a-z'.-]*)\s+is\s+my\s+(?:\d{1,2}\s*(?:year old|yo)\s+)?(?:daughter|son|child|kid)\b/.test(
      cleaned
    ) ||
    /^my\s+(?:daughter|son|child|kid)\s+is\s+([a-z][a-z'.-]*)\b/.test(cleaned) ||
    /^([a-z][a-z'.-]*)\s+is\s+my\s+(?:wife|husband)\b/.test(cleaned) ||
    /^my\s+(?:wife|husband)\s+is\s+([a-z][a-z'.-]*)\b/.test(cleaned)
  ) {
    return true
  }

  if (/^(this is a big problem|this is big problem|this is a problem)[.!?]*$/.test(cleaned)) {
    return true
  }

  if (
    /^(what(?:'s|s| is)? my name|who am i|what(?:'s|s| is)? stored in memory|what do you remember about me)\??$/.test(
      cleaned
    )
  ) {
    return true
  }

  if (
    /^(?:what(?:'s|s| is)?\s+)?my\s+wife\s+and\s+(?:kids|children)(?:['’]?s)?\s+names\??$/.test(
      cleaned
    )
  ) {
    return true
  }

  if (
    /^(workflow|what(?:'s|s| is)? your workflow|can you tell me your workflow|explain your workflow|tell me your workflow)\??$/.test(
      cleaned
    )
  ) {
    return true
  }

  if (
    /^(was that a canned respon(?:s|c)e|is that a canned answer|is that a canned response|give me a list of the canned answers you currently have stored)\??$/.test(
      cleaned
    )
  ) {
    return true
  }

  if (
    /^(what(?:'s|s| is)? your name|who are you|how are you(?:\s+quinn)?|how'?s it going(?:\s+quinn)?|hello(?:\s+quinn)?|hi(?:\s+quinn)?|hey(?:\s+quinn)?|just ok huh)\??$/.test(
      cleaned
    ) ||
    /^(?:i(?:'|’)m|im|i am)\s+(?:fine|good|okay|ok|great|alright|all right|doing good|doing well|doing okay|doing ok)\s*(?:,?\s*and\s+you)?[.!?]*$/.test(
      cleaned
    ) ||
    /^(?:fine|good|okay|ok|great|alright|all right)\s*(?:,?\s*and\s+you)\??$/.test(cleaned)
  ) {
    return true
  }

  if (
    /^(good morning(?:\s+quinn)?|good afternoon(?:\s+quinn)?|good evening(?:\s+quinn)?|awesome|cool|nice|sweet|great)\??$/.test(
      cleaned
    )
  ) {
    return true
  }

  if (
    /^(what can you do|what can you do right now|what tools do you have|what tools do you have access to)\??$/.test(
      cleaned
    )
  ) {
    return true
  }

  if (
    /^(what tools do you have access to|what can you do right now|what tools do you have available|what tools can you use)\??$/.test(
      cleaned
    )
  ) {
    return true
  }

  // Broader capability/workflow discussion (should not fall into "clarification").
  if (
    /\bwhat you (?:yourself )?can do now\b/.test(cleaned) ||
    /\bwhat (?:all )?you can do now\b/.test(cleaned) ||
    /\b(?:stuff|things|everything) you can do now\b/.test(cleaned) ||
    /\btools you can use\b/.test(cleaned) ||
    /\btools you have\b/.test(cleaned) ||
    /\bwhat are you capable of\b/.test(cleaned) ||
    /\bwhat can you handle\b/.test(cleaned)
  ) {
    return true
  }

  if (
    /^(can you write to my desktop|write to my desktop|can you create a shortcut on ubuntu|create a shortcut on ubuntu)\??$/.test(
      cleaned
    )
  ) {
    return true
  }

  if (
    /\b(if i|if we|would you be able|could you handle|what would happen|i wonder|i'm not sure)\b/i.test(
      cleaned
    )
  ) {
    return true
  }

  if (
    /\b(i asked|i told|we were talking about|what do you think|why did|how should we|what should we|should we)\b/i.test(
      cleaned
    )
  ) {
    return true
  }

  if (
    /^(?:what about|tell me about|what do you know about|what do you remember about)\s+[a-z][a-z'. -]*\??$/i.test(
      cleaned
    )
  ) {
    return true
  }

  if (/^who(?:'s| is)\s+[a-z][a-z'. -]*\??$/i.test(cleaned)) {
    return true
  }

  if (
    /^isn[’']?t she one of my (?:kids|children)\??$/.test(cleaned) ||
    /^is she one of my (?:kids|children)\??$/.test(cleaned)
  ) {
    return true
  }

  if (/^(thank you|thanks|hello|hi|hey|for fucks sake)\b/.test(cleaned)) {
    return true
  }

  return false
}

export function looksLikeReflectiveFuturePlanningStatement(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return false

  const firstPersonFuture =
    /\b(?:i am going to|i'm going to|im going to|i want to|i plan to|i'm planning to|i am planning to|my plan is to|part of my reason for|the reason i'm|the reason i am)\b/.test(
      cleaned
    )

  if (!firstPersonFuture) return false

  const asksQuinnToAct =
    /^(?:can you|could you|would you|will you|please|help me|show me|find me|read me|open|create|make|list|search)\b/.test(
      cleaned
    ) || /\bfor me\b/.test(cleaned)

  if (asksQuinnToAct) return false

  const reflectiveSignals =
    /\b(?:going to|want to|plan to|planning to|trying to|building|starting|making|learning|finding|researching|figuring out|understand|cope|leave behind|future|someday)\b/.test(
      cleaned
    )

  return reflectiveSignals
}

export function looksLikeMedicalConversationNeedingReasoning(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return false

  const medicalTermSignals = [
    /\bejection fraction\b/,
    /\bef\s+(?:of\s+)?\d{1,2}\b/,
    /\bheart failure\b/,
    /\bcongestive heart failure\b/,
    /\bcardiomyopathy\b/,
    /\bfluid in (?:my|the) lungs\b/,
    /\bshortness of breath\b/,
    /\btrouble breathing\b/,
    /\bchest pain\b/,
    /\bpalpitations?\b/,
    /\bcardiac arrest\b/,
    /\bstroke\b/,
    /\ber\b/,
    /\bemergency room\b/,
    /\bicd\b/,
    /\bpacemaker\b/,
  ]

  const personalDistressSignals = [
    /\bi am dying\b/,
    /\bi'm dying\b/,
    /\bim dying\b/,
    /\bi feel like i'm dying\b/,
    /\bi feel like i am dying\b/,
    /\bi'm not okay\b/,
    /\bi am not okay\b/,
    /\bi can't breathe\b/,
    /\bi cannot breathe\b/,
    /\bi passed out\b/,
    /\bi fainted\b/,
    /\bi might be having\b/,
    /\bsomething is wrong with my heart\b/,
  ]

  const isQuestionLike =
    /\?$/.test(cleaned) ||
    /^(what|why|how|is|am|should|could|can|do|does|did)\b/.test(cleaned) ||
    /\bwhat does\b/.test(cleaned) ||
    /\bwhat is\b/.test(cleaned)

  const hasMedicalTerm = medicalTermSignals.some((pattern) => pattern.test(cleaned))
  const hasPersonalDistress = personalDistressSignals.some((pattern) => pattern.test(cleaned))
  const hasFirstPersonMedicalContext =
    /\b(i have|i've had|i am having|i'm having|my)\b/.test(cleaned) && hasMedicalTerm

  return (
    hasPersonalDistress ||
    (hasMedicalTerm && isQuestionLike) ||
    hasFirstPersonMedicalContext ||
    /\bi have an?\s+(?:ef|ejection fraction)\b/.test(cleaned)
  )
}

function inferSupportNeedHeuristically(text: string): HermesTurnContract['support_need'] {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return null

  if (
    /\b(kill myself|want to die|don't want to live|do not want to live|suicid(?:al|e)|end my life|hurt myself|self harm)\b/.test(
      cleaned
    )
  ) {
    return {
      kind: 'self_harm',
      urgency: 'urgent',
      reason: 'Possible self-harm crisis language.',
    }
  }

  if (
    /\b(i am dying|i'm dying|im dying|can'?t breathe|cannot breathe|chest pain|passed out|fainted|heart attack|stroke|cardiac arrest)\b/.test(
      cleaned
    ) ||
    /\bejection fraction(?:\s+of)?\s+1[0-9]\b/.test(cleaned)
  ) {
    return {
      kind: 'medical',
      urgency: 'urgent',
      reason: 'Possible urgent medical distress.',
    }
  }

  if (looksLikeMedicalConversationNeedingReasoning(cleaned)) {
    return {
      kind: 'medical',
      urgency: 'routine',
      reason: 'Medical uncertainty or symptom discussion needs reasoning first.',
    }
  }

  if (
    /\b(i'm scared|i am scared|i feel hopeless|i feel alone|i am overwhelmed|i'm overwhelmed|i feel broken|i am falling apart|i need comfort|i need support)\b/.test(
      cleaned
    )
  ) {
    return {
      kind: 'emotional',
      urgency: 'routine',
      reason: 'Emotional support appears more important than action.',
    }
  }

  return null
}

function inferResponseModeHeuristically(text: string): HermesTurnContract['response_mode'] | null {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return null

  if (
    looksLikeMedicalConversationNeedingReasoning(cleaned) ||
    /\b(i feel|i'm scared|i am scared|i am dying|i'm dying|im dying)\b/.test(cleaned)
  ) {
    return 'supportive'
  }

  if (
    /\b(explain|teach me|help me understand|walk me through|break it down|make you an expert|learn this with me|go deep|deep dive)\b/.test(
      cleaned
    )
  ) {
    return 'teaching'
  }

  if (
    /\b(help me build|work through this with me|think this through with me|be my assistant|act like an assistant|organize this|compare these|track this|help me plan|help me structure|carry this with me)\b/.test(
      cleaned
    )
  ) {
    return 'assistant'
  }

  if (looksLikeReflectiveFuturePlanningStatement(cleaned)) {
    return 'assistant'
  }

  if (
    /\b(what should i do|what do i do now|next step|next steps|how do i fix|help me fix|troubleshoot|debug)\b/.test(
      cleaned
    )
  ) {
    return 'practical'
  }

  return null
}

function needsClarification(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return false

  return (
    /^(do it|do that|run it|run that|fix it|fix that|open it|open that|check it|check that)\b/.test(
      cleaned
    ) || /^(can you|could you|would you)\s+(help|handle|do something)\b/.test(cleaned)
  )
}

function looksLikeAffirmativeConfirmation(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  return /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do)$/.test(cleaned)
}

function looksLikeNegativeConfirmation(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  return /^(no|nope|nah|don'?t|do not|stop|never mind|cancel)$/.test(cleaned)
}

function inferConfirmedTaskFromRecentAssistant(
  messages: ChatMessage[]
): { canonical_request: string; route: HermesTaskPayload['route'] } | null {
  const ordered = [...messages].reverse().filter((msg) => msg.content && msg.content.trim())
  const lastAssistant = ordered.find((msg) => msg.role === 'assistant')?.content?.trim() || ''
  const previousUser =
    ordered.find((msg, idx) => msg.role === 'user' && idx > 0)?.content?.trim() || ''
  if (!lastAssistant) return null

  const assistantLower = lastAssistant.toLowerCase()
  const userLower = previousUser.toLowerCase()

  // Only treat "yes" as executable if the assistant is actually asking for confirmation.
  const askedForConfirmation =
    /\b(would you like me to|do you want me to|want me to|should i|can i go ahead|do that now)\b/i.test(
      lastAssistant
    ) || /\?\s*$/.test(lastAssistant)

  if (!askedForConfirmation) return null

  if (
    /\block\s+all\s+(?:the\s+)?doors\b/.test(assistantLower) ||
    /\block\s+(?:the\s+)?doors\b/.test(assistantLower) ||
    /\bock\s+all\s+doors\b/.test(userLower) ||
    /\block\s+all\s+doors\b/.test(userLower)
  ) {
    return { canonical_request: 'lock all doors', route: 'home_assistant' }
  }

  if (
    /\bturn\s+off\s+all\s+lights\b/.test(assistantLower) ||
    /\bturn\s+off\s+all\s+lights\b/.test(userLower)
  ) {
    return { canonical_request: 'turn off all lights', route: 'home_assistant' }
  }

  if (
    /\bturn\s+on\s+all\s+lights\b/.test(assistantLower) ||
    /\bturn\s+on\s+all\s+lights\b/.test(userLower)
  ) {
    return { canonical_request: 'turn on all lights', route: 'home_assistant' }
  }

  const thermostatMatch = assistantLower.match(/\bset\s+the\s+thermostat\s+to\s+(\d{1,3})\b/)
  if (thermostatMatch?.[1]) {
    return {
      canonical_request: `set the thermostat to ${thermostatMatch[1]}`,
      route: 'home_assistant',
    }
  }

  const userThermostatMatch = userLower.match(/\bset\s+(?:the\s+)?thermostat\s+to\s+(\d{1,3})\b/)
  if (userThermostatMatch?.[1]) {
    return {
      canonical_request: `set the thermostat to ${userThermostatMatch[1]}`,
      route: 'home_assistant',
    }
  }

  return null
}

function isTaskFollowUpText(text: string): boolean {
  const cleaned = text.trim().toLowerCase()
  if (!cleaned) return false

  return (
    /^(set|make|turn|dim|brighten)\s+(it|that|them|those|this)\b/.test(cleaned) ||
    /^(?:try|retry)\b.*\b(?:again|it|that|same one)\b/.test(cleaned) ||
    /^(?:remove|delete|erase)\b.*\b(?:shortcut|launcher)\b.*\b(?:it|that|this|you just created|just created)\b/.test(
      cleaned
    ) ||
    /^(?:pin|unpin)\s+(?:it|that|them|this|same one)\b/.test(cleaned) ||
    /^(?:same one|do that|do it|use that file|retry it|try again)\b/.test(cleaned) ||
    /^(light|lamp|lights?)\s+(on|off)\b/.test(cleaned) ||
    /^set\s+to\s+.+/.test(cleaned)
  )
}

function resolveTaskFollowUp(
  currentText: string,
  messages: ChatMessage[],
  order: number,
  inTurnDependencyText?: string | null
): HermesTaskPayload | null {
  const previousUserMessages = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim())
    .filter(Boolean)
  const previousAssistantMessages = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.trim())
    .filter(Boolean)

  const previousUserText =
    inTurnDependencyText || previousUserMessages[previousUserMessages.length - 2] || null
  const previousAssistantText =
    previousAssistantMessages[previousAssistantMessages.length - 1] || null
  const shortcutDependency = looksLikeShortcutRecreateFollowUp(currentText)
    ? inferRecentShortcutDependencyText(messages)
    : null
  const dependencyText =
    inTurnDependencyText ||
    shortcutDependency ||
    [previousUserText, previousAssistantText].find(
      (candidate) => candidate && inferFollowUpTarget(candidate)
    ) ||
    previousUserText ||
    previousAssistantText

  if (!dependencyText) return null
  const inferredRoute = inferFollowUpRoute(previousUserText || dependencyText)

  return {
    order,
    source_text: currentText.trim(),
    intent: 'task_followup',
    route: inferredRoute,
    canonical_request: currentText.trim(),
    depends_on: dependencyText,
  }
}

function resolveFollowUpTaskPayload(task: HermesTaskPayload): HermesTaskPayload | null {
  if (!task.depends_on) return task

  const rewritten = resolveFollowUpTextWithTarget(
    task.source_text,
    inferFollowUpTarget(task.depends_on)
  )
  if (!rewritten) return null

  return {
    ...task,
    canonical_request: rewritten,
    depends_on: undefined,
  }
}

function looksLikeUnsupportedShortcutPinFollowUp(task: HermesTaskPayload): boolean {
  const sourceText = task.source_text.trim().toLowerCase()
  const dependsOn = (task.depends_on || '').trim().toLowerCase()
  return (
    /^(?:pin|unpin)\s+(?:it|that|them|this|same one)\b/.test(sourceText) &&
    /\bshortcut|launcher|desktop\b/.test(dependsOn)
  )
}

function resolveFollowUpTextWithTarget(
  currentText: string,
  inferredTarget: string | null
): string | null {
  if (!inferredTarget) return null

  const trimmed = currentText.trim()
  const lower = trimmed.toLowerCase()

  if (
    /^(?:try|retry)\s+(?:creating|making|adding)\s+(?:it|that|the shortcut)\s+again[,.!?]*$/i.test(
      trimmed
    )
  ) {
    return `create shortcut for ${inferredTarget}`
  }

  if (
    /^(?:remove|delete|erase)\s+(?:the\s+)?(?:shortcut|launcher)\b.*(?:it|that|this|you just created|just created)\b/i.test(
      trimmed
    )
  ) {
    return `remove shortcut for ${inferredTarget}`
  }

  if (/^(?:light|lamp|lights?)\s+on$/.test(lower)) {
    return `turn on ${inferredTarget}`
  }

  if (/^(?:light|lamp|lights?)\s+off$/.test(lower)) {
    return `turn off ${inferredTarget}`
  }

  const directToggleMatch = trimmed.match(
    /^(?:turn|switch)\s+(?:it|that|them|those|this)(?:\s+back)?\s+(on|off)[,.!?]*$/i
  )
  if (directToggleMatch?.[1]) {
    return `turn ${directToggleMatch[1].toLowerCase()} ${inferredTarget}`
  }

  const percentMatch = trimmed.match(
    /^set\s+(?:it|that|them|those|this)?\s*to\s+(\d{1,3})(?:\s*%|\s+percent)$/i
  )
  if (percentMatch) {
    return `set ${inferredTarget} to ${percentMatch[1]}%`
  }

  const colorMatch = trimmed.match(/^set\s+(?:it|that|them|those|this)?\s*to\s+(.+)$/i)
  if (colorMatch) {
    return `make ${inferredTarget} ${colorMatch[1].trim()}`
  }

  return null
}

function looksLikeShortcutRecreateFollowUp(text: string): boolean {
  return /^(?:try|retry)\s+(?:creating|making|adding)\s+(?:it|that|the shortcut)\s+again[,.!?]*$/i.test(
    text.trim()
  )
}

function inferRecentShortcutDependencyText(messages: ChatMessage[]): string | null {
  const ordered = messages
    .map((message) => message.content.trim())
    .filter(Boolean)
    .reverse()

  for (const text of ordered) {
    const lowered = text.toLowerCase()
    if (lowered.includes('home assistant') && lowered.includes('shortcut')) {
      return 'create shortcut for home assistant'
    }
    if (
      (lowered.includes('n.o.m.a.d') ||
        lowered.includes('project nomad') ||
        lowered.includes('nomad')) &&
      lowered.includes('shortcut')
    ) {
      return 'create shortcut for nomad'
    }
  }

  return null
}

function inferFollowUpTarget(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const shortcutMatch = trimmed.match(
    /(?:create|created|remove|removed)\s+(?:the\s+)?(.+?)\s+(?:shortcut|launcher)(?:\s+(?:on|from)\s+the\s+desktop)?/i
  )
  if (shortcutMatch?.[1]) {
    const shortcutTarget = cleanInferredFollowUpTarget(shortcutMatch[1])
    if (shortcutTarget) return shortcutTarget
  }

  const shortcutForMatch = trimmed.match(
    /(?:create|created|remove|removed)\s+(?:the\s+)?(?:shortcut|launcher)\s+(?:for\s+)(.+?)(?:\s+(?:on|from)\s+the\s+desktop)?$/i
  )
  if (shortcutForMatch?.[1]) {
    const shortcutTarget = cleanInferredFollowUpTarget(shortcutForMatch[1])
    if (shortcutTarget) return shortcutTarget
  }

  const trailingToggleMatch = trimmed.match(
    /(?:turn|switch)(?:ed)?\s+(?:the\s+)?(.+?)\s+(on|off)[?.!,]*$/i
  )
  if (trailingToggleMatch?.[1]) {
    const trailingToggleTarget = cleanInferredFollowUpTarget(trailingToggleMatch[1])
    if (trailingToggleTarget) return trailingToggleTarget
  }

  const assistantSummaryMatch = trimmed.match(
    /^I\s+(?:turned|switched)\s+(?:the\s+)?(.+?)\s+(on|off)\.?$/i
  )
  if (assistantSummaryMatch?.[1]) {
    const assistantSummaryTarget = cleanInferredFollowUpTarget(assistantSummaryMatch[1])
    if (assistantSummaryTarget) return assistantSummaryTarget
  }

  const directMatch = trimmed.match(
    /(?:turn on|turn off|turned on|turned off|set|make|dim|brighten)\s+(.+?)(?:\s+brightness\s+to\s+\d{1,3}(?:\s*%|\s+percent)?|\s+to\s+\d{1,3}(?:\s*%|\s+percent)?|\s+to\s+(?:movie|dinner|night)(?:\s+mode)?|\s+(?:warm daylight|warm white|soft white|neutral white|cool white|daylight|red|green|blue|purple|orange|yellow|pink|white|brighter|dimmer))?$/i
  )
  if (!directMatch?.[1]) return null

  const target = directMatch[1]
    .trim()
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/[?.!,]+$/g, '')

  return target || null
}

function cleanInferredFollowUpTarget(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+back$/i, '')
    .replace(/\s+(?:shortcut|launcher)\b.*$/i, '')
    .replace(/\s+(?:from|on)\s+the\s+desktop\b.*$/i, '')
    .replace(/\s+you\s+just\s+created\b.*$/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim()

  const lowered = cleaned.toLowerCase()
  if (lowered.includes('home assistant') || lowered.includes('homeassistant') || lowered === 'ha') {
    return 'home assistant'
  }
  if (
    lowered.includes('n.o.m.a.d') ||
    lowered.includes('project nomad') ||
    lowered.includes('nomad')
  ) {
    return 'nomad'
  }

  return cleaned
}

function inferFollowUpRoute(
  previousUserText: string
): Exclude<HermesStructuredIntent['route'], 'chat'> {
  const cleaned = normalizeNaturalRequestForHermes(previousUserText).toLowerCase()

  if (/\b(shortcut|launcher|desktop)\b/.test(cleaned)) return 'direct_tool'
  if (/\b(container|docker|inspect container|list containers)\b/.test(cleaned)) return 'direct_tool'
  if (/\b(read file|inspect file|files? in |directory|folder|path\b)\b/.test(cleaned)) return 'read'
  if (/\b(run safe command|use terminal to|command\b)\b/.test(cleaned)) return 'terminal'
  if (/\b(restart service|service status|what time|what date|uptime|system status)\b/.test(cleaned))
    return 'system'
  if (
    /\b(comfyui|voice settings|voice and settings|qwen tts|speech to text|image generation|vision)\b/.test(
      cleaned
    )
  ) {
    return 'comfyui'
  }
  if (
    /\b(home assistant|thermostat|light|lamp|lock|unlock|house|sprinklers|water pressure)\b/.test(
      cleaned
    )
  ) {
    return 'home_assistant'
  }

  return 'worker_flow'
}

function inferSystemIntent(text: string): string {
  const cleaned = text.trim().toLowerCase()
  if (/\b(?:time and (?:day|date)|date and time|day and time)\b/.test(cleaned))
    return 'get_time_and_date'
  if (/\bwhat(?:'s|s| is)? the time\b|\bwhat time is it\b|\bcurrent time\b/.test(cleaned))
    return 'get_time'
  if (/\bwhat(?:'s|s| is)? the date\b|\bwhat day is it\b|\btoday'?s date\b/.test(cleaned))
    return 'get_date'
  if (/\buptime\b/.test(cleaned)) return 'get_uptime'
  if (/\brestart\b/.test(cleaned)) return 'restart_service'
  if (/\bstatus\b/.test(cleaned)) return 'get_status'
  return 'system_task'
}

function inferComfyUiIntent(text: string): string {
  const cleaned = text.trim().toLowerCase()
  if (/\b(?:open|launch|show)\b.*\b(?:comfyui|voice\s*(?:and|&)\s*settings)\b/.test(cleaned)) {
    return 'open_comfyui'
  }
  if (/\b(?:status|running|reachable|available|healthy|up)\b/.test(cleaned)) {
    return 'check_comfyui_status'
  }
  if (/\b(?:stt|speech to text|transcribe|transcription|asr)\b/.test(cleaned)) {
    return 'route_stt_lane'
  }
  if (
    /\b(?:vision|analyze (?:an )?image|inspect (?:an )?image|image understanding)\b/.test(cleaned)
  ) {
    return 'route_vision_lane'
  }
  if (
    /\b(?:image generation|generate (?:an )?image|make (?:an )?image|draw|render an image|create an image)\b/.test(
      cleaned
    )
  ) {
    return 'route_image_lane'
  }
  return 'route_tts_lane'
}

function getHermesSamplingPreset(model: string): {
  temperature?: number
  topP?: number
  topK?: number
  repeatPenalty?: number
} {
  const normalizedModel = model.trim().toLowerCase()

  if (normalizedModel === 'qwen2.5:7b-instruct-q4_k_m') {
    return {
      // Hermes benefits from low-variance decoding so routing stays stable.
      temperature: 0.1,
      topP: 0.8,
      topK: 20,
      repeatPenalty: 1.05,
    }
  }

  if (normalizedModel === 'qwen2.5:32b-instruct-q5_k_m') {
    return {
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
      repeatPenalty: 1.05,
    }
  }

  return {}
}

function inferHomeAssistantIntent(text: string): string {
  const cleaned = text.trim().toLowerCase()
  if (/\bhouse status|house summary|status of the house\b/.test(cleaned)) return 'get_house_status'
  if (/\bwhat needs attention\b|\bhouse attention\b/.test(cleaned)) return 'get_house_attention'
  if (/\bbrightness\b/.test(cleaned) && /\bwhat\b/.test(cleaned)) return 'get_light_brightness'
  if (/\bset\b/.test(cleaned) && /\b(?:percent|%)\b/.test(cleaned)) return 'set_light_brightness'
  if (/\bturn on\b/.test(cleaned)) return 'turn_on'
  if (/\bturn off\b/.test(cleaned)) return 'turn_off'
  if (/\block\b/.test(cleaned)) return 'lock'
  if (/\bunlock\b/.test(cleaned)) return 'unlock'
  return 'home_assistant_task'
}

function canonicalizeDirectToolMatch(match: DirectToolMatch): string {
  switch (match.tool) {
    case 'list_containers':
      return 'list containers'
    case 'inspect_docker_container':
      return `inspect docker container ${match.containerName}`
    case 'inspect_files':
      return `inspect file ${match.filePath}`
    case 'read_files':
      return `read file ${match.filePath}`
    case 'write_file':
      return `write file ${match.filePath} with ${match.content}`
    case 'edit_file':
      return `edit file ${match.filePath} replace "${match.search}" with "${match.replace}"`
    case 'create_shortcut':
      return `create shortcut for ${match.targetName}`
    case 'remove_shortcut':
      return `remove shortcut for ${match.targetName}`
    case 'run_safe_command':
      return match.target === 'host_user'
        ? `use terminal to ${match.command}`
        : `run safe command ${match.command}`
    default:
      return ''
  }
}

function canonicalizeWorkerFlowMatch(match: WorkerFlowMatch): string {
  switch (match.tool) {
    case 'diagnose_container':
      return `diagnose container ${match.containerName}`
    case 'patch_file_and_verify':
      return match.serviceName
        ? `patch file ${match.filePath} replace "${match.search}" with "${match.replace}" and restart ${match.serviceName}`
        : `patch file ${match.filePath} replace "${match.search}" with "${match.replace}"`
    case 'restart_and_verify_service':
      return `restart service ${match.serviceName} and verify`
    case 'inspect_logs_config_and_files':
      return `inspect logs, config, and files for ${match.containerName}`
    case 'diagnose_home_assistant':
      return 'diagnose home assistant'
    case 'repair_service_from_logs':
      return `repair service ${match.serviceName} from logs`
    default:
      return ''
  }
}
