import fs from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const args = new Map()
  for (let i = 2; i < argv.length; i += 1) {
    const raw = argv[i]
    if (!raw.startsWith('--')) continue
    const [key, maybeValue] = raw.split('=')
    if (maybeValue !== undefined) {
      args.set(key.slice(2), maybeValue)
      continue
    }
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args.set(key.slice(2), 'true')
      continue
    }
    args.set(key.slice(2), next)
    i += 1
  }
  return args
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(raw)
}

function joinUrl(base, pathname) {
  return base.replace(/\/$/, '') + pathname
}

function hasExtendedPictographic(text) {
  try {
    return /\p{Extended_Pictographic}/u.test(text)
  } catch {
    return false
  }
}

function validateReply(text, expect) {
  const failures = []
  for (const pattern of expect.mustMatch || []) {
    const re = new RegExp(pattern, 'i')
    if (!re.test(text)) failures.push(`missing mustMatch: /${pattern}/i`)
  }
  for (const pattern of expect.mustNotMatch || []) {
    const re = new RegExp(pattern, 'i')
    if (re.test(text)) failures.push(`hit mustNotMatch: /${pattern}/i`)
  }
  if (expect.mustNotHaveEmoji && hasExtendedPictographic(text)) {
    failures.push('hit mustNotHaveEmoji')
  }
  return failures
}

async function chatJson({ baseUrl, model, messages, sessionId, think, debug }) {
  const res = await fetch(joinUrl(baseUrl, '/api/ollama/chat'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      sessionId: sessionId ?? undefined,
      think: think ?? undefined,
      debug: debug ?? undefined,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText} :: ${body.slice(0, 300)}`)
  }
  return await res.json()
}

async function chatStream({ baseUrl, model, messages, sessionId, think, debug }) {
  const res = await fetch(joinUrl(baseUrl, '/api/ollama/chat'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      sessionId: sessionId ?? undefined,
      think: think ?? undefined,
      debug: debug ?? undefined,
    }),
  })
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText} :: ${body.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      const chunk = parsed?.message?.content
      if (typeof chunk === 'string') content += chunk
      if (parsed?.done === true) return content
    }
  }
  return content
}

async function runCase({ baseUrl, model, personaSystemMessage, seed, turns, expect, mode, sessionId, think, debug }) {
  const messages = []
  if (personaSystemMessage) messages.push({ role: 'system', content: personaSystemMessage })
  if (Array.isArray(seed)) {
    for (const msg of seed) {
      if (!msg?.role || typeof msg.content !== 'string') continue
      if (msg.role !== 'system' && msg.role !== 'user' && msg.role !== 'assistant') continue
      messages.push({ role: msg.role, content: msg.content })
    }
  }
  let lastAssistant = ''
  for (const userText of turns) {
    messages.push({ role: 'user', content: userText })
    const reply =
      mode === 'stream'
        ? await chatStream({ baseUrl, model, messages, sessionId, think, debug })
        : (await chatJson({ baseUrl, model, messages, sessionId, think, debug }))?.message?.content || ''
    lastAssistant = typeof reply === 'string' ? reply : ''
    messages.push({ role: 'assistant', content: lastAssistant })
  }
  const failures = validateReply(lastAssistant, expect)
  return { reply: lastAssistant, failures }
}

const DEFAULT_PERSONAS = [
  {
    id: 'neutral',
    system: null,
  },
  {
    id: 'warm',
    system:
      "You are Quinn: warm, human, concise. Do not mention internal routing or metadata. Answer the user's question directly.",
  },
  {
    id: 'blunt',
    system:
      "You are Quinn: direct, no-nonsense, short answers. Do not mention internal routing or metadata. Do not add generic closers.",
  },
]

async function getSetting({ baseUrl, key }) {
  const url = joinUrl(baseUrl, `/api/system/settings?key=${encodeURIComponent(key)}`)
  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET ${key} failed: HTTP ${res.status} ${res.statusText} :: ${body.slice(0, 200)}`)
  }
  const json = await res.json()
  return json?.value
}

