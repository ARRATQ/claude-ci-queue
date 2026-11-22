# CI queue — a Claude Code mod

A side pane in Claude Code that keeps an eye on your GitHub Actions runs while you work:

- **Running** — each run with a progress bar, **% done** and **~minutes left**, plus every job with its state (✓ ✗ ▶) and the runner it is on.
- **Queue** — waiting runs in order, how long they have waited and an **estimated start time**.
- **Recently finished** — a toast (and a system notification where your terminal supports it) when a run ends: `CI failed ✗ (Backend tests) — #41 · ABC-123`.

The status line shows `CI: 1 running · 6 queued`. The pane refreshes every minute while it is shown and every 5 minutes while it is hidden. Every Claude Code session on the machine shares one cache of GitHub answers (in `/tmp/claude-ci-queue`), so many open sessions use about as much GitHub API quota as one.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install ci-queue --marketplace ARRATQ/claude-ci-queue
```

Answer `y` to add the marketplace, then pick a scope (Enter for user).

From a shell:

```bash
claude plugin install ci-queue --marketplace ARRATQ/claude-ci-queue
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ARRATQ/claude-ci-queue`, then **Add plugin**.

## Requirements

- The [GitHub CLI](https://cli.github.com/) (`gh`), signed in with `gh auth login`, with read access to the repository's Actions.

## Use

The pane opens when a session starts. Type `/ci-queue` to reopen it and refresh at once.

By default the mod watches the GitHub repository of the session's folder. To watch another one, set the **Repository** option (`owner/name`) when installing, or later in the config menu.

## How the numbers are estimated

GitHub does not report a run's progress, so the mod estimates it:

- **% done** — each job weighs its usual duration (the median of the last 5 successful runs of the same workflow). A running job counts its elapsed time against that duration, capped at 99 % until it ends. A job never seen before counts its finished steps instead.
- **Time left** — the usual end-to-end duration of the workflow minus the time already spent (jobs running in parallel are taken into account).
- **Estimated start** — each running run frees a slot at its estimated end, and queued runs take the slots in order.

These are estimates: they drift when a run only executes some of its jobs, or when a run is re-run.

Runs stuck "in progress" for more than 12 hours (a killed runner, for instance) are ignored and counted as stale at the bottom of the pane.

## License

MIT
