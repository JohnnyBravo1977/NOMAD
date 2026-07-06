export interface ChatAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'pdf'
  token: string
  viewUrl: string
  width?: number
  height?: number
}

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp: Date
  attachments?: ChatAttachment[]
  isStreaming?: boolean
  thinking?: string
  isThinking?: boolean
  thinkingDuration?: number
}

export interface ChatSession {
  id: string
  title: string
  lastMessage?: string
  timestamp: Date
}
