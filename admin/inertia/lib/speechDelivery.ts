export type SpeechDeliveryId =
  | 'auto'
  | 'warm'
  | 'calm'
  | 'cheerful'
  | 'gentle'
  | 'serious'
  | 'dramatic'
  | 'excited'

export const VOICE_STYLE_PRESETS = [
  {
    id: 'jarvis',
    label: 'Jarvis Butler',
    prompt:
      'Speak like a polished British butler assistant with dry wit, sharp diction, calm confidence, and precise pacing.',
  },
  {
    id: 'sparrow',
    label: 'Jack Sparrow',
    prompt:
      'Speak like a swaggering pirate captain with sly charm, wandering rhythm, playful menace, and theatrical pauses.',
  },
  {
    id: 'storyteller',
    label: 'Storyteller',
    prompt:
      'Speak like a warm cinematic storyteller with rich phrasing, patient pacing, and vivid dramatic color.',
  },
  {
    id: 'guide',
    label: 'Calm Guide',
    prompt:
      'Speak like a calm trusted guide with grounded warmth, gentle authority, and clear reassuring pacing.',
  },
] as const

function scoreMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0)
}

export function resolveSpeechDelivery(
  preferredDelivery: SpeechDeliveryId | string | undefined,
  text: string
): Exclude<SpeechDeliveryId, 'auto'> {
  const normalizedPreferred = (preferredDelivery || 'auto').toLowerCase()
  if (normalizedPreferred && normalizedPreferred !== 'auto') {
    return normalizedPreferred as Exclude<SpeechDeliveryId, 'auto'>
  }

  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!normalized) return 'calm'

  const excitedScore =
    scoreMatches(normalized, [
      /\b(amazing|awesome|fantastic|incredible|unbelievable|yes|woohoo|yay)\b/,
      /\b(let's go|we did it|here we go)\b/,
    ]) + Math.min((normalized.match(/!/g) || []).length, 2)

  const cheerfulScore = scoreMatches(normalized, [
    /\b(great|glad|happy|nice|perfect|wonderful|love|lovely|fun)\b/,
    /\b(thank you|thanks|appreciate it|good news)\b/,
  ])

  const gentleScore = scoreMatches(normalized, [
    /\b(sorry|gently|softly|comfort|comforting|tender|easy|breathe)\b/,
    /\b(it'?s okay|you'?re okay|take your time)\b/,
  ])

  const warmScore = scoreMatches(normalized, [
    /\b(i can help|i'm here|we can|let's|absolutely|of course)\b/,
    /\b(you've got this|i understand|i know|glad to help)\b/,
  ])

  const seriousScore = scoreMatches(normalized, [
    /\b(important|warning|careful|caution|critical|must|need to|required)\b/,
    /\b(step|first|second|finally|instructions?|procedure|exactly)\b/,
    /\?$/.test(normalized) ? /\?$/ : /$^/,
  ])

  const dramaticScore = scoreMatches(normalized, [
    /\b(suddenly|storm|shadow|legend|danger|doom|fate|epic|dramatic)\b/,
    /\b(behold|at last|once upon|in the distance)\b/,
  ])

  if (dramaticScore >= 2) return 'dramatic'
  if (excitedScore >= 2) return 'excited'
  if (seriousScore >= 2) return 'serious'
  if (gentleScore >= 2) return 'gentle'
  if (cheerfulScore >= 2) return 'cheerful'
  if (warmScore >= 2) return 'warm'

  if (normalized.includes('?')) return 'calm'
  if (/\b(sorry|help|understand|together)\b/.test(normalized)) return 'warm'
  if (/(^|\s)!/.test(normalized) || normalized.endsWith('!')) return 'excited'

  return 'calm'
}

export function buildSpeechInstruction(
  speakingStyle: string | undefined,
  delivery: Exclude<SpeechDeliveryId, 'auto'> | string | undefined
): string | undefined {
  const style = String(speakingStyle || '').trim()
  const tone = String(delivery || '').trim().toLowerCase()

  const deliveryInstruction =
    tone === 'warm'
      ? 'Deliver it with warm reassurance and easy confidence.'
      : tone === 'calm'
        ? 'Deliver it with calm, steady pacing and a relaxed tone.'
        : tone === 'cheerful'
          ? 'Deliver it with bright, upbeat energy and friendly lift.'
          : tone === 'gentle'
            ? 'Deliver it with a gentle, soft, comforting tone.'
            : tone === 'serious'
              ? 'Deliver it with measured seriousness and clear focus.'
              : tone === 'dramatic'
                ? 'Deliver it with theatrical emphasis, tension, and dramatic pauses.'
                : tone === 'excited'
                  ? 'Deliver it with energetic excitement and animated momentum.'
                  : ''

  const pieces = [style, deliveryInstruction].filter(Boolean)
  return pieces.length > 0 ? pieces.join(' ') : undefined
}
