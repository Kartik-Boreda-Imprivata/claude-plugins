#!/usr/bin/env node
// Sums real token usage for one session by reading its transcript files
// directly (not through the mods API, which caps a single file read at
// 4 MiB). Usage: node tokens.mjs <sessionId> <cwd>
//
// Caches per-file running totals keyed by (size, mtimeMs), so a transcript
// that hasn't grown since the last run isn't re-parsed.

import { readFileSync, statSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function projectDir(cwd) {
  // Claude Code names a project's transcript directory after its cwd with
  // every non-alphanumeric character (not just '/') turned into '-'.
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function cachePath(sessionId) {
  const dir = join(homedir(), '.claude', 'plugins', 'store', 'usage-band', 'cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, sessionId + '.json')
}

function loadCache(sessionId) {
  try {
    return JSON.parse(readFileSync(cachePath(sessionId), 'utf8'))
  } catch {
    return { files: {} }
  }
}

function saveCache(sessionId, cache) {
  try {
    writeFileSync(cachePath(sessionId), JSON.stringify(cache))
  } catch {
    // best effort; a failed write just means next run recomputes this file
  }
}

// Dedupe by message id + requestId (the same message is rewritten once per
// content block as it streams in), taking the max of each usage field
// across duplicates.
function sumFile(path) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const seen = new Map()
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return totals
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type !== 'assistant' || !row.message?.usage) continue
    const key = (row.message.id ?? '') + '|' + (row.requestId ?? '')
    const usage = row.message.usage
    const prev = seen.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    seen.set(key, {
      input: Math.max(prev.input, usage.input_tokens ?? 0),
      output: Math.max(prev.output, usage.output_tokens ?? 0),
      cacheRead: Math.max(prev.cacheRead, usage.cache_read_input_tokens ?? 0),
      cacheWrite: Math.max(prev.cacheWrite, usage.cache_creation_input_tokens ?? 0),
    })
  }
  for (const v of seen.values()) {
    totals.input += v.input
    totals.output += v.output
    totals.cacheRead += v.cacheRead
    totals.cacheWrite += v.cacheWrite
  }
  return totals
}

function sumWithCache(path, cache) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
  const prior = cache.files[path]
  if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
    return prior.totals
  }
  const totals = sumFile(path)
  cache.files[path] = { size: stat.size, mtimeMs: stat.mtimeMs, totals }
  return totals
}

function main() {
  const [sessionId, cwd] = process.argv.slice(2)
  if (!sessionId || !cwd) {
    process.stdout.write(JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }))
    return
  }

  const dir = projectDir(cwd)
  const files = []
  const mainTranscript = join(dir, sessionId + '.jsonl')
  if (existsSync(mainTranscript)) files.push(mainTranscript)

  const subagentsDir = join(dir, sessionId, 'subagents')
  if (existsSync(subagentsDir)) {
    for (const name of readdirSync(subagentsDir)) {
      if (name.endsWith('.jsonl')) files.push(join(subagentsDir, name))
    }
  }

  const cache = loadCache(sessionId)
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const file of files) {
    const t = sumWithCache(file, cache)
    total.input += t.input
    total.output += t.output
    total.cacheRead += t.cacheRead
    total.cacheWrite += t.cacheWrite
  }
  saveCache(sessionId, cache)

  process.stdout.write(JSON.stringify(total))
}

main()
