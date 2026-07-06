import { inject } from '@adonisjs/core'
import { DockerService } from '#services/docker_service'
import { SystemService } from '#services/system_service'
import Service from '#models/service'
import env from '#start/env'
import { DateTime } from 'luxon'

type SystemTask =
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'time_and_date' }
  | { kind: 'uptime' }
  | { kind: 'system_status' }
  | { kind: 'service_status'; serviceName?: string }
  | { kind: 'restart_service'; serviceName: string }

@inject()
export class SystemWorkerService {
  constructor(
    private systemService: SystemService,
    private dockerService: DockerService
  ) {}

  describeCapabilities(): string {
    return [
      'System worker capabilities:',
      '- Report current time',
      '- Report current date',
      '- Report system uptime',
      '- Summarize machine status',
      '- Show installed service status',
      '- Show status of a managed service',
      '- Restart a managed service',
      `Timezone: ${env.get('NOMAD_TIMEZONE') || 'system default'}`,
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<string | null> {
    const task = this.classify(userText)
    if (!task) return null

    switch (task.kind) {
      case 'time':
        return this.getCurrentTime()
      case 'date':
        return this.getCurrentDate()
      case 'time_and_date':
        return this.getCurrentTimeAndDate()
      case 'uptime':
        return this.getUptime()
      case 'system_status':
        return this.getSystemStatus()
      case 'service_status':
        return this.getServiceStatus(task.serviceName)
      case 'restart_service':
        return this.restartService(task.serviceName)
      default:
        return null
    }
  }

  classify(userText: string): SystemTask | null {
    return this.parseTask(userText)
  }

  private parseTask(userText: string): SystemTask | null {
    const text = userText.trim()

    if (
      /^(?:what(?:'s|s| is)\s+(?:today'?s\s+)?(?:date\s+and\s+time|time\s+and\s+(?:day|date)|day\s+and\s+time)|what\s+time\s+and\s+(?:day|date)\s+is\s+it|what\s+day\s+and\s+time\s+is\s+it)\b/i.test(
        text
      ) ||
      /^(?:what(?:'s|s| is)\s+(?:the\s+)?)?(?:date\s+and\s+time|time\s+and\s+date)\b/i.test(text) ||
      /^(?:current|today'?s)\s+(?:date\s+and\s+time|time\s+and\s+date)\b/i.test(text)
    ) {
      return { kind: 'time_and_date' }
    }

    if (
      /^(?:what(?:'s|s| is)\s+the\s+time|what\s+time\s+is\s+it|current time|time is it|whats the time)\b/i.test(
        text
      )
    ) {
      return { kind: 'time' }
    }

    if (
      /^(?:what(?:'s|s| is)\s+the\s+date|what\s+day\s+is\s+it|current date|today'?s date|todays date)\b/i.test(
        text
      )
    ) {
      return { kind: 'date' }
    }

    if (/\buptime\b/i.test(text)) {
      return { kind: 'uptime' }
    }

    if (/\b(system status|machine status|host status|health summary|status of the system)\b/i.test(text)) {
      return { kind: 'system_status' }
    }

    const restartMatch =
      text.match(/\b(?:restart|reboot)\s+(?:the\s+)?(?:service|container)\s+([a-zA-Z0-9._-]+)/i) ||
      text.match(/\brestart\s+([a-zA-Z0-9._-]+)\b/i)
    if (restartMatch) {
      return { kind: 'restart_service', serviceName: restartMatch[1] }
    }

    const serviceStatusMatch =
      text.match(/\b(?:status of|check|inspect|show)\s+(?:the\s+)?(?:service|container)\s+([a-zA-Z0-9._-]+)/i) ||
      text.match(/\bhow is\s+([a-zA-Z0-9._-]+)\s+(?:doing|running)\b/i)
    if (serviceStatusMatch) {
      return { kind: 'service_status', serviceName: serviceStatusMatch[1] }
    }

    if (/\b(service status|services status|installed services|running services)\b/i.test(text)) {
      return { kind: 'service_status' }
    }

    return null
  }

  private getCurrentTime(): string {
    const now = getNow()
    return `It is ${now.toFormat('h:mm a')} in ${now.zoneName}.`
  }

  private getCurrentDate(): string {
    const now = getNow()
    return `Today is ${now.toFormat('EEEE, MMMM d, yyyy')}.`
  }

  private getCurrentTimeAndDate(): string {
    const now = getNow()
    return `It is ${now.toFormat('h:mm a')} on ${now.toFormat('EEEE, MMMM d, yyyy')} in ${now.zoneName}.`
  }

  private async getUptime(): Promise<string> {
    const systemInfo = await this.systemService.getSystemInfo()
    if (!systemInfo?.uptime?.uptime) {
      return `I couldn't determine the current uptime.`
    }
    return `System uptime: ${formatUptime(systemInfo.uptime.uptime)}`
  }

  private async getSystemStatus(): Promise<string> {
    const systemInfo = await this.systemService.getSystemInfo()
    if (!systemInfo) {
      return `I couldn't retrieve the current system status.`
    }

    const cpuLoad = Math.round(systemInfo.currentLoad?.currentLoad || 0)
    const memUsedGb = systemInfo.mem ? bytesToGb(systemInfo.mem.used) : null
    const memTotalGb = systemInfo.mem ? bytesToGb(systemInfo.mem.total) : null
    const uptime = systemInfo.uptime?.uptime ? formatUptime(systemInfo.uptime.uptime) : 'unknown'
    const gpuSummary =
      systemInfo.graphics?.controllers?.length > 0
        ? systemInfo.graphics.controllers
            .slice(0, 2)
            .map((gpu) => `${gpu.model}${gpu.vram ? ` (${gpu.vram} MB)` : ''}`)
            .join('; ')
        : 'none detected'

    return [
      `System status:`,
      `CPU load: ${cpuLoad}%`,
      `Memory: ${memUsedGb ?? 'unknown'} / ${memTotalGb ?? 'unknown'} GB`,
      `Uptime: ${uptime}`,
      `GPU: ${gpuSummary}`,
    ].join('\n')
  }

  private async getServiceStatus(serviceName?: string): Promise<string> {
    const services = await this.systemService.getServices({ installedOnly: true })
    if (!serviceName) {
      if (services.length === 0) {
        return `I don't see any installed services right now.`
      }
      const lines = services
        .slice(0, 20)
        .map((service) => `${service.service_name}: ${service.status}`)
      return `Installed service status:\n${lines.join('\n')}`
    }

    const resolved = await this.resolveServiceName(serviceName)
    if (!resolved) {
      return `I couldn't find a managed service named ${serviceName}.`
    }

    const service = services.find((item) => item.service_name === resolved)
    if (!service) {
      return `${resolved} is not currently installed.`
    }

    const parts = [
      `Service ${service.service_name}:`,
      `Friendly name: ${service.friendly_name}`,
      `Status: ${service.status}`,
      `Install status: ${service.installation_status}`,
    ]
    if (service.ui_location) {
      parts.push(`UI location: ${service.ui_location}`)
    }
    return parts.join('\n')
  }

  private async restartService(serviceName: string): Promise<string> {
    const resolved = await this.resolveServiceName(serviceName)
    if (!resolved) {
      return `I couldn't find a managed service named ${serviceName}.`
    }

    const result = await this.dockerService.affectContainer(resolved, 'restart')
    if (!result.success) {
      return result.message
    }

    const statuses = await this.dockerService.getServicesStatus()
    const updatedStatus = statuses.find((status) => status.service_name === resolved)?.status || 'unknown'
    return `${result.message}\nCurrent status: ${updatedStatus}`
  }

  private async resolveServiceName(rawName: string): Promise<string | null> {
    const normalized = rawName.trim().toLowerCase()
    const directMatch = normalized.startsWith('nomad_') ? normalized : `nomad_${normalized}`

    const services = await Service.query()
      .select('service_name', 'friendly_name')
      .where('installed', true)

    const exactService = services.find((service) => service.service_name.toLowerCase() === normalized)
    if (exactService) return exactService.service_name

    const exactPrefixed = services.find((service) => service.service_name.toLowerCase() === directMatch)
    if (exactPrefixed) return exactPrefixed.service_name

    const friendly = services.find(
      (service) =>
        service.friendly_name?.toLowerCase() === normalized ||
        service.friendly_name?.toLowerCase().replace(/\s+/g, '-') === normalized
    )
    if (friendly) return friendly.service_name

    return null
  }
}

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes || parts.length === 0) parts.push(`${minutes}m`)
  return parts.join(' ')
}

function bytesToGb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1)
}

function getNow(): DateTime {
  const tz = env.get('NOMAD_TIMEZONE')
  return tz ? DateTime.now().setZone(tz) : DateTime.local()
}
