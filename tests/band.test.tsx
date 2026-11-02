import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'agent-info',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const CHIP = {
  plugin: 'agent-info',
  component: 'SessionMode',
  requestId: 'session-mode',
  props: { modes: ['focus'] },
} as const

// The one line's words: a Text on the terminal, the picture's alt on the
// desktop, which draws the whole line as one image.
async function lineOf(ui: { find: (q: { type?: string; text?: RegExp }) => Promise<{ text: string; props: Record<string, unknown> } | undefined> }, text: RegExp) {
  const svg = await ui.find({ type: 'Svg' })
  const alt = svg ? String(svg.props.alt ?? '') : ''
  if (text.test(alt)) return alt
  return (await ui.find({ type: 'Text', text }))?.text
}

// The engine beneath the plugin: an in-memory store, a fixed clock, a session
// that has cost $1.50 so far.
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const mem = new Map<string, unknown>()
  on('command.register', () => ({ value: { command: 'agent-info' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 5, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 1.5 } },
  }))
  on('store.get', (_, e) => ({ value: mem.get(e.key) }))
  on('store.set', (_, e) => {
    mem.set(e.key, e.value)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: 1_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({ text: '' }))
  return mem
}

test('a spawned worker shows on one line; expanding lists it with its tools', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Find the auth code', description: 'Find auth code', subagentType: 'Explore' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await lineOf(ui, /0\/1/))).toContain('0/1')
    expect(await ui.find({ type: 'Text', text: /Find auth code/ })).toBeUndefined()
    await ui.press({ key: 'size' })
    expect((await ui.find({ type: 'Text', text: /Find auth code/ }))?.text).toContain('1 tools')
    await ui.press({ key: 'size' })
    await ui.unmount()
  }
})

test('the plan shows its count, and its current step when expanded', async ($, on) => {
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read', status: 'completed', activeForm: 'Reading' },
      { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
    ],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await lineOf(ui, /1\/2/))).toContain('steps done')
  await ui.press({ key: 'size' })
  expect((await ui.find({ type: 'Text', text: /Plan 1\/2/ }))?.text).toContain('Write')
  await ui.unmount()
})

test('a finished batch is saved, stays on the bar and is listed by history', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Find it', description: 'Find auth code', subagentType: 'Explore' })
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1' } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await lineOf(ui, /1\/1/))).toContain('1/1')
  expect((await lineOf(ui, /session \$1\.50/))).toContain('session $1.50')
  await ui.unmount()

  const out = await $.command.run({ command: 'agent-info', args: 'history' })
  expect(String((out as { text?: string }).text)).toContain('1 worker')
  expect(String((out as { text?: string }).text)).toContain('Find auth code')
})

test('minimize folds the bar into the footer chip, and the chip opens it again', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    await band.press({ key: 'minimize' })
    expect((await band.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await band.unmount()

    const chip = await $.ui.mount({ ...CHIP, surface })
    expect((await chip.find({ type: 'Text', text: /focus/ }))?.text).toBe('focus')
    expect((await chip.find({ type: 'Text', text: /agents/ }))?.text).toContain('agents')
    await chip.press({ key: 'expand' })
    expect((await chip.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await chip.unmount()
  }
})

test('/agent-info brings the bar back from the chip and prints the status', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'Find it', description: 'Find auth code', subagentType: 'Explore' })
  await $.command.run({ command: 'agent-info', args: 'mini' })

  const out = await $.command.run({ command: 'agent-info', args: '' })
  const text = String((out as { text?: string }).text)
  expect(text).toContain('0/1 subagents done')
  expect(text).toContain('session $1.50')
  expect(text).toContain('Bar shown')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await lineOf(ui, /0\/1/))).toContain('0/1')
  await ui.unmount()
})

