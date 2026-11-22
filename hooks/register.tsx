import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CiSnapshot, FinishedView, JobView, RunView } from '../types'

const PANE = 'ci-queue'
const TITLE = 'CI queue'
// One pass a minute while the pane is shown, every 5 minutes while it is hidden.
const REFRESH_MS = 60_000
const HIDDEN_REFRESH_MS = 5 * 60_000
// gh answers are shared on disk by every session on this machine, so ten open
// sessions cost about as much GitHub API quota as one.
const CACHE_DIR = '/tmp/claude-ci-queue'
const LIVE_TTL_MS = 50_000
const DONE_TTL_MS = 24 * 60 * 60_000
const HISTORY_MS = 60 * 60_000
// A run "in progress" for longer than this is a ghost (killed runner, run never closed).
const GHOST_AGE_MS = 12 * 60 * 60_000
const KEEP_FINISHED = 6
const RUN_KEY = '__run__'
// Tried in order: the PATH first, then the usual Homebrew locations.
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']

const snapshot = atom({ plugin: 'ci-queue', key: 'snapshot' } as const, null, {
  shape: 'snapshot-3',
})

type GhRun = {
  databaseId: number
  workflowName: string
  displayTitle: string
  headBranch: string
  event: string
  status: string
  createdAt: string
  startedAt: string | null
}

type GhJob = {
  name: string
  status: string
  conclusion: string | null
  runner_name: string | null
  started_at: string | null
  completed_at: string | null
  steps?: { status: string }[]
}

type GhRunDetail = {
  status: string
  conclusion: string | null
  html_url: string
  pull_requests?: { number: number }[]
}

const RUN_FIELDS =
  'databaseId,workflowName,displayTitle,headBranch,event,status,createdAt,startedAt'

// Median duration (ms) per "workflow::job", and per "workflow::__run__" end to end,
// taken from the latest successful runs.
let medians: Record<string, number> = {}
let mediansAt = 0
let mediansRepo = ''
let timer: { cancel: () => void } | null = null
let inflight: Promise<void> | null = null
let lastPassAt = 0
let ghPath: string | null = null
let repo: string | null = null
let configuredRepo = ''
// Runs seen running or queued on the previous pass: one that disappears has finished.
let watched = new Map<number, GhRun>()
let seeded = false

async function gh($: EngineInterface, args: string[]): Promise<string> {
  const candidates = ghPath ? [ghPath] : GH_CANDIDATES
  for (const exe of candidates) {
    let result
    try {
      result = await $.process.run([exe, ...args], { timeoutMs: 60_000 })
    } catch {
      continue // not installed at this path
    }
    ghPath = exe
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim().split('\n')[0] || `gh exited with ${result.exitCode}`)
    }
    return result.stdout
  }
  throw new Error('GitHub CLI (gh) not found: install it and run `gh auth login`')
}

// gh through the shared disk cache: an answer younger than ttlMs, written by
// any session, is reused instead of calling GitHub again.
async function cachedGh($: EngineInterface, args: string[], ttlMs: number): Promise<string> {
  const key = args.join(' ').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180)
  const file = `${CACHE_DIR}/${key}.json`
  try {
    const hit = JSON.parse(await $.fs.read(file)) as { at: number; out: string }
    if (Date.now() - hit.at < ttlMs) return hit.out
  } catch {
    // no cache yet, or unreadable: ask GitHub
  }
  const out = await gh($, args)
  await $.fs.write(file, JSON.stringify({ at: Date.now(), out })).catch(() => undefined)
  return out
}

async function resolveRepo($: EngineInterface): Promise<string> {
  if (configuredRepo) return configuredRepo
  if (repo) return repo
  const out = await gh($, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).catch(() => '')
  const name = out.trim()
  if (!name) {
    throw new Error('No GitHub repository for this folder: set the "repo" option (owner/name)')
  }
  repo = name
  return name
}

async function listRuns($: EngineInterface, target: string, status: string): Promise<GhRun[]> {
  const out = await cachedGh($, ['run', 'list', '-R', target, '--status', status, '-L', '50', '--json', RUN_FIELDS], LIVE_TTL_MS)
  return JSON.parse(out) as GhRun[]
}

// A finished run's jobs never change: pass DONE_TTL_MS for those.
async function listJobs($: EngineInterface, target: string, runId: number, ttlMs = LIVE_TTL_MS): Promise<GhJob[]> {
  const out = await cachedGh($, ['api', `repos/${target}/actions/runs/${runId}/jobs?per_page=100`], ttlMs)
  return (JSON.parse(out).jobs ?? []) as GhJob[]
}

