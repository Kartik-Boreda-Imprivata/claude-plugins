import { atom, read, update } from 'claude-code'

const shutState = atom({ plugin: 'usage-band', key: 'shut' }, false)
const usageState = atom({ plugin: 'usage-band', key: 'usage' }, null)
const fallbackTokensState = atom({ plugin: 'usage-band', key: 'fallbackTokens' }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const lastResponseState = atom({ plugin: 'usage-band', key: 'lastResponseAt' }, null)
const ttlState = atom({ plugin: 'usage-band', key: 'ttl' }, '5m')
const handoffState = atom({ plugin: 'usage-band', key: 'handoff' }, null)
const busyState = atom({ plugin: 'usage-band', key: 'handoffBusy' }, false)

const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const WARN_MS = 60_000 // flip warm -> amber this long before expiry
const BIG_CONTEXT = 100_000 // tokens at which a cold cache makes handoff worth suggesting
const HANDOFF_FILE = 'HANDOFF.md'

// ---------- formatting ----------

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(Math.round(n))
}

function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return '$0.00'
  return '$' + n.toFixed(2)
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm'
}

// '5h' windows render as '2h 40m', '7d' windows render as '1d 7h'
function fmtRemaining(ms, kind) {
  if (ms == null || !Number.isFinite(ms)) return '--'
  const clamped = Math.max(0, ms)
  if (kind === 'five_hour') {
    const h = Math.floor(clamped / 3_600_000)
    const m = Math.floor((clamped % 3_600_000) / 60_000)
    return h + 'h ' + m + 'm'
  }
  const d = Math.floor(clamped / 86_400_000)
  const h = Math.floor((clamped % 86_400_000) / 3_600_000)
  return d + 'd ' + h + 'h'
}

const GREEN = '#43a047'
const AMBER = '#fb8c00'
const RED = '#e53935'

// Raw hex: mid-tone shades that stay readable on light and dark backgrounds.
function levelColor(percentUsed) {
  if (percentUsed >= 90) return RED
  if (percentUsed >= 70) return AMBER
  return GREEN
}

// ---------- prompt cache ----------

// Base input $/MTok, Anthropic list price (cached 2026-09-25). Bedrock and
// managed pricing can differ, so the rewrite cost is an estimate.
function basePrice(model) {
  const m = (model || '').toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return 10
  if (m.includes('opus')) return /opus[-_.]?5[-_.]?5/.test(m) ? 4 : 5
  if (m.includes('sonnet')) return /sonnet[-_.]?4/.test(m) ? 3 : 2
  if (m.includes('haiku')) return 1
  return null
}

// Cache writes cost 1.25x base input for the 5m TTL, 2x for the 1h TTL.
function rewriteCost(tokens, model, ttl) {
  const base = basePrice(model)
  if (base == null || !tokens) return null
  return (tokens / 1_000_000) * base * (ttl === '1h' ? 2 : 1.25)
}

// A warm cache bills reads at 0.1x base input (0.05x Opus 5.5, 0.025x Fable/Mythos).
function readCost(tokens, model) {
  const base = basePrice(model)
  if (base == null || !tokens) return null
  const m = (model || '').toLowerCase()
  const mult = m.includes('fable') || m.includes('mythos') ? 0.025 : /opus[-_.]?5[-_.]?5/.test(m) ? 0.05 : 0.1
  return (tokens / 1_000_000) * base * mult
}

// state: unknown (no response seen yet) | warm | closing | expired
function cacheStatus(lastResponseAt, ttl, now) {
  if (lastResponseAt == null) return { state: 'unknown' }
  const remaining = TTL_MS[ttl] - (now - lastResponseAt)
  if (remaining <= 0) return { state: 'expired', ago: -remaining }
  return { state: remaining <= WARN_MS ? 'closing' : 'warm', remaining }
}

function cacheLabel(status) {
  if (status.state === 'unknown') return { color: undefined, dim: true, text: '○ cache --' }
  if (status.state === 'expired') return { color: RED, text: '● cache expired ' + fmtDuration(status.ago) + ' ago' }
  const text = '● cache warm ' + fmtDuration(status.remaining)
  return { color: status.state === 'closing' ? AMBER : GREEN, text }
}

