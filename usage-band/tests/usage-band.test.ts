import { expect, test } from 'claude-code/testing'

test('/kb reports no data before any usage is known', async ($, on) => {
  on('session.usage', () => {
    throw new Error('no usage in this test')
  })
  const answer = await $.command.run({ command: 'kb', args: '' })
  expect(answer.text).toBe('no data yet. Finish a turn, then run /kb again.')
})

test('/kb shut hides the band, /kb shine brings it back', async ($, on) => {
  const shut = await $.command.run({ command: 'kb', args: 'shut' })
  expect(shut.text).toBe('hidden. Run /kb shine to bring it back.')
  const shine = await $.command.run({ command: 'kb', args: 'shine' })
  expect(shine.text).toBe('showing again.')
})

test('/kb ttl sets the cache lifetime and rejects other values', async ($) => {
  const ok = await $.command.run({ command: 'kb', args: 'ttl 1h' })
  expect(ok.text).toBe('cache TTL set to 1h.')
  const bad = await $.command.run({ command: 'kb', args: 'ttl 2h' })
  expect(bad.text).toBe('usage: /kb ttl 5m|1h')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band draws cache countdown and handoff button on ${surface}`, async ($, on) => {
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { tokens: 108_000, window: 1_000_000, percent: 11 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 9, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
        cost: { usd: 0.92 },
      },
    }))
    on('session.model', () => ({ value: 'us.anthropic.claude-sonnet-5-5' }))
    on('turn.complete', () => ({ text: '' }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
    await $.turn.complete({
      answer: '',
      durationMs: 1,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' },
    })
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: { hasSurvey: false } })
    expect(await ui.find({ type: 'Text', text: /cache warm/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /read ~\$0\.02 vs rewrite ~\$0\.27/ })).toBeDefined()
    expect(await ui.find({ key: 'handoff' })).toBeDefined()
    await ui.unmount()
  })
}