async function refreshMedians($: EngineInterface, target: string, workflows: string[]): Promise<void> {
  const now = Date.now()
  if (mediansRepo !== target) {
    medians = {}
    mediansRepo = target
    mediansAt = 0
  }
  const known = (w: string) => `${w}::${RUN_KEY}` in medians
  if (now - mediansAt < HISTORY_MS && workflows.every(known)) return
  const samples: Record<string, number[]> = {}
  for (const wf of workflows) {
    const out = await cachedGh($, ['run', 'list', '-R', target, '--workflow', wf, '--status', 'success', '-L', '5', '--json', 'databaseId'], HISTORY_MS)
    const ids = (JSON.parse(out) as { databaseId: number }[]).map(r => r.databaseId)
    for (const id of ids) {
      const jobs = await listJobs($, target, id, DONE_TTL_MS)
      const ran = jobs.filter(j => j.conclusion !== 'skipped')
      const starts = ran.flatMap(j => (j.started_at ? [Date.parse(j.started_at)] : []))
      const ends = ran.flatMap(j => (j.completed_at ? [Date.parse(j.completed_at)] : []))
      if (starts.length && ends.length) {
        const wall = Math.max(...ends) - Math.min(...starts)
        if (wall > 0) (samples[`${wf}::${RUN_KEY}`] ??= []).push(wall)
      }
      for (const job of jobs) {
        if (job.conclusion !== 'success' || !job.started_at || !job.completed_at) continue
        const ms = Date.parse(job.completed_at) - Date.parse(job.started_at)
        if (ms > 0) (samples[`${wf}::${job.name}`] ??= []).push(ms)
      }
    }
  }
  const next: Record<string, number> = { ...medians }
  for (const [key, list] of Object.entries(samples)) {
    const sorted = [...list].sort((a, b) => a - b)
    next[key] = sorted[Math.floor(sorted.length / 2)] ?? 0
  }
  medians = next
  mediansAt = now
}

function stepFraction(job: GhJob): number {
  const steps = job.steps ?? []
  if (steps.length === 0) return 0
  return steps.filter(s => s.status === 'completed').length / steps.length
}

// Progress of a run: each job weighs its usual duration; a running job counts
// elapsed / usual duration (capped at 99 %), or its finished steps when never seen.
function describeRun(run: GhRun, jobs: GhJob[], now: number): RunView {
  let done = 0
  let total = 0
  let remaining = 0
  let known = true
  const views: JobView[] = jobs.map(job => {
    const median = medians[`${run.workflowName}::${job.name}`]
    const skipped = job.conclusion === 'skipped'
    const weight = skipped ? 0 : median ?? 60_000
    if (median === undefined && !skipped) known = false
    let fraction = 0
    if (job.status === 'completed') fraction = 1
    else if (job.status === 'in_progress') {
      const elapsed = job.started_at ? now - Date.parse(job.started_at) : 0
      fraction = median ? Math.min(0.99, elapsed / median) : Math.min(0.99, stepFraction(job))
      if (median) remaining += Math.max(0, median - elapsed)
    } else if (median) remaining += median
    done += weight * fraction
    total += weight
    return {
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      runner: job.runner_name,
      percent: Math.round(fraction * 100),
    }
  })
  // Jobs run in parallel: time left is the usual end-to-end duration minus time spent.
  const wall = medians[`${run.workflowName}::${RUN_KEY}`]
  const firstStart = jobs
    .filter(j => j.started_at && j.conclusion !== 'skipped')
    .reduce<number | null>((min, j) => Math.min(min ?? Infinity, Date.parse(j.started_at!)), null)
  let remainingMs: number | null = known && remaining > 0 ? remaining : null
  if (wall && firstStart !== null) remainingMs = Math.max(60_000, wall - (now - firstStart))
  return {
    id: run.databaseId,
    workflow: run.workflowName,
    title: run.displayTitle,
    branch: run.headBranch,
    event: run.event,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
    etaMin: remainingMs !== null ? Math.ceil(remainingMs / 60_000) : null,
    startEta: null,
    jobs: views,
  }
}

// Each running run frees a slot at its estimated end; queued runs take slots in order.
function estimateStarts(running: RunView[], queued: RunView[], now: number): RunView[] {
  const slots = running.length ? running.map(r => now + (r.etaMin ?? 10) * 60_000) : [now]
  return queued.map(run => {
    slots.sort((a, b) => a - b)
    const start = slots[0] ?? now
    const wall = medians[`${run.workflow}::${RUN_KEY}`]
    slots[0] = start + (wall ?? 20 * 60_000)
    return { ...run, startEta: start }
  })
}