// ---------- usage refresh ----------

// Runs scripts/tokens.mjs, which reads this session's transcript files
// directly (past $.fs.read's 4 MiB cap). All zeros means no transcript was
// found for this session id, so that counts as a miss and the caller falls back.
async function runTokenScript($, sessionId, cwd, pluginRoot) {
  const scriptPath = pluginRoot + '/scripts/tokens.mjs'
  for (const node of ['node', '/usr/local/bin/node', '/opt/homebrew/bin/node']) {
    try {
      const result = await $.process.run([node, scriptPath, sessionId, cwd], { timeoutMs: 10_000 })
      if (result.exitCode === 0 && result.stdout.trim()) {
        const p = JSON.parse(result.stdout.trim())
        const tokens = { input: p.input ?? 0, output: p.output ?? 0, cacheRead: p.cacheRead ?? 0, cacheWrite: p.cacheWrite ?? 0, approx: false }
        return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0 ? tokens : null
      }
    } catch {
      // try the next candidate path
    }
  }
  return null
}

// Subagents fire turn.complete / session.measure in bursts, and the token
// script is slow. Overlapping refreshes used to finish out of order, so an
// older cost snapshot could overwrite a newer one. Run one at a time and
// rerun once if events arrived meanwhile.
let refreshing = false
let refreshAgain = false
async function refreshUsage($) {
  if (refreshing) {
    refreshAgain = true
    return
  }
  refreshing = true
  try {
    do {
      refreshAgain = false
      await refreshUsageOnce($)
    } while (refreshAgain)
  } finally {
    refreshing = false
  }
}

async function refreshUsageOnce($) {
  let tokens = null
  try {
    tokens = await runTokenScript($, await $.session.id(), await $.session.cwd(), $.plugin.root)
  } catch {
    tokens = null
  }
  if (!tokens) tokens = { ...(await read($, fallbackTokensState)), approx: true }

  let model = null
  try {
    model = await $.session.model()
  } catch {
    model = null
  }

  // Read the ledger last so cost reflects everything billed while the slow work above ran.
  let usage
  try {
    usage = await $.session.usage()
  } catch {
    return
  }
  const rateLimits = usage.rateLimits ?? []
  const fiveHourRaw = rateLimits.find((r) => r.kind === 'five_hour')
  const sevenDayRaw = rateLimits.find((r) => r.kind === 'seven_day')

  await update($, usageState, () => ({
    fiveHour: fiveHourRaw ? { percentUsed: fiveHourRaw.percentUsed, resetsAt: fiveHourRaw.resetsAt } : null,
    sevenDay: sevenDayRaw ? { percentUsed: sevenDayRaw.percentUsed, resetsAt: sevenDayRaw.resetsAt } : null,
    costUsd: usage.cost?.usd ?? null,
    context: usage.context ? { tokens: usage.context.tokens ?? 0, window: usage.context.window, percent: usage.context.percent ?? 0 } : null,
    model,
    tokens,
  }))
}

// ---------- handoff ----------

function transcriptText(messages) {
  const lines = []
  for (const m of messages) {
    let text = (m.text || '').trim()
    if (text.length > 1500) text = text.slice(0, 1500) + ' ...'
    const tools = (m.toolUses || [])
      .map((u) => u.tool + (u.input?.file_path ? ' ' + u.input.file_path : u.input?.command ? ' ' + String(u.input.command).slice(0, 80) : ''))
      .join('; ')
    if (!text && !tools) continue
    lines.push((m.role === 'user' ? 'USER: ' : 'ASSISTANT: ') + text + (tools ? ' [tools: ' + tools + ']' : ''))
  }
  const out = lines.join('\n')
  return out.length > 90_000 ? out.slice(out.length - 90_000) : out // keep the recent end
}

const HANDOFF_SYSTEM =
  'You write handoff notes so a fresh coding-assistant session can continue work with no memory of this one. ' +
  'Be concrete: name files, commands, and decisions. Reply with a single JSON object and nothing else.'

