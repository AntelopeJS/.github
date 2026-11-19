# CI metrics

`main.ts` measures the GitHub Actions CI of an organization over a window. It
prints a short table, and writes the full report as JSON with `--json`. It needs
Node.js 24 and no dependency. It prints nothing else unless it fails.

## What it reports

- CI runs (workflows named `ci` or `CI`), per repository and organization-wide,
  with the share of completed runs that were cancelled or failed.
- The median and 90th percentile wall-clock per event (`pull_request`,
  `merge_group`, `push`, `schedule`) and per tier.
- Job-minutes per week, organization-wide, per workflow and per repository.
- For the focus repository (`dms` by default): its share of the job-minutes, the
  wall-clock of its pull request runs, the wall-clock and job-minutes of its
  `full`, `fast` and `queue` runs, and the duration of each `builder:<n>` shard.
- Small modules, meaning repositories whose median CI run takes under 5
  job-minutes: the wall-clock of their runs that went on to their checks.
- Queue time, the seconds each job waited for a runner.

## Method

- Wall-clock runs from a run's `run_started_at` to its `updated_at`.
- Job-minutes sum the durations, from `started_at` to `completed_at`, of the jobs
  of `jobs?filter=latest` that did not skip.
- Queue time runs from a job's `created_at` to its `started_at`.
- The tier is the `TIER` the `Tier` job's log prints, or an
  `ANTELOPEJS_CI_TIER` a log prints. A sampled run with no such line counts as
  `unknown`.
- Every workflow run of the window is listed. The jobs are read for a sample of
  each workflow of each repository: up to `--sample` completed CI runs and up
  to `--other-sample` completed runs of every other workflow, spread evenly over
  the window. A workflow's job-minutes per week are the mean of its sampled runs
  times its completed runs, over the weeks of the window. Tier, queue, shard and
  per-run figures come from the sampled runs; counts, shares and wall-clock per
  event come from every run.

## Measuring E

Run it live over the window to compare, with a token that reads the
organization's Actions (`GH_TOKEN`, `GITHUB_TOKEN`, or the `gh` login):

```sh
node scripts/ci-metrics/main.ts --days 14 --save ci-dataset.json --json ci-report.json
```

A 14-day window reads a few thousand API calls and takes about ten minutes. It
waits out the rate limit when it reaches it. `--to 2026-12-03` ends the window
at a fixed date, so a later rerun covers the same runs. `--load ci-dataset.json`
reports again from a saved dataset without the API.

The November 2026 baseline was collected before this script, into a directory
with another layout. `--baseline <dir>` reads that directory:

```sh
node scripts/ci-metrics/main.ts --baseline ~/ci-plan-2026-11/data --json baseline.json
```

## Checks

```sh
tools=$(mktemp -d)
npm install --no-save --no-audit --no-fund --silent --prefix "$tools" typescript@5.9.3 @types/node@24.10.1
"$tools/node_modules/.bin/tsc" -p scripts/ci-metrics/tsconfig.json --typeRoots "$tools/node_modules/@types"
node --test 'scripts/ci-metrics/*.test.ts'
```
