import { inject } from '@adonisjs/core'
import { chmod, chown, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import path from 'node:path'

type ShortcutDefinition = {
  aliases: string[]
  fileName: string
  name: string
  comment: string
  exec: string
  icon: string
  categories: string[]
}

const HOST_DESKTOP_ROOT = '/host-desktop'
const FALLBACK_DESKTOP_ROOT = '/home/nomad/Desktop'

const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    aliases: ['home assistant', 'homeassistant', 'ha'],
    fileName: 'home-assistant.desktop',
    name: 'Home Assistant',
    comment: 'Open Home Assistant',
    exec: '/usr/bin/google-chrome http://127.0.0.1:8123',
    icon: 'applications-internet',
    categories: ['Network', 'WebBrowser'],
  },
  {
    aliases: ['nomad', 'n.o.m.a.d.', 'project nomad'],
    fileName: 'nomad.desktop',
    name: 'N.O.M.A.D.',
    comment: 'Open Project N.O.M.A.D.',
    exec: '/usr/bin/google-chrome http://192.168.10.161:8080',
    icon: 'applications-internet',
    categories: ['Network', 'WebBrowser'],
  },
]

@inject()
export class DesktopShortcutService {
  describeCapabilities(): string {
    return [
      'Desktop shortcut tool:',
      '- Creates approved .desktop launchers on the host Desktop',
      '- Removes approved .desktop launchers from the host Desktop',
      '- Supported targets: Home Assistant, N.O.M.A.D.',
      '- Writes only to the Desktop bridge, not the rest of the host home directory',
    ].join('\n')
  }

  async createApprovedShortcut(targetName: string): Promise<string> {
    const definition = this.resolveDefinition(targetName)
    if (!definition) {
      return [
        `I can create Desktop shortcuts for approved targets only.`,
        `Right now I support: Home Assistant, N.O.M.A.D.`,
      ].join(' ')
    }

    const desktopRoot = await this.getWritableDesktopRoot()
    const shortcutPath = path.join(desktopRoot, definition.fileName)
    const content = this.buildDesktopEntry(definition)

    await writeFile(shortcutPath, content, 'utf-8')
    await chmod(shortcutPath, 0o755)
    await this.alignOwnership(shortcutPath, desktopRoot)

    const verification = await stat(shortcutPath)
    if (!verification.isFile()) {
      throw new Error(`Shortcut verification failed for ${shortcutPath}.`)
    }
    const verifiedContent = await readFile(shortcutPath, 'utf-8')
    if (verifiedContent !== content) {
      throw new Error(`Shortcut verification content mismatch for ${shortcutPath}.`)
    }

    return `I created the ${definition.name} shortcut on the Desktop.`
  }

  async removeApprovedShortcut(targetName: string): Promise<string> {
    const definition = this.resolveDefinition(targetName)
    if (!definition) {
      return [
        `I can remove Desktop shortcuts for approved targets only.`,
        `Right now I support: Home Assistant, N.O.M.A.D.`,
      ].join(' ')
    }

    const desktopRoots = await this.getDesktopRoots()
    const shortcutPaths = desktopRoots.map((root) => path.join(root, definition.fileName))
    const existingPaths: string[] = []
    const seenFiles = new Set<string>()

    for (const shortcutPath of shortcutPaths) {
      try {
        const existing = await stat(shortcutPath)
        if (existing.isFile()) {
          const fileKey = `${existing.dev}:${existing.ino}`
          if (seenFiles.has(fileKey)) {
            continue
          }
          seenFiles.add(fileKey)
          existingPaths.push(shortcutPath)
        }
      } catch {
        continue
      }
    }

    if (existingPaths.length === 0) {
      return `I couldn't find the ${definition.name} shortcut on the Desktop.`
    }

    for (const shortcutPath of existingPaths) {
      await rm(shortcutPath)

      try {
        await stat(shortcutPath)
        throw new Error(`Shortcut removal verification failed for ${shortcutPath}.`)
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException
        if (nodeError?.code && nodeError.code !== 'ENOENT') {
          throw error
        }
      }
    }

    return `I removed the ${definition.name} shortcut from the Desktop.`
  }

  private resolveDefinition(targetName: string): ShortcutDefinition | null {
    const normalized = normalizeTarget(targetName)
    if (!normalized) return null

    for (const definition of SHORTCUT_DEFINITIONS) {
      if (definition.aliases.some((alias) => normalizeTarget(alias) === normalized)) {
        return definition
      }
    }

    return null
  }

  private buildDesktopEntry(definition: ShortcutDefinition): string {
    return [
      '[Desktop Entry]',
      'Version=1.0',
      'Type=Application',
      `Name=${definition.name}`,
      `Comment=${definition.comment}`,
      `Exec=${definition.exec}`,
      `Icon=${definition.icon}`,
      'Terminal=false',
      `Categories=${definition.categories.join(';')};`,
      'StartupNotify=true',
      '',
    ].join('\n')
  }

  private async getWritableDesktopRoot(): Promise<string> {
    const roots = await this.getDesktopRoots()
    return roots[0] || HOST_DESKTOP_ROOT
  }

  private async getDesktopRoots(): Promise<string[]> {
    const roots = [HOST_DESKTOP_ROOT, FALLBACK_DESKTOP_ROOT]
    const availableRoots: string[] = []
    const seenRoots = new Set<string>()

    for (const root of roots) {
      try {
        await mkdir(root, { recursive: true })
        const info = await stat(root)
        const rootKey = `${info.dev}:${info.ino}`
        if (seenRoots.has(rootKey)) {
          continue
        }
        seenRoots.add(rootKey)
        availableRoots.push(root)
      } catch {
        continue
      }
    }

    return availableRoots
  }

  private async alignOwnership(shortcutPath: string, desktopRoot: string) {
    const desktopInfo = await stat(desktopRoot)
    await chown(shortcutPath, desktopInfo.uid, desktopInfo.gid)
  }
}

function normalizeTarget(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+(?:please|for me)$/i, '')
    .replace(/^(?:create|make|add)\s+(?:a\s+)?shortcut\s+(?:for\s+)?/i, '')
    .replace(/^(?:on|in)\s+ubuntu$/i, '')
    .replace(/\s+(?:on|in)\s+ubuntu$/i, '')
    .replace(/^(?:on|to)\s+the\s+desktop$/i, '')
    .replace(/\s+(?:on|to)\s+the\s+desktop$/i, '')
    .replace(/\s+and\s+put\s+it\s+on\s+the\s+desktop$/i, '')
    .replace(/\s+and\s+add\s+it\s+to\s+the\s+desktop$/i, '')
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
