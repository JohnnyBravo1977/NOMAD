import type { ReactNode } from 'react'
import classNames from '~/lib/classNames'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatMessage } from '../../../types/chat'

export interface ChatMessageBubbleProps {
  message: ChatMessage
  trailingActions?: ReactNode
}

function stripReasoningBlocks(text: string): string {
  let out = text
  out = out.replace(/```[\s\S]*?\b(Reasoning|Thinking Process)[\s\S]*?```/gi, '').trimStart()
  out = out.replace(/^(Reasoning|Thinking Process)\s*[:\-]*[\s\S]*?\n\s*\n/i, '').trimStart()
  return out
}

export default function ChatMessageBubble({ message, trailingActions }: ChatMessageBubbleProps) {
  const isMobileMessageViewport = () => {
    if (typeof window === 'undefined') return false

    const coarsePointer =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    return coarsePointer || window.innerWidth <= 1024
  }

  const mobileMessageStyle = isMobileMessageViewport()
    ? { fontSize: '56px', lineHeight: '1.15' }
    : undefined

  const assistantContent =
    message.role === 'assistant' ? stripReasoningBlocks(message.content || '') : message.content

  return (
    <div
      className={classNames(
        'max-w-[97%] md:max-w-[70%] rounded-xl px-4 py-4 md:rounded-lg md:py-3',
        message.role === 'user'
          ? 'bg-desert-green text-white'
          : 'bg-surface-secondary text-text-primary'
      )}
    >
      {message.isThinking && message.thinking && (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-amber-700">
            <span>Reasoning</span>
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          </div>
          <div className="prose prose-xs max-h-32 max-w-none overflow-y-auto text-amber-900/80">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.thinking}</ReactMarkdown>
          </div>
        </div>
      )}
      {!message.isThinking && message.thinking && (
        <details className="mb-3 rounded border border-border-subtle bg-surface-secondary text-xs">
          <summary className="cursor-pointer select-none px-3 py-2 font-medium text-text-muted hover:text-text-primary">
            {message.thinkingDuration !== undefined
              ? `Thought for ${message.thinkingDuration}s`
              : 'Reasoning'}
          </summary>
          <div className="prose prose-xs max-h-48 max-w-none overflow-y-auto border-t border-border-subtle px-3 pb-3 pt-2 text-text-secondary">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.thinking}</ReactMarkdown>
          </div>
        </details>
      )}
      <div
        className={classNames(
          'break-words',
          message.role === 'assistant'
            ? 'max-w-none md:prose md:prose-sm md:text-base md:leading-normal'
            : 'whitespace-pre-wrap md:text-base md:leading-6'
        )}
        style={mobileMessageStyle}
      >
        {message.role === 'assistant' ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ({ className, children, ...props }: any) => {
                const isInline = !className?.includes('language-')
                if (isInline) {
                  return (
                    <code
                      className="rounded bg-gray-800 px-2 py-0.5 font-mono text-sm text-gray-100"
                      style={isMobileMessageViewport() ? { fontSize: '0.75em', lineHeight: '1.2' } : undefined}
                      {...props}
                    >
                      {children}
                    </code>
                  )
                }
                return (
                  <code
                    className="my-2 block overflow-x-auto rounded-lg bg-gray-800 p-3 font-mono text-sm text-gray-100"
                    style={isMobileMessageViewport() ? { fontSize: '0.7em', lineHeight: '1.2' } : undefined}
                    {...props}
                  >
                    {children}
                  </code>
                )
              },
              p: ({ children }) => (
                <p className="mb-4 last:mb-0 md:mb-2 md:text-base md:leading-6" style={mobileMessageStyle}>
                  {children}
                </p>
              ),
              ul: ({ children }) => (
                <ul className="mb-4 list-disc pl-8 md:mb-2 md:pl-5 md:text-base md:leading-6" style={mobileMessageStyle}>
                  {children}
                </ul>
              ),
              ol: ({ children }) => (
                <ol className="mb-4 list-decimal pl-8 md:mb-2 md:pl-5 md:text-base md:leading-6" style={mobileMessageStyle}>
                  {children}
                </ol>
              ),
              li: ({ children }) => (
                <li className="mb-1.5 md:mb-1" style={mobileMessageStyle}>
                  {children}
                </li>
              ),
              h1: ({ children }) => (
                <h1
                  className="mb-3 font-bold md:mb-2 md:text-xl"
                  style={isMobileMessageViewport() ? { fontSize: '60px', lineHeight: '1.1' } : undefined}
                >
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2
                  className="mb-3 font-bold md:mb-2 md:text-lg"
                  style={isMobileMessageViewport() ? { fontSize: '58px', lineHeight: '1.1' } : undefined}
                >
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3
                  className="mb-3 font-bold md:mb-2 md:text-base"
                  style={isMobileMessageViewport() ? { fontSize: '56px', lineHeight: '1.1' } : undefined}
                >
                  {children}
                </h3>
              ),
              blockquote: ({ children }) => (
                <blockquote
                  className="my-3 border-l-4 border-border-default pl-5 italic md:my-2 md:pl-4 md:text-base md:leading-6"
                  style={mobileMessageStyle}
                >
                  {children}
                </blockquote>
              ),
              a: ({ children, href }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-desert-green underline hover:text-desert-green/80"
                >
                  {children}
                </a>
              ),
            }}
          >
            {assistantContent}
          </ReactMarkdown>
        ) : (
          <span style={mobileMessageStyle}>{assistantContent}</span>
        )}
        {message.isStreaming && <span className="ml-1 inline-block h-2 w-1 animate-pulse rounded-full bg-current" />}
      </div>
      {message.attachments && message.attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((attachment) => (
            <a
              key={attachment.id}
              href={attachment.viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={classNames(
                'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm shadow-sm',
                message.role === 'user'
                  ? 'border-white/20 bg-white/10 text-white'
                  : 'border-border-subtle bg-surface-primary text-text-primary'
              )}
            >
              {attachment.kind === 'image' ? (
                <img
                  src={attachment.viewUrl}
                  alt={attachment.name}
                  className="h-12 w-12 rounded-lg object-cover"
                />
              ) : (
                <div
                  className={classNames(
                    'flex h-12 w-12 items-center justify-center rounded-lg',
                    message.role === 'user' ? 'bg-white/15' : 'bg-desert-orange/10 text-desert-orange'
                  )}
                >
                  PDF
                </div>
              )}
              <div className="min-w-0">
                <div className="max-w-[200px] truncate font-medium">{attachment.name}</div>
                <div
                  className={classNames(
                    'text-xs',
                    message.role === 'user' ? 'text-white/70' : 'text-text-muted'
                  )}
                >
                  {attachment.kind === 'image' ? 'Image attachment' : 'PDF attachment'}
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
      <div
        className={classNames(
          'mt-2 flex items-center justify-between gap-3 text-sm md:text-base',
          message.role === 'user' ? 'text-white/70' : 'text-text-muted'
        )}
      >
        <div>
          {message.timestamp.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
        {trailingActions ? <div className="flex items-center gap-2">{trailingActions}</div> : null}
      </div>
    </div>
  )
}
