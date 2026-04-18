import { inject } from '@adonisjs/core'
import { appendFile, mkdir, readFile, stat, writeFile } from 'fs/promises'
import path from 'node:path'

type EditTask =
  | { kind: 'write_file'; filePath: string; content: string }
  | { kind: 'append_file'; filePath: string; content: string }
  | { kind: 'replace_in_file'; filePath: string; search: string; replace: string }

const ALLOWED_WRITE_ROOTS = ['/app/storage', '/tmp']
const MAX_WRITE_BYTES = 64 * 1024

@inject()
export class EditWorkerService {
  describeCapabilities(): string {
    return [
      'Edit worker capabilities:',
      '- Create or overwrite text files',
      '- Append text to files',
      '- Replace exact text inside files',
      'Write roots:',
      `- ${ALLOWED_WRITE_ROOTS.join('\n- ')}`,
      `Write size limit: ${MAX_WRITE_BYTES} bytes per operation`,
    ].join('\n')
  }

  async tryHandle(userText: string): Promise<string | null> {
    const task = this.parseTask(userText)
    if (!task) return null

    switch (task.kind) {
      case 'write_file':
        return this.writeTextFile(task.filePath, task.content)
      case 'append_file':
        return this.appendTextFile(task.filePath, task.content)
      case 'replace_in_file':
        return this.replaceInTextFile(task.filePath, task.search, task.replace)
      default:
        return null
    }
  }

  private parseTask(userText: string): EditTask | null {
    const text = userText.trim()

    let match = text.match(
      /\b(?:create|write|overwrite)\s+(?:the\s+)?file\s+([^\s]+)\s+(?:with|containing)\s+([\s\S]+)$/i
    )
    if (match) {
      return {
        kind: 'write_file',
        filePath: stripWrappingQuotes(match[1]),
        content: stripWrappingQuotes(match[2]),
      }
    }

    match = text.match(/\bappend\s+([\s\S]+?)\s+to\s+(?:the\s+)?file\s+([^\s]+)$/i)
    if (match) {
      return {
        kind: 'append_file',
        content: stripWrappingQuotes(match[1]),
        filePath: stripWrappingQuotes(match[2]),
      }
    }

    match = text.match(
      /\breplace\s+["']([\s\S]+?)["']\s+with\s+["']([\s\S]+?)["']\s+in\s+(?:the\s+)?file\s+([^\s]+)$/i
    )
    if (match) {
      return {
        kind: 'replace_in_file',
        search: match[1],
        replace: match[2],
        filePath: stripWrappingQuotes(match[3]),
      }
    }

    return null
  }

  async writeTextFile(filePath: string, content: string): Promise<string> {
    const resolvedPath = this.resolveWritablePath(filePath)
    this.assertContentSize(content)
    await mkdir(path.dirname(resolvedPath), { recursive: true })
    await writeFile(resolvedPath, content, 'utf-8')
    return `Wrote ${content.length} characters to ${resolvedPath}.`
  }

  async appendTextFile(filePath: string, content: string): Promise<string> {
    const resolvedPath = this.resolveWritablePath(filePath)
    this.assertContentSize(content)
    await mkdir(path.dirname(resolvedPath), { recursive: true })
    await appendFile(resolvedPath, content, 'utf-8')
    return `Appended ${content.length} characters to ${resolvedPath}.`
  }

  async replaceInTextFile(filePath: string, search: string, replace: string): Promise<string> {
    const resolvedPath = this.resolveWritablePath(filePath)
    const fileInfo = await stat(resolvedPath)
    if (!fileInfo.isFile()) {
      return `${filePath} is not a file.`
    }

    const original = await readFile(resolvedPath, 'utf-8')
    const occurrences = original.split(search).length - 1
    if (occurrences <= 0) {
      return `I couldn't find "${search}" in ${resolvedPath}.`
    }

    const updated = original.split(search).join(replace)
    this.assertContentSize(updated)
    await writeFile(resolvedPath, updated, 'utf-8')
    return `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${resolvedPath}.`
  }

  private resolveWritablePath(requestedPath: string): string {
    const trimmed = requestedPath.trim()
    const resolved = path.resolve(trimmed)
    const allowed = ALLOWED_WRITE_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`))
    if (!allowed) {
      throw new Error(`Path ${requestedPath} is outside the allowed write roots.`)
    }
    return resolved
  }

  private assertContentSize(content: string) {
    if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) {
      throw new Error(`Requested edit is too large. Keep writes under ${MAX_WRITE_BYTES} bytes.`)
    }
  }
}

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}
