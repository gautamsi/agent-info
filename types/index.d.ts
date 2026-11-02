export type WorkerKind = 'agent' | 'shell'

export type WorkerStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

export type Worker = {
  id: string
  kind: WorkerKind
  label: string
  type: string
  model: string
  status: WorkerStatus
  startedAt: number
  endedAt: number | null
  steps: number
  tools: number
  lastTool: string
  usd: number
  isPriced: boolean
  batch?: number
}

export type Plan = {
  items: { content: string; status: string }[]
}

// One batch of workers, from the first start to the last finish.
export type Run = {
  id: string
  startedAt: number
  endedAt: number
  workers: number
  done: number
  failed: number
  workersUsd: number
  sessionUsd: number | null
  labels: string[]
}

// One saved session as scripts/scan.py prices it.
export type SessionRow = {
  id: string
  title: string
  cwd: string
  first: number
  last: number
  mtime: number
  usd: number
  sinceUsd: number
  replies: number
  unpriced: number
  model: string
  forkOf: string | null
  // Cost per local calendar month, 'YYYY-MM'.
  months: Record<string, number>
}

export type SessionScan = {
  sessions: SessionRow[]
  totalUsd: number
  sinceUsd: number
  since: number
  months: Record<string, number>
  files: number
  readBytes: number
  ms: number
  scannedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-info': {
      isOn: boolean
      isExpanded: boolean
      isMini: boolean
      workers: Record<string, Worker>
      plan: Plan | null
      sessionUsd: number | null
      sessionKey: number
      mainUsd: number
      now: number
      batch: number
      lastRun: Run | null
      scan: SessionScan | null
      isScanning: boolean
      scanError: string
      isPaneOpen: boolean
      myId: string
      monthToggles: string[]
    }
  }
}
