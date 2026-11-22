import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'ci-queue',
  component: 'Pane',
  requestId: 'ci-queue',
  props: { title: 'CI queue', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()

const RUN1 = { databaseId: 1, workflowName: 'CI', displayTitle: 'Add login', headBranch: 'feat/ABC-1-login', event: 'pull_request', status: 'in_progress', createdAt: iso(20), startedAt: iso(20) }
const GHOST = { databaseId: 9, workflowName: 'Old', displayTitle: 'old', headBranch: 'x', event: 'push', status: 'in_progress', createdAt: iso(60 * 24 * 90), startedAt: iso(60 * 24 * 90) }
const RUN2 = { databaseId: 2, workflowName: 'CI', displayTitle: 'Fix bug', headBranch: 'feat/ABC-2', event: 'pull_request', status: 'queued', createdAt: iso(5), startedAt: null }

function engine(on: any, state: { finished: boolean; repoFromFolder: boolean }, toasts: string[]) {
  on('command.register', () => ({ value: { command: 'ci-queue' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: { text: string }) => { toasts.push(e.text); return { value: undefined } })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'test' } }))
  on('clock.every', () => ({ value: undefined }))
  // No shared disk cache in tests: every pass asks the (mocked) gh again.
  on('fs.read', () => { throw new Error('ENOENT') })
  on('fs.write', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const a = e.argv.join(' ')
    let out: unknown = []
    if (a.includes('repo view')) out = state.repoFromFolder ? 'acme/app' : ''
    else if (a.includes('--status in_progress')) out = state.finished ? [GHOST] : [RUN1, GHOST]
    else if (a.includes('--status queued')) out = [RUN2]
    else if (a.includes('--status success')) out = [{ databaseId: 100 }]
    else if (a.includes('runs/100/jobs')) out = { jobs: [
      { name: 'A', status: 'completed', conclusion: 'success', started_at: iso(100), completed_at: iso(90) },
      { name: 'B', status: 'completed', conclusion: 'success', started_at: iso(100), completed_at: iso(80) },
    ] }
    else if (a.includes('runs/1/jobs')) out = { jobs: [
      { name: 'A', status: 'completed', conclusion: 'success', runner_name: 'r1', started_at: iso(10), completed_at: iso(0) },
      { name: 'B', status: state.finished ? 'completed' : 'in_progress', conclusion: state.finished ? 'failure' : null, runner_name: 'r2', started_at: iso(5), completed_at: null, steps: [] },
    ] }
    else if (a.endsWith('runs/1')) out = { status: 'completed', conclusion: 'failure', html_url: 'https://example.test', pull_requests: [{ number: 41 }] }
    const stdout = typeof out === 'string' ? out : JSON.stringify(out)
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
}

test('running with %, queue with start estimate, then a finish notice', async ($, on) => {
  const state = { finished: false, repoFromFolder: true }
  const toasts: string[] = []
  engine(on, state, toasts)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const first = await $.command.run({ command: 'ci-queue' })
  expect(first.text).toBe('CI queue (acme/app): 1 running, 1 queued.')

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // First job started 10 min ago, a run usually takes 20 min: ~10 min left,
  // so the queued run starts in ~10 min.
  expect(await ui.find({ type: 'Text', text: /~1[01] min left/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /estimated start around .*in ~1[01] min/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 stale run/ })).toBeTruthy()
  await ui.unmount()

  state.finished = true
  await $.command.run({ command: 'ci-queue' })
  expect(toasts).toEqual(['CI failed ✗ (B) — #41 · ABC-1'])
  for (const surface of ['terminal', 'desktop'] as const) {
    ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Recently finished/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /CI failed ✗ \(B\) — #41 · ABC-1/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('outside a GitHub repository, the pane asks for the repo option', async ($, on) => {
  engine(on, { finished: false, repoFromFolder: false }, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ command: 'ci-queue' })
  expect(result.text).toMatch(/set the "repo" option/)
})

test('the repo option wins over the folder', { options: { repo: 'other/repo' } }, async ($, on) => {
  engine(on, { finished: false, repoFromFolder: true }, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ command: 'ci-queue' })
  expect(result.text).toMatch(/^CI queue \(other\/repo\)/)
})
