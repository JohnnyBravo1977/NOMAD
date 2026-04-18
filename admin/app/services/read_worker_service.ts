import { inject } from '@adonisjs/core'
import { DockerService } from '#services/docker_service'
import { readFile, readdir, stat } from 'fs/promises'
import path from 'node:path'

type ReadTask =
  | { kind: 'list_containers' }
  | { kind: 'inspect_container'; containerName: string }
  | { kind: 'tail_container_logs'; containerName: string }
  | { kind: 'read_file'; filePath: string }
  | { kind: 'list_directory'; dirPath: string }
  | { kind: 'inspect_path'; targetPath: string }
  | { kind: 'list_home_assistant_directories' }
  | { kind: 'find_files'; query: string }
  | { kind: 'search_text'; pattern: string; targetPath?: string }
  | { kind: 'check_disk_usage'; targetPath?: string }

const ALLOWED_READ_ROOTS = [
  '/app',
  '/tmp',
]
const MAX_FILE_BYTES = 64 * 1024
const MAX_SEARCH_RESULTS = 12
const MAX_WALK_RESULTS = 24

@inject()
export class ReadWorkerService {
  constructor(private dockerService: DockerService) {}

  describeCapabilities(): string {
    return [
      'Read worker capabilities:',
      '- List Docker containers',
      '- Inspect Docker containers by name',
      '- Read recent container logs',
      '- Read text files under /app and /tmp',
      '- List directories under /app and /tmp',
      '- Inspect the local app workspace',
      '- Inspect top-level Home Assistant /config directories through the Home Assistant container',
      '- Find files under /app and /tmp',
      '- Search text inside allowed read paths',
      '- Report disk usage for allowed read paths',
      'Read roots:',
      `- ${ALLOWED_READ_ROOTS.join('\n- ')}`,
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<string | null> {
    const task = this.parseTask(userText)
    if (!task) return null

    switch (task.kind) {
      case 'list_containers':
        return this.listContainers()
      case 'inspect_container':
        return this.inspectContainer(task.containerName)
      case 'tail_container_logs':
        return this.tailContainerLogs(task.containerName)
      case 'read_file':
        return this.readTextFile(task.filePath)
      case 'list_directory':
        return this.listDirectory(task.dirPath)
      case 'inspect_path':
        return this.inspectPath(task.targetPath)
      case 'list_home_assistant_directories':
        return this.listHomeAssistantDirectories()
      case 'find_files':
        return this.findFiles(task.query)
      case 'search_text':
        return this.searchText(task.pattern, task.targetPath)
      case 'check_disk_usage':
        return this.checkDiskUsage(task.targetPath)
      default:
        return null
    }
  }

  private parseTask(userText: string): ReadTask | null {
    const text = userText.trim()

    if (/\b(?:list|show)\s+(?:all\s+)?containers\b/i.test(text) || /\bwhat containers\b/i.test(text)) {
      return { kind: 'list_containers' }
    }

    if (
      /\b(workspace|project|app workspace)\b/i.test(text) &&
      /\b(?:inspect|show|list|what(?:'s| is).*(?:there|in it)|tell me what is there|look at)\b/i.test(text)
    ) {
      return { kind: 'list_directory', dirPath: '/app' }
    }

    let match =
      text.match(/\b(?:inspect|check|look at|show)\s+(?:the\s+)?container\s+([a-zA-Z0-9._-]+)/i) ||
      text.match(/\b(?:inspect|check|look at|show)\s+(?:the\s+)?([a-zA-Z0-9._-]+)\s+container\b/i) ||
      text.match(/\b(?:inspect|check|look at|show)\s+([a-zA-Z0-9._-]+)\s+container\b/i)
    if (match) {
      return { kind: 'inspect_container', containerName: match[1] }
    }

    match =
      text.match(/\b(?:show|tail|read|inspect|check)\s+(?:the\s+)?logs(?:\s+for|\s+of)?\s+([a-zA-Z0-9._-]+)/i) ||
      text.match(/\b(?:show|tail|read|inspect|check)\s+(?:the\s+)?([a-zA-Z0-9._-]+)\s+logs\b/i) ||
      text.match(/\b([a-zA-Z0-9._-]+)\s+logs\b/i)
    if (match) {
      return { kind: 'tail_container_logs', containerName: match[1] }
    }

    match =
      text.match(/\b(?:read|show|open|inspect)\s+(?:the\s+)?file\s+(.+)$/i) ||
      text.match(/\b(?:read|show|open|inspect)\s+((?:\/app|\/tmp)[^\s]*)$/i)
    if (match) {
      return { kind: 'read_file', filePath: stripWrappingQuotes(match[1]) }
    }

    match =
      text.match(/\b(?:list|show)\s+(?:the\s+)?(?:directory|folder)\s+(.+)$/i) ||
      text.match(/\b(?:list|show)\s+files in\s+(.+)$/i) ||
      text.match(/\b(?:list|show)\s+((?:\/app|\/tmp)[^\n]*)$/i)
    if (match) {
      return { kind: 'list_directory', dirPath: stripWrappingQuotes(match[1]) }
    }

    match =
      text.match(/\b(?:inspect|show|open|read|list)\s+((?:\/app|\/tmp)[^\n]*)$/i)
    if (match) {
      return { kind: 'inspect_path', targetPath: stripWrappingQuotes(match[1]) }
    }

    if (
      /\b(home assistant|ha)\b/i.test(text) &&
      /\b(file system|filesystem|directories|directory structure|folders|config structure|config directories)\b/i.test(text)
    ) {
      return { kind: 'list_home_assistant_directories' }
    }

    const searchMatch =
      text.match(/\b(?:search|look)\s+(?:for\s+)?["']([^"']+)["'](?:\s+in\s+(.+))?$/i) ||
      text.match(/\bgrep\s+["']([^"']+)["'](?:\s+in\s+(.+))?$/i)
    if (searchMatch) {
      return {
        kind: 'search_text',
        pattern: searchMatch[1],
        targetPath: searchMatch[2] ? stripWrappingQuotes(searchMatch[2]) : undefined,
      }
    }

    match =
      text.match(/\b(?:find|locate)\s+(?:the\s+)?(?:file\s+)?(.+)$/i) ||
      text.match(/\bwhere is\s+(.+)$/i)
    if (match) {
      return { kind: 'find_files', query: stripWrappingQuotes(match[1]) }
    }

    if (/\b(?:disk usage|storage usage|space left|free space|df -h)\b/i.test(text)) {
      const pathMatch = text.match(/\b(?:for|on|in)\s+((?:\/app|\/tmp)[^\s]*)/i)
      return {
        kind: 'check_disk_usage',
        targetPath: pathMatch ? stripWrappingQuotes(pathMatch[1]) : undefined,
      }
    }

    return null
  }

  async listContainers(): Promise<string> {
    const containers = await this.dockerService.docker.listContainers({ all: true })
    if (containers.length === 0) {
      return `I couldn't find any Docker containers.`
    }

    const running = containers.filter((container) => (container.State || '').toLowerCase() === 'running')
    const others = containers.filter((container) => (container.State || '').toLowerCase() !== 'running')
    const visible = running.sort((a, b) => {
      const aName = a.Names?.[0]?.replace(/^\//, '') || a.Id
      const bName = b.Names?.[0]?.replace(/^\//, '') || b.Id
      return aName.localeCompare(bName)
    })
      .slice(0, 20)
    const lines = visible
      .map((container) => {
        const name = container.Names?.[0]?.replace(/^\//, '') || container.Id
        const state = container.State || 'unknown'
        const image = container.Image || 'unknown'
        return `${name} — ${state} — ${image}`
      })

    const parts = [
      `I checked the current Docker containers.`,
      `${running.length} running, ${others.length} not running.`,
      `Here is what I found:\n${lines.join('\n')}`,
    ]
    if (others.length > 0) {
      parts.push(`I left out ${others.length} non-running container${others.length === 1 ? '' : 's'} to keep this readable.`)
    }

    return parts.join('\n')
  }

  async inspectContainer(containerName: string): Promise<string> {
    const container = await this.resolveContainer(containerName)
    if (!container) {
      return `I couldn't find a container named ${containerName}.`
    }

    const info = await this.dockerService.docker.getContainer(container.Id).inspect()
    const image = info.Config?.Image || 'unknown'
    const state = info.State?.Status || 'unknown'
    const ports = Object.entries(info.NetworkSettings?.Ports || {})
      .flatMap(([containerPort, bindings]) =>
        Array.isArray(bindings) && bindings.length > 0
          ? bindings.map((binding) => `${binding.HostPort}->${containerPort}`)
          : [containerPort]
      )
      .slice(0, 8)
    const mounts = (info.Mounts || [])
      .map((mount) => `${mount.Source} -> ${mount.Destination}`)
      .slice(0, 6)

    const lines = [
      `I checked the ${containerName} container.`,
      `It is currently ${state}.`,
      `Image: ${image}`,
    ]
    if (ports.length > 0) lines.push(`Ports: ${ports.join(', ')}`)
    if (mounts.length > 0) lines.push(`Mounts: ${mounts.join('; ')}`)

    return lines.join('\n')
  }

  async tailContainerLogs(containerName: string): Promise<string> {
    const container = await this.resolveContainer(containerName)
    if (!container) {
      return `I couldn't find a container named ${containerName}.`
    }

    const logBuffer = await this.dockerService.docker
      .getContainer(container.Id)
      .logs({ stdout: true, stderr: true, tail: 40 })
    const rawText = Buffer.isBuffer(logBuffer)
      ? demuxDockerLogBuffer(logBuffer)
      : String(logBuffer)
    const cleaned = stripAnsi(stripDockerLogFrames(rawText))
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-20)

    if (cleaned.length === 0) {
      return `I checked ${containerName}, but there weren't any recent logs to show.`
    }

    return `I pulled the latest logs from ${containerName}. Here are the newest lines:\n${cleaned.join('\n')}`
  }

  async readTextFile(filePath: string): Promise<string> {
    const resolvedPath = this.resolveAllowedPath(filePath)
    const fileInfo = await stat(resolvedPath)
    if (!fileInfo.isFile()) {
      return `${filePath} is not a file.`
    }

    const content = await readFile(resolvedPath, 'utf-8')
    const isTruncated = content.length > MAX_FILE_BYTES
    const trimmed = isTruncated ? `${content.slice(0, MAX_FILE_BYTES)}\n...[truncated]` : content
    return isTruncated
      ? `I opened ${resolvedPath}. The file is large, so here is the beginning of it:\n${trimmed}`
      : `I opened ${resolvedPath}. Here is the current file content:\n${trimmed}`
  }

  async listDirectory(dirPath: string): Promise<string> {
    const resolvedPath = this.resolveAllowedPath(dirPath)
    const dirInfo = await stat(resolvedPath)
    if (!dirInfo.isDirectory()) {
      return `${dirPath} is not a directory.`
    }

    const entries = await readdir(resolvedPath, { withFileTypes: true })
    const sortedEntries = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 50)
    const directories = sortedEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    const files = sortedEntries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name)

    const lines = [this.describeDirectorySummary(resolvedPath, directories, files, sortedEntries.length)]

    return sortedEntries.length > 0
      ? lines.join('\n')
      : `${resolvedPath} is empty.`
  }

  private describeDirectorySummary(
    resolvedPath: string,
    directories: string[],
    files: string[],
    totalItems: number
  ): string {
    const folderPreview = formatList(directories.slice(0, 8))
    const filePreview = formatList(files.slice(0, 8))
    const locationLabel = resolvedPath === '/app' ? 'the app workspace' : resolvedPath

    const parts = [`I checked ${locationLabel}.`]
    parts.push(`I found ${totalItems} top-level item${totalItems === 1 ? '' : 's'}.`)

    if (folderPreview) {
      parts.push(`The main folders in there are ${folderPreview}.`)
    }

    if (filePreview) {
      parts.push(`The key files I can see are ${filePreview}.`)
    }

    return parts.join(' ')
  }

  async listHomeAssistantDirectories(): Promise<string> {
    const container = await this.resolveContainer('homeassistant')
    if (!container) {
      return `I couldn't find the Home Assistant container.`
    }

    const exec = await this.dockerService.docker.getContainer(container.Id).exec({
      Cmd: ['sh', '-lc', 'find /config -maxdepth 1 -mindepth 1 -type d | sort'],
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    })

    const stream = await exec.start({ Tty: true })
    const output = await new Promise<string>((resolve, reject) => {
      let data = ''
      stream.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf-8')
      })
      stream.on('end', () => resolve(data.trim()))
      stream.on('error', reject)
    })

    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      return `I checked Home Assistant, but I didn't find any top-level directories under /config.`
    }

    return `Top-level Home Assistant config directories:\n${lines.join('\n')}`
  }

  async inspectPath(targetPath: string): Promise<string> {
    const resolvedPath = this.resolveAllowedPath(targetPath)
    const entryInfo = await stat(resolvedPath)
    if (entryInfo.isDirectory()) {
      return this.listDirectory(targetPath)
    }
    if (entryInfo.isFile()) {
      return this.readTextFile(targetPath)
    }
    return `${targetPath} is neither a regular file nor a directory.`
  }

  async findFiles(query: string): Promise<string> {
    const normalizedQuery = query.trim().toLowerCase()
    const results: string[] = []

    for (const root of ALLOWED_READ_ROOTS) {
      await this.walkFiles(root, async (fullPath) => {
        if (results.length >= MAX_WALK_RESULTS) return false
        if (path.basename(fullPath).toLowerCase().includes(normalizedQuery)) {
          results.push(fullPath)
        }
        return true
      })
      if (results.length >= MAX_WALK_RESULTS) break
    }

    if (results.length === 0) {
      return `I couldn't find any files matching ${query}.`
    }

    return `I found these matching files:\n${results.join('\n')}`
  }

  async searchText(pattern: string, targetPath?: string): Promise<string> {
    const roots = targetPath ? [this.resolveAllowedPath(targetPath)] : ALLOWED_READ_ROOTS
    const normalizedPattern = pattern.toLowerCase()
    const matches: string[] = []

    for (const root of roots) {
      await this.walkFiles(root, async (fullPath) => {
        if (matches.length >= MAX_SEARCH_RESULTS) return false
        const fileInfo = await stat(fullPath)
        if (!fileInfo.isFile() || fileInfo.size > MAX_FILE_BYTES) return true

        try {
          const content = await readFile(fullPath, 'utf-8')
          const lines = content.split('\n')
          for (let index = 0; index < lines.length; index += 1) {
            if (lines[index].toLowerCase().includes(normalizedPattern)) {
              matches.push(`${fullPath}:${index + 1}: ${lines[index].trim()}`)
              if (matches.length >= MAX_SEARCH_RESULTS) return false
            }
          }
        } catch {
          return true
        }
        return true
      })
      if (matches.length >= MAX_SEARCH_RESULTS) break
    }

    if (matches.length === 0) {
      return `I couldn't find "${pattern}" in the allowed read paths.`
    }

    return `I found these matches for "${pattern}":\n${matches.join('\n')}`
  }

  async checkDiskUsage(targetPath?: string): Promise<string> {
    const roots = targetPath ? [this.resolveAllowedPath(targetPath)] : ALLOWED_READ_ROOTS
    const lines: string[] = []

    for (const root of roots) {
      const fileInfo = await stat(root)
      if (fileInfo.isDirectory()) {
        const sizeBytes = await this.directorySize(root)
        lines.push(`${root}: ${formatBytes(sizeBytes)}`)
      } else {
        lines.push(`${root}: ${formatBytes(fileInfo.size)}`)
      }
    }

    return `Disk usage snapshot:\n${lines.join('\n')}`
  }

  private async resolveContainer(name: string) {
    const normalized = name.replace(/^\//, '')
    const containers = await this.dockerService.docker.listContainers({ all: true })
    const exactMatch =
      containers.find((container) =>
        container.Names.some((containerName) => containerName.replace(/^\//, '') === normalized)
      ) || null
    if (exactMatch) return exactMatch

    const containsMatch =
      containers.find((container) =>
        container.Names.some((containerName) => {
          const cleanName = containerName.replace(/^\//, '')
          return cleanName.includes(normalized) || normalized.includes(cleanName)
        })
      ) || null
    if (containsMatch) return containsMatch

    const fuzzyNeedle = normalized.replace(/[^a-z0-9]/gi, '').toLowerCase()
    return (
      containers.find((container) =>
        container.Names.some((containerName) => {
          const cleanName = containerName.replace(/^\//, '')
          const fuzzyName = cleanName.replace(/[^a-z0-9]/gi, '').toLowerCase()
          return fuzzyName.includes(fuzzyNeedle) || fuzzyNeedle.includes(fuzzyName)
        })
      ) || null
    )
  }

  private resolveAllowedPath(requestedPath: string): string {
    const trimmed = requestedPath.trim()
    const normalizedInput = trimmed
    const resolved = path.resolve(normalizedInput)
    const allowed = ALLOWED_READ_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`))
    if (!allowed) {
      throw new Error(`Path ${requestedPath} is outside the allowed read roots.`)
    }
    return resolved
  }

  private async walkFiles(
    startPath: string,
    visitor: (fullPath: string) => Promise<boolean>
  ): Promise<void> {
    const resolved = this.resolveAllowedPath(startPath)
    const dirInfo = await stat(resolved)
    if (!dirInfo.isDirectory()) {
      await visitor(resolved)
      return
    }

    const queue: string[] = [resolved]
    while (queue.length > 0) {
      const current = queue.shift()!
      const entries = await readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          queue.push(fullPath)
          continue
        }
        const shouldContinue = await visitor(fullPath)
        if (!shouldContinue) return
      }
    }
  }

  private async directorySize(dirPath: string): Promise<number> {
    let total = 0
    await this.walkFiles(dirPath, async (fullPath) => {
      const fileInfo = await stat(fullPath)
      if (fileInfo.isFile()) total += fileInfo.size
      return true
    })
    return total
  }
}

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function stripDockerLogFrames(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F]/g, '')
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

function demuxDockerLogBuffer(buffer: Buffer): string {
  if (buffer.length < 8) {
    return buffer.toString('utf-8')
  }

  let offset = 0
  let output = ''

  while (offset + 8 <= buffer.length) {
    const frameSize = buffer.readUInt32BE(offset + 4)
    const frameStart = offset + 8
    const frameEnd = frameStart + frameSize

    if (frameSize < 0 || frameEnd > buffer.length) {
      return buffer.toString('utf-8')
    }

    output += buffer.subarray(frameStart, frameEnd).toString('utf-8')
    offset = frameEnd
  }

  if (offset < buffer.length) {
    output += buffer.subarray(offset).toString('utf-8')
  }

  return output
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

function formatList(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}
