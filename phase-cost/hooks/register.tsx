import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Ledger, Phase } from '../types'
import { PHASES, stepPhase } from './classify'

const PANE = 'phase-cost'
const empty = (): Ledger => ({ Planning: {}, Implementation: {}, Validation: {}, PR: {} })
const ledger = atom({ plugin: 'phase-cost', key: 'ledger' } as const, empty())
const phase = atom({ plugin: 'phase-cost', key: 'phase' } as const, 'Planning' as Phase)
const lastUsd = atom({ plugin: 'phase-cost', key: 'lastUsd' } as const, null as number | null)

// Mid-tone hex that reads on light and dark backgrounds.
const GREEN = '#43a047'
const AMBER = '#fb8c00'
const RED = '#e53935'
const TRACK = '#555555'
const COLOR: Record<Phase, string> = { Planning: '#5c9ded', Implementation: GREEN, Validation: AMBER, PR: '#ab47bc' }

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'phase-cost', description: 'Show cost and tool calls per work phase' })
    void $.ui.open({ id: PANE, title: 'Cost by phase' })
    return next(e)
  })

  on('command.run', { command: 'phase-cost' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Cost by phase' })
    return { text: 'Cost-by-phase pane opened.' }
  })

  on('turn.step', async function* ($, e, next) {
    // Baseline once; afterwards every dollar since the last step (subagents included) lands on the next one, so the total reconciles with /cost.
    if ((await read($, lastUsd)) === null) {
      const base = (await $.session.usage()).cost?.usd ?? 0
      await update($, lastUsd, () => base)
    }
    const r = yield* next(e)

    const now = (await $.session.usage()).cost?.usd ?? 0
    const delta = Math.max(0, now - ((await read($, lastUsd)) ?? now))
    await update($, lastUsd, () => now)

    const p = stepPhase(r.toolUses, await read($, phase))
    await update($, phase, () => p)
    const names = r.toolUses.length ? r.toolUses.map(u => u.name) : ['(reply)']
    await update($, ledger, l => {
      const out = { ...l, [p]: { ...l[p] } }
      for (const n of names) {
        const row = out[p][n] ?? { n: 0, usd: 0 }
        out[p][n] = { n: row.n + (n === '(reply)' ? 0 : 1), usd: row.usd + delta / names.length }
      }
      return out
    })
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const l = await read($, ledger)
    const sum = (p: Phase) => Object.values(l[p]).reduce((a, r) => ({ n: a.n + r.n, usd: a.usd + r.usd }), { n: 0, usd: 0 })
    const total = PHASES.reduce((a, p) => ({ n: a.n + sum(p).n, usd: a.usd + sum(p).usd }), { n: 0, usd: 0 })
    const max = Math.max(...PHASES.map(p => sum(p).usd), 0.000001)
    const now = await read($, phase)
    const biggest = PHASES.reduce((a, p) => (sum(p).usd > sum(a).usd ? p : a), PHASES[0])

    // No character padding and no fixed-width rules: columns are Boxes with a set width, the bars and the
    // divider take whatever room is left, so the pane reflows at any width and in any font.
    const rule = (
      <Box height={1} overflow="hidden">
        <Text dimColor wrap="truncate">{'─'.repeat(300)}</Text>
      </Box>
    )
    const bar = (share: number, color: string) => (
      <Box flexGrow={1} flexDirection="row" height={1}>
        {share > 0 && <Box flexGrow={share} backgroundColor={color} />}
        {share < 1 && <Box flexGrow={1 - share} backgroundColor={TRACK} />}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Cost by phase</Text>
          <Text bold color={total.usd >= 10 ? RED : total.usd >= 3 ? AMBER : GREEN}>{usd(total.usd)}</Text>
        </Box>
        {total.usd > 0 ? (
          <Box flexDirection="row" height={1}>
            {PHASES.map(p => sum(p).usd > 0 && <Box flexGrow={sum(p).usd} backgroundColor={COLOR[p]} />)}
          </Box>
        ) : (
          <Box height={1} backgroundColor={TRACK} />
        )}
        <Text> </Text>
        {PHASES.map(p => {
          const s = sum(p)
          const isNow = p === now
          const top = Object.entries(l[p]).sort((a, b) => b[1].usd - a[1].usd)[0]
          const pct = total.usd > 0 ? Math.round((s.usd / total.usd) * 100) : 0
          const hot = top && s.usd > 0 && top[1].usd / s.usd >= 0.6
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" columnGap={2} alignItems="center">
                <Box width={18} flexShrink={0}>
                  <Text color={COLOR[p]} bold wrap="truncate">{(isNow ? '• ' : '  ') + p}</Text>
                </Box>
                {bar(s.usd / max, COLOR[p])}
                <Box width={9} flexShrink={0} justifyContent="flex-end">
                  <Text bold={isNow}>{usd(s.usd)}</Text>
                </Box>
                <Box width={5} flexShrink={0} justifyContent="flex-end">
                  <Text color={pct >= 40 ? AMBER : undefined} dimColor={pct < 40}>{pct}%</Text>
                </Box>
              </Box>
              <Box flexDirection="row" columnGap={2} paddingLeft={2}>
                <Text dimColor>
                  {s.n} calls{top ? ' · ' : ''}
                  {top && <Text color={hot ? AMBER : undefined} dimColor={!hot}>{top[0]} {usd(top[1].usd)}{hot ? ` (${Math.round((top[1].usd / s.usd) * 100)}% of phase)` : ''}</Text>}
                </Text>
                {p === biggest && s.usd > 0 && <Text color={AMBER}>▲ top</Text>}
              </Box>
            </Box>
          )
        })}
        {rule}
        <Text dimColor>{total.n} calls · now: <Text color={COLOR[now]}>{now}</Text> · step cost split across its tools</Text>
      </Box>
    )
  })
}