function handoffPrompt(transcript) {
  return (
    'Summarize this session for a handoff. Return JSON with exactly these keys:\n' +
    '{"summary": "2-3 sentences: the goal and where things stand",\n' +
    ' "done": ["what was completed"],\n' +
    ' "decisions": ["decision and the reason for it"],\n' +
    ' "next": ["ordered, actionable next steps, most important first, at most 6"],\n' +
    ' "open": ["unresolved problems, blockers or questions"],\n' +
    ' "files": ["files created or changed"]}\n\n' +
    'SESSION TRANSCRIPT (oldest first):\n' +
    transcript
  )
}

function parseJsonLoose(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function list(items) {
  const arr = Array.isArray(items) ? items.filter((x) => typeof x === 'string' && x.trim()) : []
  return arr.length ? arr.map((x) => '- ' + x.trim()).join('\n') : '- (none)'
}

function handoffMarkdown(data, whenIso) {
  const next = Array.isArray(data.next) ? data.next.filter((x) => typeof x === 'string' && x.trim()) : []
  return (
    '# Handoff - ' + whenIso + '\n\n' +
    '## Summary\n' + (data.summary || '(no summary)') + '\n\n' +
    '## Done\n' + list(data.done) + '\n\n' +
    '## Decisions\n' + list(data.decisions) + '\n\n' +
    '## Next steps\n' + (next.length ? next.map((x, i) => i + 1 + '. ' + x.trim()).join('\n') : '1. (none recorded)') + '\n\n' +
    '## Open questions\n' + list(data.open) + '\n\n' +
    '## Files touched\n' + list(data.files) + '\n'
  )
}

function parseHandoff(md) {
  const section = (title) => {
    const m = md.match(new RegExp('^## ' + title + '\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))', 'm'))
    return m ? m[1].trim() : ''
  }
  const next = section('Next steps')
    .split('\n')
    .map((l) => l.match(/^\s*\d+\.\s+(.*\S)/))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((s) => s !== '(none recorded)')
  return { summary: section('Summary').split('\n')[0] || '', next }
}

async function loadHandoff($) {
  try {
    const path = (await $.session.cwd()) + '/' + HANDOFF_FILE
    if (!(await $.fs.exists(path))) return
    const stat = await $.fs.stat(path)
    const prior = await read($, handoffState)
    if (prior && prior.savedAt === stat.mtimeMs) return // already loaded (keeps a dismissal)
    const parsed = parseHandoff(await $.fs.read(path))
    await update($, handoffState, () => ({ savedAt: stat.mtimeMs, path, summary: parsed.summary, next: parsed.next, dismissed: false }))
  } catch {
    // no readable handoff file; the band just shows nothing for it
  }
}

// Returns { ok, text } and never throws; the band and /handoff both call it.
async function runHandoff($) {
  if (await read($, busyState)) return { ok: false, text: 'a handoff is already being written.' }
  await update($, busyState, () => true)
  try {
    const messages = await $.session.messages()
    if (!messages.length) return { ok: false, text: 'nothing to hand off yet.' }
    const reply = await $.model.complete({
      model: 'haiku',
      system: HANDOFF_SYSTEM,
      prompt: handoffPrompt(transcriptText(messages)),
      maxTokens: 2500,
      effort: 'low',
      timeoutMs: 120_000,
    })
    if (!reply.isAnswered) return { ok: false, text: 'could not summarize the session (' + reply.reason + ').' }

    const data = parseJsonLoose(reply.text) ?? { summary: reply.text.trim().slice(0, 600), next: [] }
    const now = Date.now()
    const markdown = handoffMarkdown(data, new Date(now).toISOString())
    const cwd = await $.session.cwd()
    const path = cwd + '/' + HANDOFF_FILE
    await $.fs.write(path, markdown)

    // Timestamped archive copy in the home folder, best effort.
    const home = cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/)?.[1]
    if (home) {
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
      const project = cwd.split('/').filter(Boolean).pop() || 'session'
      try {
        await $.fs.write(home + '/.claude/handoffs/' + stamp + '-' + project + '.md', markdown)
      } catch {
        // the project copy is the one that matters
      }
    }

    const parsed = parseHandoff(markdown)
    await update($, handoffState, () => ({ savedAt: now, path, summary: parsed.summary, next: parsed.next, dismissed: false }))
    $.ui.toast('Handoff saved to ' + HANDOFF_FILE)
    return { ok: true, text: 'saved ' + path + ' (' + parsed.next.length + ' next steps).' }
  } catch (err) {
    return { ok: false, text: 'handoff failed: ' + (err && err.message ? err.message : String(err)) }
  } finally {
    await update($, busyState, () => false)
  }
}

