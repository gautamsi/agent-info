import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Plan, Run, SessionRow, SessionScan, Worker, WorkerStatus } from '../types'

const isOn = atom({ plugin: 'agent-info', key: 'isOn' } as const, false)
const isMini = atom({ plugin: 'agent-info', key: 'isMini' } as const, false)
const isExpanded = atom({ plugin: 'agent-info', key: 'isExpanded' } as const, false)
const workers = atom({ plugin: 'agent-info', key: 'workers' } as const, {})
const plan = atom({ plugin: 'agent-info', key: 'plan' } as const, null)
const sessionUsd = atom({ plugin: 'agent-info', key: 'sessionUsd' } as const, null)
const sessionKey = atom({ plugin: 'agent-info', key: 'sessionKey' } as const, 0)
const mainUsd = atom({ plugin: 'agent-info', key: 'mainUsd' } as const, 0)
const now = atom({ plugin: 'agent-info', key: 'now' } as const, 0)
const batch = atom({ plugin: 'agent-info', key: 'batch' } as const, 0)
const lastRun = atom({ plugin: 'agent-info', key: 'lastRun' } as const, null)
const scan = atom({ plugin: 'agent-info', key: 'scan' } as const, null)
const isScanning = atom({ plugin: 'agent-info', key: 'isScanning' } as const, false)
const scanError = atom({ plugin: 'agent-info', key: 'scanError' } as const, '')
const isPaneOpen = atom({ plugin: 'agent-info', key: 'isPaneOpen' } as const, false)
const myId = atom({ plugin: 'agent-info', key: 'myId' } as const, '')
// Months whose list is toggled from its default (this month open, others shut).
const monthToggles = atom({ plugin: 'agent-info', key: 'monthToggles' } as const, [])

const AUTO_KEY = 'autoShow'
const COMPACT_KEY = 'compact'
const EXPANDED_KEY = 'expanded'
const OFF_KEY = 'off'
const HISTORY_KEY = 'history'
const HISTORY_MAX = 50
const SINCE_KEY = 'sessionsSince'

// The sessions pane: every session saved on this machine, priced from its
// transcript by scripts/scan.py.
const PANE = 'agent-info-sessions'
// A session whose transcript changed this recently counts as running.
const ACTIVE_MS = 3 * 60_000

// List prices in USD per million tokens: input, output, cache read.
// Cache writes are billed at 1.25x input. First match on the model id wins.
const PRICES: [string, number, number, number][] = [
  ['fable-5', 10, 50, 0.25],
  ['mythos-5', 10, 50, 0.25],
  ['opus-5-5', 4, 20, 0.2],
  ['opus-5', 5, 25, 0.5],
  ['opus-4', 5, 25, 0.5],
  ['sonnet-5', 2, 10, 0.2],
  ['sonnet-4', 3, 15, 0.3],
  ['haiku-5', 0.1, 0.5, 0.01],
  ['haiku-4', 1, 5, 0.1],
]

function priceOf(usage: ModelUsage & { model?: string }, fallbackModel: string) {
  const model = (usage.model || fallbackModel || '').toLowerCase()
  const row = PRICES.find(([key]) => model.includes(key))
  if (!row) return { usd: 0, isPriced: false }
  const [, input, output, cacheRead] = row
  const usd =
    (usage.input_tokens * input +
      usage.output_tokens * output +
      usage.cache_read_input_tokens * cacheRead +
      usage.cache_creation_input_tokens * input * 1.25) /
    1_000_000
  return { usd, isPriced: true }
}

function statusOf(status: AgentStatus): WorkerStatus {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'stopped'
  if (status === 'waiting' || status === 'idle') return 'waiting'
  return 'running'
}

function isLive(w: { status: WorkerStatus }) {
  return w.status === 'running' || w.status === 'waiting'
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { type?: string; text?: unknown; content?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      if (b.type === 'tool_result') return textOf(b.content)
      return ''
    })
    .join('\n')
}

