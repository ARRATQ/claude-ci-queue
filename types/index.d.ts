export type JobView = {
  name: string
  status: string
  conclusion: string | null
  runner: string | null
  percent: number
}

export type RunView = {
  id: number
  workflow: string
  title: string
  branch: string
  event: string
  status: string
  createdAt: string
  startedAt: string | null
  percent: number
  etaMin: number | null
  /** Queued runs: estimated start time (ms since the epoch). */
  startEta: number | null
  jobs: JobView[]
}

export type FinishedView = {
  id: number
  workflow: string
  branch: string
  title: string
  conclusion: string
  pr: number | null
  failedJobs: string[]
  url: string
  at: number
}

export type CiSnapshot = {
  running: RunView[]
  queued: RunView[]
  repo: string | null
  finished: FinishedView[]
  ghosts: number
  updatedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'ci-queue': { snapshot: Shaped<CiSnapshot | null> }
  }
}