// ---------- band ----------

function buildBand($, e, ctx) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const { usage, status, ttl, handoff, busy } = ctx
  const cells = []

  const label = cacheLabel(status)
  cells.push(Text({ color: label.color, dimColor: label.dim, bold: status.state === 'expired', children: [label.text] }))

  const ctxTokens = usage?.context?.tokens
  if (ctxTokens) cells.push(Text({ dimColor: true, children: ['ctx ' + fmtNum(ctxTokens)] }))

  const rewrite = rewriteCost(ctxTokens, usage?.model, ttl)
  const read = readCost(ctxTokens, usage?.model)
  if (rewrite != null && read != null) {
    cells.push(
      status.state === 'expired'
        ? Text({ color: RED, children: ['next prompt re-caches ~' + fmtMoney(rewrite) + ' (warm read ~' + fmtMoney(read) + ')'] })
        : Text({ dimColor: true, children: ['read ~' + fmtMoney(read) + ' vs rewrite ~' + fmtMoney(rewrite)] }),
    )
  }

  if (usage?.fiveHour || usage?.sevenDay) {
    const bits = []
    if (usage.fiveHour) bits.push(Text({ color: levelColor(usage.fiveHour.percentUsed), children: ['5h ' + Math.round(usage.fiveHour.percentUsed) + '%'] }))
    if (usage.fiveHour && usage.sevenDay) bits.push(Text({ dimColor: true, children: ['.'] }))
    if (usage.sevenDay) bits.push(Text({ color: levelColor(usage.sevenDay.percentUsed), children: ['week ' + Math.round(usage.sevenDay.percentUsed) + '%'] }))
    cells.push(Box({ flexDirection: 'row', columnGap: 1, children: bits }))
  }

  if (usage?.costUsd != null) cells.push(Text({ dimColor: true, children: ['session ' + fmtMoney(usage.costUsd)] }))

  if (usage?.tokens) {
    const t = usage.tokens
    const a = t.approx ? '~' : ''
    cells.push(Text({ dimColor: true, children: ['in ' + a + fmtNum(t.input) + '  out ' + a + fmtNum(t.output) + '  cached ' + a + fmtNum(t.cacheRead)] }))
  }

  const withSeps = []
  cells.forEach((c, i) => {
    if (i > 0) withSeps.push(Text({ dimColor: true, children: ['|'] }))
    withSeps.push(c)
  })

  const isColdAndBig = status.state === 'expired' && (ctxTokens ?? 0) >= BIG_CONTEXT
  const handoffControl = busy
    ? Text({ dimColor: true, children: ['writing handoff...'] })
    : Button({ key: 'handoff', label: 'handoff', hotkey: 'h', variant: isColdAndBig ? 'primary' : 'secondary', onPress: () => runHandoff($) })

  const rows = [
    Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      columnGap: 2,
      children: [Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: withSeps }), handoffControl],
    }),
  ]

  if (handoff && !handoff.dismissed) {
    const age = fmtDuration(Date.now() - handoff.savedAt)
    rows.push(Text({ dimColor: true, children: ['handoff from ' + age + ' ago' + (handoff.summary ? ': ' + handoff.summary : '')] }))
    if (handoff.next.length) {
      rows.push(Text({ dimColor: true, children: ['next:'] }))
      handoff.next.slice(0, 3).forEach((step, i) => {
        rows.push(
          Button({
            key: 'next' + (i + 1),
            label: step,
            hotkey: String(i + 1),
            plain: true,
            onPress: async () => {
              await $.prompt.submit({ text: 'Continue from ' + HANDOFF_FILE + '. Next step: ' + step })
              await update($, handoffState, (h) => (h ? { ...h, dismissed: true } : h))
            },
          }),
        )
      })
    }
    rows.push(
      Button({ key: 'dismiss', label: 'dismiss', hotkey: '0', plain: true, onPress: () => update($, handoffState, (h) => (h ? { ...h, dismissed: true } : h)) }),
    )
  }

  return Box({ flexDirection: 'column', children: rows })
}

