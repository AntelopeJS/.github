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

## Nightly failures the merge queue missed

`nightly-main.ts` counts the nightly CI failures that the merge queue let
through, over a window of 30 days by default. The target is none in a month.
It prints a Markdown report, writes the full report as JSON with `--json`, and
saves or loads its dataset with `--save` and `--load`, like `main.ts`:

```sh
node scripts/ci-metrics/nightly-main.ts --days 30 --save nightly-dataset.json --json nightly-report.json
```

It reads every repository whose default branch has a `merge_queue` rule. For each
one it reads the completed CI runs of the `schedule` event on the default
branch from the window and the week before it. Then it reads the merge queue's
CI runs (`merge_group`) of the same period. Each job that failed in the first
attempt of a nightly of the window is a failure. The `checks` and `ubuntu` gates
count only when no other job failed. For each failure the report gives:

- the kind. A job that is `infra` either never got a runner (it lists no
  step), failed a runner setup step, or has an annotation that names billing, a
  lost runner, a full disk or a network error. Any other failed job is `test`.
- the tests, which are the failure annotations of the job, where its test
  runner reports to GitHub.
- the baseline, which is the last earlier nightly that passed the job, and the
  commits from the baseline to the nightly, from the compare API. A commit
  passed the queue when one of its `merge_group` runs succeeded, because the
  queue merges the commit it tested.
- whether it reproduces. Either a re-run of the nightly fails the job again or
  the next nightly fails it again.

These give one verdict per failure:

| verdict | when |
| --- | --- |
| `missed` | a reproduced `test` failure whose commits since the baseline all passed the queue |
| `unqueued` | a reproduced `test` failure with a commit since the baseline that has no passing queue run, such as a push that bypassed the queue or a commit from before the rollout |
| `no-new-commit` | a reproduced `test` failure on the commit the baseline passed, such as a dependency or a service that changed |
| `no-baseline` | a reproduced `test` failure with no nightly in the dataset that passed the job before |
| `flake` | a `test` failure that the next nightly and any re-run did not repeat |
| `pending` | a `test` failure that nothing repeated yet, before the next nightly |
| `infra` | an `infra` failure |

A job that keeps failing the same way, `infra` or `test`, since the same baseline
counts once, with the verdict of its first failure, which its next nightly settles. The counts are per
repository and organization-wide over the window. The daily run recomputes
them from the API, so the 30-day total needs no saved state. The report also
details the failures of each repository's latest nightly when it failed.

A run reads about four calls per repository, plus a few per failed nightly,
through the same client as `main.ts`. It fails when it finds no repository with
a merge queue, and when a repository lists more merge queue runs than the 1,000
the API returns.

## Checks

```sh
tools=$(mktemp -d)
npm install --no-save --no-audit --no-fund --silent --prefix "$tools" typescript@5.9.3 @types/node@24.10.1
"$tools/node_modules/.bin/tsc" -p scripts/ci-metrics/tsconfig.json --typeRoots "$tools/node_modules/@types"
node --test 'scripts/ci-metrics/*.test.ts'
```