async function updateSetting({ baseUrl, key, value }) {
  const res = await fetch(joinUrl(baseUrl, '/api/system/settings'), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  })
  const raw = await res.text().catch(() => '')
  let json = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const msg = json?.message || raw.slice(0, 200)
    throw new Error(`PATCH ${key} failed: HTTP ${res.status} ${res.statusText} :: ${msg}`)
  }
  return json
}

async function main() {
  const args = parseArgs(process.argv)
  const baseUrl = args.get('baseUrl') || process.env.NOMAD_BASE_URL || 'http://localhost:8080'
  const casesPath =
    args.get('cases') ||
    path.join(process.cwd(), 'scripts', 'conversation_cases.json')

  const fixture = await readJson(casesPath)
  const model = args.get('model') || fixture?.meta?.defaultModel || 'qwen2.5:32b-instruct-q5_K_M'
  const only = args.get('only') || null
  const mode = args.get('mode') || 'both' // json|stream|both
  const sessionId = args.has('sessionId') ? Number(args.get('sessionId')) : null
  const think = args.has('think') ? args.get('think') === 'medium' ? 'medium' : args.get('think') === 'true' : undefined
  const debug = args.get('debug') === 'true'
  const personaMode = args.get('personaMode') || 'settings' // settings|inject

  const personas = DEFAULT_PERSONAS
  const selectedCases = Array.isArray(fixture?.cases) ? fixture.cases : []

  let restorePrompt = null
  let restoreName = null
  if (personaMode === 'settings') {
    restorePrompt = await getSetting({ baseUrl, key: 'ai.systemPrompt' })
    restoreName = await getSetting({ baseUrl, key: 'ai.assistantCustomName' })
    await updateSetting({ baseUrl, key: 'ai.assistantCustomName', value: 'Quinn' })
  }

  let failed = 0
  try {
    for (const persona of personas) {
      if (personaMode === 'settings') {
        if (persona.id === 'neutral') {
          await updateSetting({ baseUrl, key: 'ai.systemPrompt', value: restorePrompt ?? '' })
        } else if (persona.system) {
          await updateSetting({ baseUrl, key: 'ai.systemPrompt', value: persona.system })
        }
      }

      for (const testCase of selectedCases) {
        if (only && testCase.id !== only) continue
        const modes = mode === 'both' ? ['json', 'stream'] : [mode]
        for (const runMode of modes) {
          const result = await runCase({
            baseUrl,
            model,
            personaSystemMessage: personaMode === 'inject' ? persona.system : null,
            seed: Array.isArray(testCase.seed) ? testCase.seed : null,
            turns: testCase.turns,
            expect: testCase.expect,
            mode: runMode,
            sessionId: sessionId && Number.isFinite(sessionId) ? sessionId : undefined,
            think,
            debug: debug || undefined,
          })

          const label = `[${persona.id}/${runMode}] ${testCase.id}`
          if (result.failures.length > 0) {
            failed += 1
            console.log(`${label} FAIL`)
            for (const f of result.failures) console.log(`  - ${f}`)
            console.log(`  reply: ${JSON.stringify(result.reply)}`)
            console.log('')
          } else {
            console.log(`${label} OK`)
          }
        }
      }
    }
  } finally {
    if (personaMode === 'settings') {
      await updateSetting({ baseUrl, key: 'ai.systemPrompt', value: restorePrompt ?? '' }).catch(() => {})
      await updateSetting({ baseUrl, key: 'ai.assistantCustomName', value: restoreName ?? '' }).catch(() => {})
    }
  }

  if (failed > 0) {
    console.log(`\nFAILURES: ${failed}`)
    process.exitCode = 1
  } else {
    console.log('\nAll conversation cases passed.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