async function checkFinished($: EngineInterface, target: string, gone: GhRun[], now: number): Promise<FinishedView[]> {
  const done: FinishedView[] = []
  for (const run of gone) {
    const detail = JSON.parse(
      await cachedGh($, ['api', `repos/${target}/actions/runs/${run.databaseId}`], LIVE_TTL_MS),
    ) as GhRunDetail
    if (detail.status !== 'completed') {
      watched.set(run.databaseId, run) // now "waiting" or similar: keep watching it
      continue
    }
    const conclusion = detail.conclusion ?? 'unknown'
    const failedJobs =
      conclusion === 'success'
        ? []
        : (await listJobs($, target, run.databaseId, DONE_TTL_MS))
            .filter(j => j.conclusion === 'failure' || j.conclusion === 'timed_out')
            .map(j => j.name)
    done.push({
      id: run.databaseId,
      workflow: run.workflowName,
      branch: run.headBranch,
      title: run.displayTitle,
      conclusion,
      pr: detail.pull_requests?.[0]?.number ?? null,
      failedJobs,
      url: detail.html_url,
      at: now,
    })
  }
  return done
}

// An issue key in the branch name, such as feat/ABC-123-thing -> ABC-123.
function ticketOf(branch: string): string | null {
  return /\b[A-Z][A-Z0-9]+-\d+\b/i.exec(branch)?.[0]?.toUpperCase() ?? null
}

function verdict(f: FinishedView): string {
  if (f.conclusion === 'success') return 'passed ✓'
  if (f.conclusion === 'cancelled') return 'cancelled'
  return `failed ✗${f.failedJobs.length ? ` (${f.failedJobs.join(', ')})` : ''}`
}

function finishedLine(f: FinishedView): string {
  const ticket = ticketOf(f.branch)
  const who = [f.pr ? `#${f.pr}` : f.branch, ticket].filter(Boolean).join(' · ')
  return `${f.workflow} ${verdict(f)} — ${who}`
}

async function announce($: EngineInterface, f: FinishedView): Promise<void> {
  const text = finishedLine(f)
  $.ui.toast(text, { timeoutMs: 10_000 })
  await $.ui.notify(text, { title: 'CI finished' }).catch(() => undefined)
}

// One pass at a time: a call during a pass shares it.
function refresh($: EngineInterface): Promise<void> {
  inflight ??= pass($).catch(() => undefined).finally(() => {
    inflight = null
  })
  return inflight
}

// The timer's tick: a full pass while the pane is shown, a slower one otherwise.
async function tick($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes().catch(() => [])
  const shown = panes.some(p => p.id === PANE && p.isShown)
  if (!shown && Date.now() - lastPassAt < HIDDEN_REFRESH_MS - 5_000) return
  await refresh($)
}

async function pass($: EngineInterface): Promise<void> {
  let target: string | null = null
  lastPassAt = Date.now()
  try {
    const now = Date.now()
    target = await resolveRepo($)
    const [inProgress, queued] = await Promise.all([
      listRuns($, target, 'in_progress'),
      listRuns($, target, 'queued'),
    ])
    const live = inProgress.filter(r => now - Date.parse(r.createdAt) < GHOST_AGE_MS)
    const ghosts = inProgress.length - live.length
    const queuedLive = queued.filter(r => now - Date.parse(r.createdAt) < GHOST_AGE_MS * 4)
    const workflows = [...new Set([...live, ...queuedLive].map(r => r.workflowName))]
    await refreshMedians($, target, workflows).catch(() => undefined)

    const running: RunView[] = []
    for (const run of live) running.push(describeRun(run, await listJobs($, target, run.databaseId), now))
    const waiting = estimateStarts(
      running,
      queuedLive
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map(r => describeRun(r, [], now)),
      now,
    )

    // Finished runs: watched last time, neither running nor queued now.
    const present = new Map<number, GhRun>([...live, ...queuedLive].map(r => [r.databaseId, r]))
    const gone = seeded ? [...watched.values()].filter(r => !present.has(r.databaseId)) : []
    watched = present
    seeded = true
    const finished = await checkFinished($, target, gone, now).catch(() => [] as FinishedView[])
    for (const f of finished) await announce($, f)

    await update($, snapshot, prev => ({
      running,
      queued: waiting,
      repo: target,
      finished: [...finished, ...(prev?.repo === target ? prev.finished : [])].slice(0, KEEP_FINISHED),
      ghosts,
      updatedAt: now,
      error: null,
    }))
    $.ui.status(`CI: ${running.length} running · ${waiting.length} queued`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, snapshot, prev => ({
      running: prev?.running ?? [],
      queued: prev?.queued ?? [],
      repo: target ?? prev?.repo ?? null,
      finished: prev?.finished ?? [],
      ghosts: prev?.ghosts ?? 0,
      updatedAt: prev?.updatedAt ?? 0,
      error: message,
    }))
  }
}