test('workers started together after a finished batch share one new batch', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++n}` }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'one', description: 'first run', subagentType: 'Explore' })
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1' } as never)
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Plan', status: 'in_progress', activeForm: 'Planning' }] })

  await Promise.all(
    ['scout', 'indexer', 'builder', 'tester', 'reviewer'].map(d =>
      $.agent.spawn({ prompt: d, description: d, subagentType: 'general-purpose' }),
    ),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await lineOf(ui, /0\/5/)).toContain('0/5')
    await ui.unmount()
  }
})

// The mocked clock reads 1000 ms; its month, and the one before, in local time.
const keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
const NOW_MONTH = keyOf(new Date(1_000))
const PREV_MONTH = keyOf(new Date(new Date(1_000).getFullYear(), new Date(1_000).getMonth() - 1, 15))

const SCAN = {
  sessions: [
    { id: 'me', title: 'This one', cwd: '/x/repo/.claude/worktrees/w1', first: 1, last: 990, mtime: 995, usd: 3, sinceUsd: 3, replies: 9, unpriced: 0, model: 'claude-opus-5-5', forkOf: null, months: { [NOW_MONTH]: 3 } },
    { id: 'p1', title: 'Parent work', cwd: '/x/app', first: 1, last: -9e6, mtime: -9e6, usd: 40, sinceUsd: 0, replies: 90, unpriced: 0, model: 'claude-opus-5-5', forkOf: null, months: { [PREV_MONTH]: 30, [NOW_MONTH]: 10 } },
    { id: 'f1', title: 'Forked work', cwd: '/x/app', first: 1, last: -8e6, mtime: -8e6, usd: 2.5, sinceUsd: 0, replies: 9, unpriced: 0, model: 'claude-opus-5-5', forkOf: 'p1', months: { [PREV_MONTH]: 2.5 } },
  ],
  totalUsd: 45.5,
  sinceUsd: 3,
  since: 0,
  months: { [NOW_MONTH]: 13, [PREV_MONTH]: 32.5 },
  files: 3,
  readBytes: 0,
  ms: 5,
}

test('the sessions pane lists every session with its cost, forks counted from the split', async ($, on) => {
  engine(on)
  const argvs: string[][] = []
  on('session.id', () => ({ value: 'me' }))
  on('process.run', (_, e) => {
    argvs.push([...e.argv])
    const since = Number(e.argv[e.argv.length - 1])
    return { value: { exitCode: 0, stdout: JSON.stringify({ ...SCAN, since, totalUsd: SCAN.totalUsd }), stderr: '' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'agent-info', args: 'sessions' })
  expect(String((out as { text?: string }).text)).toContain('$13.0 this month, $45.5 all time')
  expect(String((out as { text?: string }).text)).toContain('Sessions pane opened')
  expect(argvs[0]?.[2]).toContain('scripts/scan.py')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-info',
      component: 'Pane',
      requestId: 'agent-info-sessions',
      surface,
      props: { title: 'Sessions', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    // The desktop draws the totals as a card; its alt carries the figures.
    expect(await lineOf(ui, /all time \$45\.5|^\$45\.5$/i)).toMatch(/45\.5/)
    // This session shows the engine's ledger, $1.50 in the mocked engine.
    expect((await ui.find({ type: 'Text', text: /\$1\.50/ }))?.text).toContain('$1.50')
    expect(await lineOf(ui, /This month/)).toMatch(/This month/)
    expect(await lineOf(ui, /\$13\.0/)).toContain('$13.0')
    // An older month starts shut; opening it lists its sessions with that month's cost.
    expect(await ui.find({ type: 'Text', text: /fork of Parent work/ })).toBeUndefined()
    await ui.press({ key: `month-${PREV_MONTH}` })
    expect((await ui.find({ type: 'Text', text: /fork of Parent work/ }))?.text).toContain('· fork of Parent work')
    expect((await ui.find({ type: 'Text', text: /\$40\.0 in all/ }))?.text).toContain('$40.0 in all')
    await ui.press({ key: `month-${PREV_MONTH}` })
    expect((await ui.find({ type: 'Text', text: /Running now/ }))?.text).toBe('Running now')
    expect((await ui.find({ type: 'Text', text: /By month/ }))?.text).toBe('By month')
    await ui.unmount()
  }
})

test('in a narrow band the line shrinks to fit and the rows drop their details', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `w${++n}` }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const d of ['Design the profile sheet', 'Build missing pieces', 'Device check', 'Profile open', 'Fix check', 'Richer profile']) {
    await $.agent.spawn({ prompt: d, description: d, subagentType: 'general-purpose' })
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 70 } })
  await ui.press({ key: 'size' })
  const svg = await ui.find({ type: 'Svg' })
  expect(Number(String(svg?.props.source).match(/width="(\d+)"/)?.[1])).toBeLessThanOrEqual((70 - 20) * 7)
  expect(String(svg?.props.alt)).toContain('0/6 done')
  const row = await ui.find({ type: 'Text', text: /Richer profile/ })
  expect(row?.text).not.toContain('general-purpose')
  expect(row?.text).not.toContain('tools')
  expect(await ui.find({ type: 'Button', key: 'minimize' })).toBeDefined()
  await ui.press({ key: 'size' })
  await ui.unmount()
})