function money(usd: number) {
  if (usd < 0.01) return `$${usd.toFixed(3)}`
  if (usd < 10) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(1)}`
}

// The pane's figures: cents below $10, whole dollars from $100, with commas.
function dollars(usd: number) {
  if (usd < 100) return money(usd)
  return `$${Math.round(usd).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

function dayOf(ms: number) {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function agoOf(ms: number) {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function monthKey(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthName(key: string) {
  const [year, month] = key.split('-')
  return MONTH_NAMES[Number(month) - 1] ? `${MONTH_NAMES[Number(month) - 1]} ${year}` : key
}

function projectOf(cwd: string) {
  const parts = cwd.split('/').filter(Boolean)
  const tree = parts.indexOf('worktrees')
  // A worktree under <repo>/.claude/worktrees/<name>: the repo's name.
  if (tree >= 2 && parts[tree - 1] === '.claude') return parts[tree - 2] ?? ''
  return parts[parts.length - 1] ?? ''
}

function clockOf(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function dateOf(ms: number) {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`
}

function cut(text: string, room: number) {
  if (room <= 1) return ''
  return text.length > room ? `${text.slice(0, room - 1)}…` : text
}

function bar(done: number, total: number, width: number) {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

function applyPlan(prev: Plan | null, tool: string, args: Record<string, unknown>): Plan | null {
  if (tool === 'TodoWrite') {
    const todos = args.todos as { content?: string; status?: string }[] | undefined
    if (!Array.isArray(todos)) return prev
    return { items: todos.map(t => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') })) }
  }
  if (tool === 'mcp__ccd_turn__wrap_up') {
    if (!prev) return prev
    return { items: prev.items.map(i => ({ ...i, status: 'completed' })) }
  }
  const items = args.items as { content?: string; status?: string }[] | undefined
  if (Array.isArray(items)) {
    return { items: items.map(i => ({ content: String(i.content ?? ''), status: String(i.status ?? 'pending') })) }
  }
  if (!prev) return prev
  const next = prev.items.map(i => ({ ...i }))
  const set = (index: number, status: string) => {
    const item = next[index]
    if (item) item.status = status
  }
  if (args.advance === true) {
    set(next.findIndex(i => i.status === 'in_progress'), 'completed')
    set(next.findIndex(i => i.status === 'pending'), 'in_progress')
  }
  if (Array.isArray(args.done)) {
    for (const n of args.done as number[]) set(n - 1, 'completed')
  }
  if (typeof args.start === 'number' && next[args.start - 1]) {
    next.forEach(i => {
      if (i.status === 'in_progress') i.status = 'pending'
    })
    set(args.start - 1, 'in_progress')
  }
  return { items: next }
}

const PLAN_TOOLS = new Set(['TodoWrite', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up'])

function batchOf(w: Worker) {
  return w.batch ?? 0
}

// The newest batch is the highest number any worker carries, read from the
// workers themselves so it can never run ahead of them.
function topBatch(all: Record<string, Worker>) {
  return Object.values(all).reduce((top, w) => Math.max(top, batchOf(w)), 0)
}

// The batch a new worker joins: the newest, or a new one once every worker
// in the newest has finished.
function batchFor(all: Record<string, Worker>) {
  const top = topBatch(all)
  const members = Object.values(all).filter(w => batchOf(w) === top)
  return members.length > 0 && !members.some(isLive) ? top + 1 : top
}

async function patch($: EngineInterface, id: string, fn: (w: Worker) => Worker) {
  await update($, workers, all => (all[id] ? { ...all, [id]: fn(all[id]) } : all))
}

async function autoShow($: EngineInterface) {
  const auto = await $.store.get(AUTO_KEY)
  if (auto === false) return
  await update($, isOn, () => true)
  if ((await $.store.get(COMPACT_KEY)) !== true) await update($, isMini, () => false)
}

async function setMini($: EngineInterface, mini: boolean) {
  await update($, isMini, () => mini)
  await $.store.set(COMPACT_KEY, mini)
  if (!mini) await update($, now, () => Date.now())
}

async function setExpanded($: EngineInterface, expanded: boolean) {
  await update($, isExpanded, () => expanded)
  await $.store.set(EXPANDED_KEY, expanded)
}

// Saves a batch (the newest unless named) to the history once none of it
// is running.
async function saveRun($: EngineInterface, which?: number) {
  const all = await read($, workers)
  const current = which ?? topBatch(all)
  const members = Object.values(all).filter(w => batchOf(w) === current)
  if (members.length === 0 || members.some(isLive)) return
  const run: Run = {
    id: `${await read($, sessionKey)}-${current}`,
    startedAt: Math.min(...members.map(w => w.startedAt)),
    endedAt: Math.max(...members.map(w => w.endedAt ?? w.startedAt)),
    workers: members.length,
    done: members.filter(w => w.status === 'done').length,
    failed: members.filter(w => w.status !== 'done').length,
    workersUsd: members.reduce((sum, w) => sum + w.usd, 0),
    sessionUsd: await read($, sessionUsd),
    labels: members.slice(0, 6).map(w => w.label),
  }
  const stored = await $.store.get(HISTORY_KEY)
  const history = Array.isArray(stored) ? (stored as Run[]) : []
  await $.store.set(HISTORY_KEY, [run, ...history.filter(r => r.id !== run.id)].slice(0, HISTORY_MAX))
  await update($, lastRun, () => run)
}

// Adds or refreshes a worker. The batch is chosen inside the one update of
// the workers, so workers started together (parallel Agent calls) share a
// batch instead of each opening its own.
async function addWorker($: EngineInterface, fresh: Omit<Worker, 'batch'>, keep: (old: Worker) => Partial<Worker>) {
  let before = 0
  let joined = 0
  await update($, workers, (all): Record<string, Worker> => {
    before = topBatch(all)
    const old = all[fresh.id]
    joined = old?.batch ?? batchFor(all)
    return { ...all, [fresh.id]: { ...fresh, ...(old ? keep(old) : {}), batch: joined } }
  })
  if (joined > before) await saveRun($, before)
  await update($, batch, n => Math.max(n, joined))
}

// One colour per worker, in start order; the first is the Claude coral.
const PALETTE = ['#D97757', '#5FB89A', '#6F95E8', '#A97FE0', '#E3B341', '#E07FA0', '#7FBF5F', '#4FB3C8']
const DONE = '#3FB950'
const FAILED = '#E5534B'

// An 11x6 pixel critter; '.' is empty, so row 2 has two eyes.
const SPRITE = ['...#####...', '..#######..', '.##.###.##.', '###########', '#.#######.#', '..#.#.#.#..']

function esc(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function colorOf(w: Worker, order: string[]) {
  return PALETTE[Math.max(0, order.indexOf(w.id)) % PALETTE.length] ?? '#D97757'
}

function titleOf(w: Worker) {
  const parts = [`${w.type} · ${w.label}`, w.status]
  if (w.kind === 'agent') parts.push(`${w.steps} steps · ${w.tools} tools`)
  if (w.kind === 'agent' && w.isPriced) parts.push(`≈${money(w.usd)}`)
  return parts.join(' — ')
}

// Small (px 2) for the one-line bar, large (px 4) for the expanded one. A
// finished critter sits on a faint green tile, a failed one on a faint red.
function crittersSvg(list: Worker[], order: string[], px: number) {
  const isLarge = px >= 4
  const pad = isLarge ? 4 : 3
  const w = 11 * px + 2 * pad
  const gap = isLarge ? 6 : 3
  const h = 6 * px + 2 * pad + 2
  const lift = isLarge ? 2 : 1
  const pixels = SPRITE.flatMap((row, y) =>
    [...row].map((c, x) => (c === '#' ? `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}"/>` : '')),
  ).join('')
  const body = list
    .map((wk, i) => {
      const x0 = i * (w + gap)
      const failed = wk.status === 'failed' || wk.status === 'stopped'
      const fill = failed ? '#8A8A8A' : colorOf(wk, order)
      const tile = wk.status === 'done' ? DONE : failed ? FAILED : ''
      const motion =
        wk.status === 'running'
          ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -${lift};0 0" dur="0.7s" begin="${(i * 0.13).toFixed(2)}s" repeatCount="indefinite"/>`
          : wk.status === 'waiting'
            ? '<animate attributeName="opacity" values="1;0.45;1" dur="1.8s" repeatCount="indefinite"/>'
            : ''
      const badge = !isLarge
        ? ''
        : wk.status === 'done'
          ? `<circle cx="${x0 + w - 6}" cy="7" r="5.5" fill="${DONE}"/><path d="M${x0 + w - 8.6} 7.2l1.8 1.8 3.4-3.6" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round"/>`
          : failed
            ? `<circle cx="${x0 + w - 6}" cy="7" r="5.5" fill="${FAILED}"/><path d="M${x0 + w - 8} 5l4 4M${x0 + w - 4} 5l-4 4" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>`
            : ''
      return (
        `<g><title>${esc(titleOf(wk))}</title>` +
        (tile ? `<rect x="${x0}" y="1" width="${w}" height="${h - 2}" rx="${isLarge ? 6 : 4}" fill="${tile}" fill-opacity="0.2"/>` : '') +
        `<g transform="translate(${x0 + pad},${pad + 1})" fill="${fill}" opacity="${failed ? 0.6 : 1}"><g>${motion}${pixels}</g></g>${badge}</g>`
      )
    })
    .join('')
  const width = Math.max(1, list.length * (w + gap) - gap)
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${body}</svg>`,
    body,
    width,
    height: h,
  }
}

const SEGMENTS = 20

function barSvg(fraction: number, isMoving: boolean, isComplete: boolean, isSmall: boolean, segments = SEGMENTS) {
  const seg = isSmall ? 6 : 9
  const gap = 2
  const h = isSmall ? 8 : 14
  const width = segments * (seg + gap) - gap
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * segments)
  const fill = isComplete ? DONE : '#D97757'
  const span = filled * (seg + gap) - gap
  const solid = filled > 0 ? `<rect x="0" y="0" width="${span}" height="${h}" rx="2" fill="${fill}"/>` : ''
  const shine =
    filled > 0 && isMoving
      ? `<clipPath id="c"><rect x="0" y="0" width="${span}" height="${h}" rx="2"/></clipPath><rect clip-path="url(#c)" y="0" width="24" height="${h}" fill="#fff" opacity="0.25"><animate attributeName="x" from="-24" to="${span + 24}" dur="1.6s" repeatCount="indefinite"/></rect>`
      : ''
  const empty = Array.from({ length: segments - filled }, (_, k) => {
    const x = (filled + k) * (seg + gap)
    return `<rect x="${x + 0.5}" y="0.5" width="${seg - 1}" height="${h - 1}" rx="1.5" fill="#888" fill-opacity="0.12" stroke="#888" stroke-opacity="0.45"/>`
  }).join('')
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${solid}${shine}${empty}</svg>`,
    body: `${solid}${shine}${empty}`,
    width,
    height: h,
  }
}

// The desktop's one line as one picture: critters, count, bar, percent and
// cost. Side by side as separate elements the desktop dropped all but one.
const CHAR = 7
// The picture cannot read the app's theme, so its words take colours that
// read on light and dark alike: the bar's own accent for the numbers, a mid
// grey for the rest.
const LINE_STYLE =
  '<style>text{font:12px -apple-system,system-ui,sans-serif;font-variant-numeric:tabular-nums}.t{font-weight:600}.d{fill:#8C8C8C}</style>'

function lineSvg(
  c: { body: string; width: number; height: number } | null,
  count: string,
  countLabel: string,
  b: { body: string; width: number; height: number },
  pct: string,
  costText: string,
  accent: string,
) {
  const h = Math.max(20, c?.height ?? 0)
  const mid = h / 2
  let x = 0
  const parts: string[] = [LINE_STYLE]
  if (c) {
    parts.push(`<g transform="translate(0,${(h - c.height) / 2})">${c.body}</g>`)
    x = c.width + 10
  }
  parts.push(
    `<text x="${x}" y="${mid}" dominant-baseline="central"><tspan class="t" fill="${accent}">${esc(count)}</tspan><tspan class="d"> ${esc(countLabel)}</tspan></text>`,
  )
  x += (count.length + 1 + countLabel.length) * CHAR + 10
  parts.push(`<g transform="translate(${x},${(h - b.height) / 2})">${b.body}</g>`)
  x += b.width + 10
  parts.push(
    `<text x="${x}" y="${mid}" dominant-baseline="central"><tspan class="t" fill="${accent}">${esc(pct)}</tspan>${costText !== '' ? `<tspan class="d"> · ${esc(costText)}</tspan>` : ''}</text>`,
  )
  x += (pct.length + (costText !== '' ? 3 + costText.length : 0)) * CHAR + 4
  const width = Math.ceil(x)
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${parts.join('')}</svg>`,
    width,
    height: h,
  }
}

// The sessions pane's header on the desktop: this month and all time as two
// large figures, and the last six months as bars, this month in the accent.
// Drawn at a design width and left to scale down to the pane: narrow, the
// chart goes under the figures; wide, beside them.
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ALL_TIME = '#6F95E8'

function headerSvg(
  width: number,
  monthUsd: string,
  allUsd: string,
  note: string,
  months: { key: string; usd: number; text: string }[],
  current: string,
) {
  const font = '-apple-system,system-ui,sans-serif'
  const bar = 18
  const gap = 10
  const chartW = months.length * (bar + gap) - gap
  const hasChart = months.length > 1
  const isWide = hasChart && width >= 420 + chartW
  const h = hasChart && !isWide ? 158 : 96
  const label = (x: number, text: string, anchor = 'start') =>
    `<text x="${x}" y="26" text-anchor="${anchor}" font-family="${font}" font-size="11" font-weight="600" letter-spacing="0.8" fill="#8C8C8C">${esc(text.toUpperCase())}</text>`
  const figure = (x: number, text: string, fill: string, anchor = 'start') =>
    `<text x="${x}" y="60" text-anchor="${anchor}" font-family="${font}" font-size="30" font-weight="700" fill="${fill}" style="font-variant-numeric:tabular-nums">${esc(text)}</text>`
  // All time sits at the right edge of the figures' area, so the two never meet.
  const figuresRight = isWide ? Math.min(width - 32 - chartW - 24, 330) : width - 18
  const parts = [
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${h - 1}" rx="12" fill="#888" fill-opacity="0.07" stroke="#888" stroke-opacity="0.22"/>`,
    label(18, 'This month'),
    figure(18, monthUsd, '#D97757'),
    label(figuresRight, 'All time', 'end'),
    figure(figuresRight, allUsd, ALL_TIME, 'end'),
    `<text x="18" y="83" font-family="${font}" font-size="12" fill="#8C8C8C">${esc(note)}</text>`,
  ]
  if (hasChart) {
    const max = Math.max(...months.map(m => m.usd), 0.01)
    const tall = isWide ? 46 : 34
    const base = isWide ? 66 : 132
    // Wide: at the right. Narrow: spread across the card under a hairline.
    const step = isWide ? bar + gap : (width - 36 - bar) / Math.max(1, months.length - 1)
    const x0 = isWide ? width - 18 - chartW : 18
    if (!isWide) parts.push(`<line x1="18" x2="${width - 18}" y1="94.5" y2="94.5" stroke="#888" stroke-opacity="0.2"/>`)
    months.forEach((m, i) => {
      const x = x0 + i * step
      const bh = Math.max(3, Math.round((m.usd / max) * tall))
      const isNow = m.key === current
      const [, mon] = m.key.split('-')
      parts.push(
        `<g><title>${esc(m.text)}</title><rect x="${x}" y="${base - bh}" width="${bar}" height="${bh}" rx="3" fill="${isNow ? '#D97757' : '#8C8C8C'}" fill-opacity="${isNow ? 1 : 0.45}"/>` +
          `<text x="${x + bar / 2}" y="${base + 16}" text-anchor="middle" font-family="${font}" font-size="10" fill="${isNow ? '#D97757' : '#8C8C8C'}">${MONTH_SHORT[Number(mon) - 1] ?? ''}</text></g>`,
      )
    })
  }
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${parts.join('')}</svg>`,
    width,
    height: h,
  }
}

// How far the batch is, 0..1. A finished worker counts whole; a running
// subagent by its model requests, which approach but never reach 1; a
// background shell, which says nothing until it ends, as half.
function workersFraction(list: Worker[]) {
  if (list.length === 0) return 0
  const sum = list.reduce((acc, w) => {
    if (!isLive(w)) return acc + 1
    if (w.kind === 'shell') return acc + 0.5
    return acc + Math.min(0.9, 1 - Math.exp(-w.steps / 15))
  }, 0)
  return sum / list.length
}

function planFraction(p: Plan | null) {
  if (!p || p.items.length === 0) return 0
  const done = p.items.filter(i => i.status === 'completed').length
  const active = p.items.some(i => i.status === 'in_progress') ? 0.5 : 0
  return Math.min(1, (done + active) / p.items.length)
}

// Prices every saved session (scripts/scan.py, incremental after the first
// run) and keeps the result for the pane.
async function runScan($: EngineInterface) {
  if (await read($, isScanning)) return
  await update($, isScanning, () => true)
  try {
    const since = Number((await $.store.get(SINCE_KEY)) ?? 0) || 0
    const out = await $.process.run(
      [
        'python3',
        '-I',
        `${$.plugin.root}/scripts/scan.py`,
        '~/.claude/projects',
        '~/.claude/agent-info/scan-cache.json',
        JSON.stringify(PRICES),
        String(since),
      ],
      { timeoutMs: 600_000 },
    )
    if (out.exitCode !== 0) {
      throw new Error(out.stderr.trim().split('\n').pop() || `the scanner exited with ${out.exitCode}`)
    }
    const parsed = JSON.parse(out.stdout) as Omit<SessionScan, 'scannedAt'>
    const t = await $.clock.now()
    await update($, scan, () => ({ ...parsed, scannedAt: t }))
    await update($, scanError, () => '')
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    await update($, scanError, () => text)
  } finally {
    await update($, isScanning, () => false)
  }
}

// The pane opens at once and shows that it is reading; the command waits for
// the scan so its reply can carry the total, a press does not.
async function openSessions($: EngineInterface, isWaiting: boolean) {
  await update($, isPaneOpen, () => true)
  const opened = await $.ui.open({ id: PANE, title: 'Sessions' })
  if (isWaiting) await runScan($)
  else void runScan($)
  return opened
}

async function setSince($: EngineInterface, since: number) {
  await $.store.set(SINCE_KEY, since)
  await runScan($)
}

// What every drawing shows: the current batch and the cost split.
async function readView($: EngineInterface) {
  const all = Object.values(await read($, workers))
  const t = (await read($, now)) || Date.now()
  const current = topBatch(await read($, workers))
  const steps = await read($, plan)
  const last = await read($, lastRun)
  const order = [...all].sort((a, b) => a.startedAt - b.startedAt).map(w => w.id)
  const visible = all.filter(w => batchOf(w) === current).sort((a, b) => a.startedAt - b.startedAt)
  const finished = visible.filter(w => !isLive(w)).length
  const live = visible.length - finished
  const total = await read($, sessionUsd)
  const hasWorkers = visible.length > 0
  const fraction = hasWorkers ? workersFraction(visible) : planFraction(steps)
  const isComplete = hasWorkers ? live === 0 : fraction >= 1
  const pct = `${hasWorkers && !isComplete ? '~' : ''}${Math.round(fraction * 100)}%`
  // The session total is the engine's ledger, priced per API response at
  // list prices; a worker's figure is its own responses at the same prices,
  // so the share is the one divided by the other.
  const batchUsd = visible.reduce((sum, w) => sum + w.usd, 0)
  const sessionText = total !== null ? `session ${money(total)}` : 'session cost not reported'
  const share = total ? batchUsd / total : 0
  const workersText =
    visible.some(w => w.kind === 'agent')
      ? `workers ≈${money(batchUsd)}${total ? ` (${share < 0.01 && batchUsd > 0 ? '<1' : Math.round(share * 100)}%)` : ''}`
      : ''
  const noun = visible.every(w => w.kind === 'agent') ? 'subagents' : 'workers'
  const planTotal = steps?.items.length ?? 0
  const planDone = steps ? steps.items.filter(i => i.status === 'completed').length : 0
  const current_ =
    steps?.items.find(i => i.status === 'in_progress')?.content ?? (planTotal > 0 && planDone === planTotal ? 'all steps done' : '')
  return {
    t, order, visible, finished, live, hasWorkers, fraction, isComplete, pct, noun, last,
    sessionText, workersText, planTotal,
    costVariants: [
      [sessionText, workersText].filter(Boolean).join(' · '),
      total !== null && workersText ? `${money(total)} · ${workersText.replace('workers ≈', 'workers ')}` : '',
      total !== null && batchUsd > 0 ? `${money(total)} (workers ${share < 0.01 ? '<1' : Math.round(share * 100)}%)` : '',
      total !== null ? money(total) : '',
      '',
    ].filter((text, i, all) => i === all.length - 1 || text !== ''), planDone, currentStep: current_,
  }
}

function runLine(r: Run) {
  const parts = [
    dateOf(r.endedAt),
    `${r.workers} worker${r.workers === 1 ? '' : 's'}${r.failed ? ` (${r.failed} failed/stopped)` : ''}`,
    clockOf(r.endedAt - r.startedAt),
    r.workersUsd > 0 ? `workers ≈${money(r.workersUsd)}` : '',
    r.sessionUsd !== null ? `session ${money(r.sessionUsd)} at the time` : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-info',
      description: 'Workers bar: show it, fold it to the footer chip, list past runs, open the sessions pane, or turn it off',
      argumentHint: '[sessions|mini|off|history|auto on|auto off]',
    })
    const usage = await $.session.usage()
    await update($, sessionKey, k => k || usage.startedAt)
    if (usage.cost) {
      const usd = usage.cost.usd
      await update($, sessionUsd, () => usd)
    }
    if ((await $.store.get(OFF_KEY)) !== true) await update($, isOn, () => true)
    if ((await $.store.get(COMPACT_KEY)) === true) await update($, isMini, () => true)
    if ((await $.store.get(EXPANDED_KEY)) === true) await update($, isExpanded, () => true)
    const stored = await $.store.get(HISTORY_KEY)
    const first = Array.isArray(stored) ? (stored[0] as Run | undefined) : undefined
    if (first) await update($, lastRun, r => r ?? first)
    const id = await $.session.id()
    await update($, myId, () => id)

    // While the sessions pane is open, rescan each minute (only what grew is read).
    $.clock.every(60_000, () => {
      void (async () => {
        if (await read($, isPaneOpen)) await runScan($)
      })().catch(() => {})
    })

    $.clock.every(1000, () => {
      void (async () => {
        const all = await read($, workers)
        const shown = await read($, isOn)
        const hasLive = Object.values(all).some(isLive)
        if (!shown && !hasLive) return
        const t = await $.clock.now()
        if (hasLive) {
          const list = await $.agent.list()
          let ended = false
          await update($, workers, cur => {
            let out = cur
            for (const a of list) {
              const known = out[a.id]
              const status = statusOf(a.status)
              if (!known) {
                if (!isLive({ status })) continue
                const fresh: Worker = {
                  id: a.id,
                  kind: 'agent',
                  label: a.description || a.name || a.type,
                  type: a.type,
                  model: '',
                  status,
                  startedAt: t,
                  endedAt: null,
                  steps: 0,
                  tools: 0,
                  lastTool: '',
                  usd: 0,
                  isPriced: false,
                  batch: batchFor(out),
                }
                out = { ...out, [a.id]: fresh }
              } else if (known.status !== status && known.kind === 'agent') {
                if (!isLive({ status })) ended = true
                out = { ...out, [a.id]: { ...known, status, endedAt: isLive({ status }) ? null : (known.endedAt ?? t) } }
              }
            }
            return out
          })
          if (ended) await saveRun($)
        }
        if (shown && hasLive) await update($, now, () => t)
      })().catch(() => {})
    })

    return next(e)
  })

  on('command.run', { command: 'agent-info' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    if (args === 'auto on' || args === 'auto off') {
      await $.store.set(AUTO_KEY, args === 'auto on')
      return { text: `The bar ${args === 'auto on' ? 'now opens' : 'no longer opens'} by itself when a worker starts.` }
    }
    if (args === 'history') {
      const stored = await $.store.get(HISTORY_KEY)
      const history = Array.isArray(stored) ? (stored as Run[]) : []
      if (history.length === 0) return { text: 'No saved runs yet. A run is saved when its last worker finishes.' }
      const lines = history.slice(0, 15).map(r => `- ${runLine(r)}${r.labels.length ? `: ${r.labels.join(', ')}` : ''}`)
      return { text: `Last ${lines.length} runs (newest first):\n${lines.join('\n')}` }
    }
    if (args === 'sessions') {
      const opened = await openSessions($, true)
      const data = await read($, scan)
      const error = await read($, scanError)
      const total = data
        ? `${data.sessions.length} sessions on this machine at list prices: ${dollars(data.months[monthKey(data.scannedAt)] ?? 0)} this month, ${dollars(data.totalUsd)} all time${data.since > 0 ? `, ${dollars(data.sinceUsd)} since the reset` : ''}.`
        : `Could not read the sessions: ${error}`
      return {
        text: `${total}\n${opened.isPlaced ? 'Sessions pane opened.' : `The sessions pane is waiting to be placed (${opened.reason}).`}`,
      }
    }
    if (args === 'off') {
      await update($, isOn, () => false)
      await $.store.set(OFF_KEY, true)
      return { text: 'Workers bar off, chip included. /agent-info brings it back.' }
    }
    await $.store.set(OFF_KEY, false)
    const wasBar = (await read($, isOn)) && !(await read($, isMini))
    await update($, isOn, () => true)
    const mini = args === 'mini'
    await setMini($, mini)
    // Asked again while the bar is up: show the details too.
    if (!mini && wasBar && args === '') await setExpanded($, true)
    const v = await readView($)
    const status = v.hasWorkers
      ? [`${v.finished}/${v.visible.length} ${v.noun} done`, v.pct, v.sessionText, v.workersText].filter(Boolean).join(' · ')
      : v.last
        ? `Nothing running. Last run ${runLine(v.last)}.`
        : `Nothing running yet · ${v.sessionText}`
    const where = mini ? 'Folded into the footer chip; click it to open the bar.' : 'Bar shown above the prompt.'
    return { text: `${status}\n${where}` }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = result.agentId
    if (!id) return result
    const t = await $.clock.now()
    await addWorker(
      $,
      {
        id,
        kind: 'agent',
        label: e.description || e.subagentType,
        type: e.subagentType,
        model: result.model ?? '',
        status: 'running',
        startedAt: t,
        endedAt: null,
        steps: 0,
        tools: 0,
        lastTool: '',
        usd: 0,
        isPriced: false,
      },
      old => ({ startedAt: old.startedAt, steps: old.steps, tools: old.tools, lastTool: old.lastTool, usd: old.usd, isPriced: old.isPriced }),
    )
    await autoShow($)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      await patch($, e.agentId, w => ({ ...w, status: 'running', endedAt: null }))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage) {
      if (e.agentId) {
        await patch($, e.agentId, w => {
          const { usd, isPriced } = priceOf(result.usage!, e.model)
          return { ...w, steps: w.steps + 1, usd: w.usd + usd, isPriced: w.isPriced || isPriced, model: w.model || result.usage!.model }
        })
      } else {
        const { usd } = priceOf(result.usage, e.model)
        await update($, mainUsd, n => n + usd)
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const t = await $.clock.now()
      const status: WorkerStatus = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await patch($, e.agentId, w => {
        const late = w.steps === 0 && e.usage ? priceOf(e.usage, w.model) : null
        return {
          ...w,
          status,
          endedAt: t,
          usd: late ? w.usd + late.usd : w.usd,
          isPriced: w.isPriced || Boolean(late?.isPriced),
        }
      })
      await saveRun($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const agentId = e.agentId
    if (agentId) {
      await patch($, agentId, w => ({ ...w, tools: w.tools + 1, lastTool: tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '') }))
    }
    if (!agentId && PLAN_TOOLS.has(tool)) {
      const args = e as unknown as Record<string, unknown>
      await update($, plan, prev => applyPlan(prev, tool, args))
    }
    if (e.tool === 'Bash' && e.run_in_background) {
      const ran = await next(e)
      const id = /ID:\s*([\w-]+)/.exec(ran.text ?? '')?.[1]
      if (id) {
        const t = await $.clock.now()
        const label = e.description || e.command
        await addWorker(
          $,
          {
            id,
            kind: 'shell',
            label,
            type: 'shell',
            model: '',
            status: 'running',
            startedAt: t,
            endedAt: null,
            steps: 0,
            tools: 0,
            lastTool: '',
            usd: 0,
            isPriced: true,
          },
          old => ({ startedAt: old.startedAt }),
        )
        await autoShow($)
      }
      return ran
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const text = textOf(e.message.content)
    if (text.includes('<task-notification>')) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim()
      const raw = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim()
      if (id && raw) {
        const status: WorkerStatus =
          raw === 'completed' ? 'done' : raw === 'failed' ? 'failed' : raw === 'killed' ? 'stopped' : 'running'
        const t = await $.clock.now()
        await patch($, id, w => ({ ...w, status, endedAt: isLive({ status }) ? null : (w.endedAt ?? t) }))
        await saveRun($)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    if (e.cost) {
      const usd = e.cost.usd
      await update($, sessionUsd, () => usd)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn)) || (await read($, isMini))) return next(e)

    const v = await readView($)
    const expanded = await read($, isExpanded)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const cols = Math.max(40, e.props.bodyColumns || 80)
    const maxRows = Math.max(3, e.props.maxRows || 8)

    const count = v.hasWorkers ? `${v.finished}/${v.visible.length}` : `${v.planDone}/${v.planTotal}`
    const countLabel = v.hasWorkers ? `${v.noun} done` : 'steps done'
    const isIdle = !v.hasWorkers && v.planTotal === 0
    const cost = [v.sessionText, v.workersText].filter(Boolean).join(' · ')

    const controls = (
      <Box flexDirection="row" gap={1}>
        <Button key="sessions" plain label="$" onPress={() => void openSessions($, false)} />
        <Button key="size" plain label={expanded ? '▴' : '▾'} onPress={() => setExpanded($, !expanded)} />
        <Button key="minimize" plain label="–" onPress={() => setMini($, true)} />
      </Box>
    )

    const idleText = v.last
      ? `Last run ${runLine(v.last)}`
      : 'No workers yet. They show here as they start.'

    // One line: small critters, count, thin bar, percent and cost.
    const line = isIdle ? (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text>
          <Text dimColor>{cut(idleText, cols - 30)}</Text>
          <Text dimColor>{v.last ? '' : `  ${v.sessionText}`}</Text>
        </Text>
        {controls}
      </Box>
    ) : Svg ? (
      (() => {
        // The desktop does not truncate a Text, so the cost is chosen to fit
        // what the critters and the bar leave (about 7 px a column).
        const shown = v.visible.slice(-12)
        const c = v.hasWorkers ? crittersSvg(shown, v.order, expanded ? 4 : 2) : null
        const segments = cols < 110 && !expanded ? 12 : SEGMENTS
        const b = barSvg(v.fraction, v.live > 0, v.isComplete, false, segments)
        const head = `${v.visible.length > 12 ? `+${v.visible.length - 12} ` : ''}${count}`
        const tail = v.hasWorkers ? 'done' : 'steps done'
        const room = (cols - 8) * CHAR
        const accent = v.isComplete ? DONE : '#D97757'
        const fits = (text: string) => lineSvg(c, head, tail, b, v.pct, text, accent).width <= room
        const costText = v.costVariants.find(fits) ?? ''
        const pic = lineSvg(c, head, tail, b, v.pct, costText, accent)
        const alt = [`${head} ${tail}`, v.pct, costText].filter(Boolean).join(' · ')
        return (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box flexShrink={0}>
              <Svg source={pic.source} alt={alt} isInteractive width={pic.width} height={pic.height} />
            </Box>
            <Box flexGrow={1} />
            <Box flexShrink={0}>{controls}</Box>
          </Box>
        )
      })()
    ) : (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {v.visible.slice(-12).map(w => (
            <Text color={isLive(w) ? colorOf(w, v.order) : w.status === 'done' ? 'success' : 'error'}>
              {isLive(w) ? '●' : w.status === 'done' ? '✓' : '✕'}
            </Text>
          ))}
          <Text weight="semibold"> {count}</Text>
          <Text dimColor> {countLabel} </Text>
          <Text color={v.isComplete ? 'success' : 'claude'}>{bar(Math.round(v.fraction * 16), 16, 16)}</Text>
          <Text> {v.pct}</Text>
          <Text dimColor> · {cut(cost, Math.max(10, cols - 50))}</Text>
        </Text>
        {controls}
      </Box>
    )

    if (!expanded) return line

    const planLine =
      v.planTotal > 0 && v.currentStep !== '' ? (
        <Text>
          <Text dimColor>Plan {v.planDone}/{v.planTotal} · </Text>
          <Text>{cut(v.currentStep, cols - 16)}</Text>
        </Text>
      ) : null
    const room = maxRows - (Svg ? 2 : 1) - (planLine ? 1 : 0)
    const rows = [...v.visible].reverse().slice(0, Math.max(0, room))
    const hidden = v.visible.length - rows.length

    return (
      <Box flexDirection="column">
        {line}
        {planLine}
        {rows.map(w => {
          const elapsed = clockOf((w.endedAt ?? v.t) - w.startedAt)
          const statusColor =
            w.status === 'running' ? 'warning' : w.status === 'waiting' ? 'suggestion' : w.status === 'done' ? 'success' : 'error'
          const detail =
            w.kind === 'shell'
              ? 'background shell'
              : [`${w.steps} steps`, `${w.tools} tools`, isLive(w) && w.lastTool ? w.lastTool : ''].filter(Boolean).join(' · ')
          const wCost = w.kind === 'shell' ? '' : w.isPriced ? `≈${money(w.usd)}` : w.steps > 0 ? 'cost ?' : ''
          const fixed = 4 + w.type.length + 3 + 9 + elapsed.length + detail.length + wCost.length + 8
          return (
            <Text>
              <Text color={colorOf(w, v.order)}>● </Text>
              <Text dimColor>{w.type} · </Text>
              <Text>{cut(w.label, Math.max(12, cols - fixed))}</Text>
              <Text color={statusColor}>
                {'  '}
                {w.status}
              </Text>
              <Text tabular> {elapsed}</Text>
              <Text dimColor>
                {'  '}
                {detail}
              </Text>
              {wCost !== '' ? (
                <Text tabular>
                  {'  '}
                  {wCost}
                </Text>
              ) : null}
            </Text>
          )
        })}
        {hidden > 0 ? <Text dimColor>+{hidden} more</Text> : null}
      </Box>
    )
  })

  // Folded: one chip in the footer's mode labels; a click opens the bar.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await read($, isOn)) || !(await read($, isMini))) return next(e)

    const v = await readView($)
    const { Box, Button, Text } = $.ui.resolve(e)
    const modes = e.props.modes.join(' & ')
    const dots = v.visible.slice(-8)

    return (
      <Box flexDirection="row" gap={1}>
        {modes !== '' ? <Text dimColor>{modes}</Text> : null}
        <Button key="expand" plain onPress={() => setMini($, false)}>
          {dots.length === 0 ? <Text dimColor>◉ agents</Text> : ''}
          {dots.map(w => (
            <Text color={isLive(w) ? colorOf(w, v.order) : w.status === 'done' ? 'success' : 'error'}>
              {isLive(w) ? '●' : w.status === 'done' ? '✓' : '✕'}
            </Text>
          ))}
          {v.hasWorkers ? (
            <Text dimColor>
              {' '}
              {v.finished}/{v.visible.length} · {v.pct} · {v.sessionText}
            </Text>
          ) : (
            ''
          )}
        </Button>
      </Box>
    )
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isPaneOpen, () => false)
    return next(e)
  })

  // Every session saved on this machine: this month's and the all-time total
  // at the top, the running sessions, then month by month with each session's
  // cost in that month.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const data = await read($, scan)
    const busy = await read($, isScanning)
    const error = await read($, scanError)
    const me = await read($, myId)
    const ledger = await read($, sessionUsd)
    const toggles = await read($, monthToggles)
    const cols = Math.max(30, e.props.bodyColumns || 60)

    if (!data) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>
            {error !== ''
              ? `Could not read the sessions: ${error}`
              : 'Reading every session saved on this machine. The first scan reads all transcripts once and takes a few seconds.'}
          </Text>
          {error !== '' ? <Button key="rescan" label="Try again" onPress={() => void runScan($)} /> : null}
        </Box>
      )
    }

    const since = data.since
    const thisMonth = monthKey(data.scannedAt)
    const byId = new Map(data.sessions.map(s => [s.id, s]))
    const isActive = (s: SessionRow) => s.id === me || data.scannedAt - s.mtime < ACTIVE_MS
    const running = data.sessions.filter(isActive)
    const starts = data.sessions.map(s => s.first).filter(n => n > 0)
    const first = starts.length > 0 ? Math.min(...starts) : 0
    const months = Object.keys(data.months).sort().reverse()
    const isOpen = (m: string) => (m === thisMonth) !== toggles.includes(m)
    const toggle = (m: string) =>
      update($, monthToggles, list => (list.includes(m) ? list.filter(x => x !== m) : [...list, m]))
    const thisMonthUsd = data.months[thisMonth] ?? 0

    // One session in two lines: a dot when running, its title and cost; then
    // where and when it ran.
    const row = (s: SessionRow, usd: number, extra: string, key: string) => {
      const here = s.id === me
      const parent = s.forkOf ? byId.get(s.forkOf) : undefined
      const cost = dollars(usd)
      const detail = [
        here ? 'this session' : projectOf(s.cwd),
        isActive(s) ? `active ${agoOf(data.scannedAt - s.mtime)}` : dateOf(s.last || s.mtime),
        extra,
        s.forkOf ? `fork of ${parent?.title ? cut(parent.title, 24) : s.forkOf.slice(0, 8)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      return (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text weight={here ? 'semibold' : 'regular'}>
              {isActive(s) ? <Text color="success">● </Text> : ''}
              {cut(s.title || s.id.slice(0, 8), cols - cost.length - 4)}
            </Text>
            <Text tabular weight="semibold">
              {cost}
            </Text>
          </Box>
          <Text dimColor>{detail}</Text>
        </Box>
      )
    }

    const note = [
      monthName(thisMonth),
      `${data.sessions.length} sessions${first > 0 ? ` since ${dayOf(first)}` : ''}`,
      since > 0 ? `${dollars(data.sinceUsd)} since reset ${dayOf(since)}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const chart = months
      .slice(0, 6)
      .reverse()
      .map(m => ({ key: m, usd: data.months[m] ?? 0, text: `${monthName(m)}: ${dollars(data.months[m] ?? 0)}` }))
    const card = Svg
      ? headerSvg(
          Math.min(720, Math.max(300, cols * 8)),
          dollars(thisMonthUsd),
          dollars(data.totalUsd),
          note,
          chart,
          thisMonth,
        )
      : null

    const header = card && Svg ? (
      <Svg
        source={card.source}
        alt={`This month ${dollars(thisMonthUsd)}, all time ${dollars(data.totalUsd)}. ${note}`}
        isInteractive
      />
    ) : (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text weight="semibold">This month · {monthName(thisMonth)}</Text>
          <Text weight="semibold" tabular color="claude">
            {dollars(thisMonthUsd)}
          </Text>
        </Box>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text weight="semibold">All time</Text>
          <Text weight="semibold" tabular>
            {dollars(data.totalUsd)}
          </Text>
        </Box>
        <Text dimColor>{cut(note, cols)}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {header}
          <Box flexDirection="row" gap={2}>
            <Button key="rescan" plain label={busy ? 'Scanning…' : 'Rescan'} onPress={() => void runScan($)} />
            <Button key="reset" plain label="Reset total" onPress={() => void setSince($, Date.now())} />
            {since > 0 ? <Button key="alltime" plain label="Clear reset" onPress={() => void setSince($, 0)} /> : null}
            <Text dimColor>{running.length} running</Text>
          </Box>
          {error !== '' ? <Text color="error">{cut(error, cols)}</Text> : null}
        </Box>
        {running.length > 0 ? (
          <Box flexDirection="column">
            <Text weight="semibold" color="success">
              Running now
            </Text>
            {running.map(s => {
              // This session's own figure is the engine's ledger, when there is one.
              const usd = s.id === me && ledger !== null ? ledger : s.usd
              const month = s.months[thisMonth] ?? 0
              const extra = Math.abs(month - s.usd) > 0.005 ? `${dollars(month)} this month` : ''
              return row(s, usd, extra, `run-${s.id}`)
            })}
          </Box>
        ) : null}
        <Box flexDirection="column">
          <Text weight="semibold">By month</Text>
          {months.map(m => {
            const list = data.sessions
              .filter(s => (s.months[m] ?? 0) > 0)
              .sort((a, b) => (b.months[m] ?? 0) - (a.months[m] ?? 0))
            const open = isOpen(m)
            const usd = data.months[m] ?? 0
            const isNow = m === thisMonth
            return (
              <Box key={`group-${m}`} flexDirection="column" marginTop={1}>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Button key={`month-${m}`} plain onPress={() => void toggle(m)}>
                    {open ? '▾ ' : '▸ '}
                    {monthName(m)}
                    <Text dimColor>
                      {' · '}
                      {list.length} session{list.length === 1 ? '' : 's'}
                    </Text>
                  </Button>
                  <Text tabular weight="semibold" color={isNow ? 'claude' : undefined}>
                    {dollars(usd)}
                  </Text>
                </Box>
                {open ? (
                  <Box flexDirection="column" marginLeft={2}>
                    {list.map(s => {
                      // This session, all of it this month: the engine's ledger, as above.
                      const isAllHere = s.id === me && ledger !== null && Object.keys(s.months).length === 1
                      const part = isAllHere && ledger !== null ? ledger : (s.months[m] ?? 0)
                      const extra = Math.abs((s.months[m] ?? 0) - s.usd) > 0.005 ? `${dollars(s.usd)} in all` : ''
                      return row(s, part, extra, `${m}-${s.id}`)
                    })}
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
        <Text dimColor>
          List-price estimates from each saved transcript, by the local month each reply was made in. Each reply
          counts once, so a fork counts only what it spent after it split. Running: its transcript changed in the
          last 3 minutes. Cloud sessions are not on this machine.
        </Text>
      </Box>
    )
  })
}