export const register: Register = (on, options) => {
  const option = typeof options.repo === 'string' ? options.repo.trim() : ''
  if (option !== configuredRepo) {
    configuredRepo = option
    watched = new Map()
    seeded = false
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci-queue',
      description: 'Open the CI queue pane (running runs and queue) and refresh it',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    timer?.cancel()
    timer = $.clock.every(REFRESH_MS, () => void tick($))
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'ci-queue' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await inflight // a pass already running (from the timer) finishes first
    await refresh($)
    const snap = await read($, snapshot)
    if (snap?.error) return { text: `CI queue: ${snap.error}` }
    return {
      text: `CI queue (${snap?.repo ?? '?'}): ${snap?.running.length ?? 0} running, ${snap?.queued.length ?? 0} queued.`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const width = Math.max(30, (e.viewport?.columns ?? 60) - 4)
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
    const bar = (pct: number, n = 20) => {
      const full = Math.round((pct / 100) * n)
      return `${'█'.repeat(full)}${'░'.repeat(n - full)}`
    }
    const clock = (ms: number) =>
      new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    const since = (iso: string | null) => {
      if (!iso) return ''
      const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
      return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
    }
    const jobMark = (j: JobView) =>
      j.status === 'completed'
        ? j.conclusion === 'success' ? '✓' : j.conclusion === 'skipped' ? '–' : '✗'
        : j.status === 'in_progress' ? '▶' : '…'
    const jobColor = (j: JobView) =>
      j.status === 'completed' && j.conclusion !== 'success' && j.conclusion !== 'skipped' ? 'error' : undefined

    if (!snap) return <Text dimColor>Reading GitHub Actions runs…</Text>

    return (
      <Box flexDirection="column">
        {snap.repo && <Text dimColor>{snap.repo}</Text>}
        {snap.error && <Text color="error">{clip(snap.error, width)}</Text>}

        <Text bold>Running ({snap.running.length})</Text>
        {snap.running.length === 0 && <Text dimColor>  Nothing running.</Text>}
        {snap.running.map(run => (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              {bar(run.percent)} <Text bold>{run.percent} %</Text>
              {run.etaMin !== null ? <Text dimColor>  ~{run.etaMin} min left</Text> : null}
            </Text>
            <Text>{clip(`${run.workflow} · ${run.branch}`, width)}</Text>
            <Text dimColor>{clip(run.title, width)}</Text>
            <Text dimColor>started {since(run.startedAt)} ago</Text>
            {run.jobs
              .filter(j => j.conclusion !== 'skipped')
              .map(j => (
                <Text color={jobColor(j)} dimColor={j.status === 'completed' && !jobColor(j)}>
                  {'  '}{jobMark(j)} {clip(j.name, width - 18)}
                  {j.status === 'in_progress' ? ` ${j.percent} %` : ''}
                  {j.status === 'queued' || j.status === 'waiting' ? ' (waiting for a runner)' : ''}
                  {j.runner && j.status === 'in_progress' ? ` · ${j.runner}` : ''}
                </Text>
              ))}
          </Box>
        ))}

        <Text bold>Queue ({snap.queued.length})</Text>
        {snap.queued.length === 0 && <Text dimColor>  Queue is empty.</Text>}
        {snap.queued.map((run, i) => (
          <Box flexDirection="column">
            <Text>
              {i + 1}. {clip(`${run.workflow} · ${run.branch}`, width - 4)}
            </Text>
            <Text dimColor>
              {'   '}queued {since(run.createdAt)} ago · {run.event === 'push' ? 'push' : 'PR'}
            </Text>
            {run.startEta !== null && (
              <Text color="warning">
                {'   '}estimated start around {clock(run.startEta)}
                {run.startEta - Date.now() > 60_000
                  ? ` (in ~${Math.round((run.startEta - Date.now()) / 60_000)} min)`
                  : ' (any moment)'}
              </Text>
            )}
          </Box>
        ))}

        {snap.finished.length > 0 && <Text bold>{'\n'}Recently finished</Text>}
        {snap.finished.map(f => (
          <Text color={f.conclusion === 'success' ? 'success' : f.conclusion === 'cancelled' ? undefined : 'error'}>
            {clip(`${clock(f.at)} ${finishedLine(f)}`, width)}
          </Text>
        ))}

        <Text dimColor>
          {'\n'}updated {snap.updatedAt ? clock(snap.updatedAt) : '—'} · every 1 min (5 min when hidden)
          {snap.ghosts > 0 ? ` · ${snap.ghosts} stale run(s) ignored` : ''}
        </Text>
      </Box>
    )
  })
}
