import clsx from 'clsx'

interface BouncingDotsProps {
  text: string
  containerClassName?: string
  textClassName?: string
}

export default function BouncingDots({ text, containerClassName, textClassName }: BouncingDotsProps) {
  return (
    <div className={clsx("flex items-center justify-center gap-2", containerClassName)}>
      <span className={clsx("text-text-secondary", textClassName)}>{text}</span>
      <span className="mt-0.5 flex gap-1">
        <span
          className="h-1 w-1 animate-bounce rounded-full bg-text-secondary"
          style={{ animationDelay: '0ms' }}
        />
        <span
          className="h-1 w-1 animate-bounce rounded-full bg-text-secondary"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="h-1 w-1 animate-bounce rounded-full bg-text-secondary"
          style={{ animationDelay: '300ms' }}
        />
      </span>
    </div>
  )
}