function summarize(usage, status, ttl) {
  if (!usage) return 'no data yet. Finish a turn, then run /kb again.'
  const bits = []
  if (status.state === 'expired') bits.push('cache expired ' + fmtDuration(status.ago) + ' ago')
  else if (status.state === 'unknown') bits.push('cache --')
  else bits.push('cache warm ' + fmtDuration(status.remaining))
  bits.push('ttl ' + ttl)
  if (usage.context?.tokens) {
    bits.push('ctx ' + fmtNum(usage.context.tokens))
    const rewrite = rewriteCost(usage.context.tokens, usage.model, ttl)
    const read = readCost(usage.context.tokens, usage.model)
    if (rewrite != null && read != null) bits.push('read ~' + fmtMoney(read) + ' vs rewrite ~' + fmtMoney(rewrite))
  }
  for (const [label, kind, data] of [['5h', 'five_hour', usage.fiveHour], ['7d', 'seven_day', usage.sevenDay]]) {
    if (!data) continue
    bits.push(label + ' ' + Math.round(data.percentUsed) + '%' + (data.resetsAt ? ' (reset ' + fmtRemaining(new Date(data.resetsAt).getTime() - Date.now(), kind) + ')' : ''))
  }
  if (usage.costUsd != null) bits.push(fmtMoney(usage.costUsd))
  return bits.join(' · ')
}

// ---------- hooks ----------

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'kb',
      description: 'Refresh and summarize the band; "shut"/"shine" hide/show it; "ttl 5m|1h" sets the cache lifetime',
      argumentHint: '[shut|shine|ttl 5m|ttl 1h]',
    })
    await $.command.register({ name: 'handoff', description: 'Summarize this session and what is next into HANDOFF.md for the next session' })
    $.clock.every(5_000, () => $.ui.invalidate('ui.render')) // keeps the cache countdown moving
    await refreshUsage($)
    await loadHandoff($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refreshUsage($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.usage) {
      await update($, fallbackTokensState, (prev) => ({
        input: prev.input + (e.usage.input_tokens ?? 0),
        output: prev.output + (e.usage.output_tokens ?? 0),
        cacheRead: prev.cacheRead + (e.usage.cache_read_input_tokens ?? 0),
        cacheWrite: prev.cacheWrite + (e.usage.cache_creation_input_tokens ?? 0),
      }))
      // A main-loop response refreshes the prompt cache; a subagent has its own.
      if (!e.agentId) {
        const now = Date.now()
        await update($, lastResponseState, () => now)
      }
      await refreshUsage($)
    }
    return next(e)
  })

  on('command.run', { command: 'kb' }, async ($, e) => {
    const [cmd, arg] = (e.args || '').trim().toLowerCase().split(/\s+/)
    if (cmd === 'shut') {
      await update($, shutState, () => true)
      return { text: 'hidden. Run /kb shine to bring it back.' }
    }
    if (cmd === 'shine') {
      await update($, shutState, () => false)
      await refreshUsage($)
      return { text: 'showing again.' }
    }
    if (cmd === 'ttl') {
      if (arg !== '5m' && arg !== '1h') return { text: 'usage: /kb ttl 5m|1h' }
      await update($, ttlState, () => arg)
      return { text: 'cache TTL set to ' + arg + '.' }
    }
    await refreshUsage($)
    const usage = await read($, usageState)
    const ttl = await read($, ttlState)
    const status = cacheStatus(await read($, lastResponseState), ttl, Date.now())
    return { text: summarize(usage, status, ttl) }
  })

  on('command.run', { command: 'handoff' }, async ($) => {
    const result = await runHandoff($)
    return { text: result.text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey is using the band; pull back so it isn't crowded out
    if (e.props.hasSurvey) return next(e)
    const shut = await read($, shutState)
    const usage = await read($, usageState)
    if (shut || !usage) return next(e)

    const ttl = await read($, ttlState)
    const ctx = {
      usage,
      ttl,
      status: cacheStatus(await read($, lastResponseState), ttl, Date.now()),
      handoff: await read($, handoffState),
      busy: await read($, busyState),
    }
    const theirs = await next(e)
    const { Box } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [theirs, buildBand($, e, ctx)] })
  })
}
