# CI metrics

`main.ts` measures the GitHub Actions CI of an organization over a window. It
prints a short table, and writes the full report as JSON with `--json`. It needs
Node.js 24 and no dependency. It prints nothing else unless it fails.

## What it reports

- CI runs (workflows named `ci` or `CI`), per repository and organization-wide,
  with the share of completed runs that were cancelled or failed.
- The median and 90th percentile wall-clock per event (`pull_request`,
  `merge_group`, `push`, `schedule`) and per tier. Per event and for the focus
  repository's pull requests, it is given over every completed run and over the
  runs that succeeded or failed, since the merge queue changes the cancel rate.
- Job-minutes per week, organization-wide, per workflow and per repository.
- For the focus repository (`dms` by default): its share of the job-minutes, the
  wall-clock of its pull request runs, the wall-clock and job-minutes of its
  `full`, `fast` and `queue` runs, and the duration of each `builder:<n>` shard.
- Small modules, meaning repositories whose median CI run takes under 5
  job-minutes: the wall-clock of their runs that went on to their checks. A run
  went on to them when it was not cancelled and its tier is not `none` or
  `draft`. When no log names its tier, its jobs decide: its lint job, or every
  Node.js job, skipped.
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
node scripts/ci-metrics/main.ts --days 14 --save ci-dataset.json --json ci-report.json \
  --repos dms,dms-saas,dms-assistant,dms-database,antelopejs,tooling-configs,interface-core,mongodb,api,dms-frontend,redis,auth-jwt,interface-auth
```

The baseline's CI figures cover these 13 repositories with 40 sampled CI runs
each, so `--repos` and the default `--sample 40` keep the CI lines comparable.
Without `--repos` they cover every repository. Job-minutes per week are always
organization-wide, as in the baseline.

A 14-day window takes a few thousand API calls. A 1-day window took under a
minute; the 14-day time is not measured yet. The script waits out the primary
and the secondary rate limits, and retries a server or network error three
times. `--to 2026-12-03` ends the window
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
