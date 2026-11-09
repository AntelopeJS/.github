# AntelopeJS organization defaults

This repository contains the public profile, community health files, issue and
pull request templates, and reusable GitHub Actions workflows shared by the
[AntelopeJS organization](https://github.com/AntelopeJS).

Repositories can override a community file when they need project-specific
guidance. Reusable workflows remain centrally maintained and are called from a
small workflow in each consuming repository.

## Private npm releases

The private npm release workflow accepts these inputs:

- `channel` (required): `latest` or `next`.
- `install-core` (optional, default `true`): install the AntelopeJS CLI before
  releasing.
- `package-directory` (optional, default `.`): a relative directory below the
  repository root containing the package to release.

Existing callers release the root package without changes. A caller releasing a
nested package can set `package-directory`, for example:

```yaml
jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-private.yml@main
    with:
      channel: ${{ inputs.channel }}
      package-directory: packages/my-private-package
    secrets: inherit
```

The workflow validates that the directory is inside the checked-out repository
and contains a `package.json`, then uses it for metadata validation, dependency
installation, and the `release-it` command. The pnpm cache is keyed on the
lockfile that governs the package: see [pnpm workspaces](#pnpm-workspaces). Git
history, tags, and GitHub release operations continue to use the checked-out
repository.

## Public npm releases

The public npm release workflow keeps existing root-package callers unchanged.
It accepts these inputs:

- `channel` (required): `latest` or `next`.
- `install-core` (optional, default `false`): install the AntelopeJS CLI before
  releasing.
- `package-directory` (optional, default `.`): a relative directory below the
  repository root containing the package to release.

To publish only a nested package, pass its directory to the reusable workflow:

```yaml
jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@main
    with:
      channel: ${{ inputs.channel }}
      package-directory: packages/interface-dms-automation
    secrets: inherit
```

The workflow validates that the directory resolves inside the checked-out
repository and contains a `package.json`. It uses that directory for metadata
validation, dependency installation, and the release command, so unrelated
root-level packages are not released. The pnpm cache is keyed on the lockfile
that governs the package, which is not always the one next to its
`package.json`: see [pnpm workspaces](#pnpm-workspaces). Public packages
continue to use npmjs with public access and provenance.

## Node CI

The reusable `ci-node.yml` workflow installs dependencies with the frozen
lockfile and runs `pnpm run checks`. By default, it reads Node.js from `.nvmrc`.
Callers can pass `node-versions` to check several versions. It reads pnpm from
`packageManager` in `package.json`. It accepts these optional inputs:

| Input | Default | Description |
| ----- | ------- | ----------- |
| `node-versions` | `""` | JSON array of Node.js versions; each runs checks in its own job. Empty uses `.nvmrc`. |
| `docs-files` | `""` | Newline-separated files passed to the docs action as `files`; empty skips the step. |
| `docs-typescript-project` | `""` | TypeScript project passed to the docs action as `typescript-project`. |
| `services-compose-file` | `""` | Compose file resolving to a regular file inside the repository; empty skips services. |
| `cache-paths` | `""` | Newline-separated paths cached with `actions/cache`, such as downloaded binaries; empty skips the cache step. With `test-job`, only the test job uses the cache. |
| `cache-key-files` | `pnpm-lock.yaml` | Newline-separated globs hashed into the cache key, next to the runner OS and Node.js version. |
| `extra-commands` | `""` | Multiline shell commands run after checks with `bash -euo pipefail`. |
| `renovate-sync` | `true` | Run the [Renovate sync](#renovate-sync) inside this workflow. Callers that call `ci-renovate-sync.yml` from their own job pass `false`. |
| `test-job` | `false` | Run `pnpm run test` in its own job, in parallel with the other checks. The `node` job sets `ANTELOPEJS_CHECKS_SKIP=test` for `pnpm run checks`. |
| `extra-commands-job` | `false` | Run `extra-commands` in their own job, in parallel with the other checks. Use it only when the commands do not read files that `pnpm run checks` writes, such as a build. |

The `checks` job stays the single required result. It succeeds only when every
Node.js job, every test job and every extra-commands job, if enabled, succeeds and the Renovate sync run by this workflow, if any, did not
fail or get cancelled.

Services start with `docker compose up -d --wait`. With `test-job` and no `extra-commands` in the Node.js job, the Node.js job does not start them. After a successful start,
cleanup runs with `docker compose down -v` even if checks or extra commands
fail. Pull request titles must use Conventional Commits. See the [checks
contract](CONTRIBUTING.md#the-pnpm-run-checks-contract) and [caller
examples](CONTRIBUTING.md#shared-ci-and-maintenance-workflows).

### Renovate sync

The reusable `ci-renovate-sync.yml` workflow takes no inputs. On a pull request
from a `renovate/*` branch of the same repository whose diff changes
`@antelopejs/tooling-configs`, its `renovate-sync` job installs, runs
`antelopejs-sync` (with `--profile template` when the repository's `pack`
custom property is `template`) and commits the output to the branch as
`github-actions[bot]`, so the bump pull request becomes conformant on its own.
A push made with `GITHUB_TOKEN` starts no workflow run, so the job then
dispatches the caller workflow on the branch (`gh workflow run`), which runs
`checks` on the new head. When the sync output touches `.github/workflows/**`
or `.github/actions/**`, nothing is pushed and the job fails with that reason in
its summary: the pull request stays One-tap. On any other event the job is
skipped.

The workflow declares no permissions: it inherits the token permissions of the
job that calls it, so a caller that grants less keeps working and only a bump
whose sync output must be pushed fails, with the missing permission named in the
log. Call it from its own job, next to `ci-node.yml` with
`renovate-sync: false`, so that only that job holds `contents: write` and
`actions: write`, and only on Renovate pull requests. The caller must declare
the `workflow_dispatch` trigger:

```yaml
name: ci

on:
  push:
    branches:
      - main
      - next
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  ci:
    permissions:
      contents: read
    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v1
    with:
      renovate-sync: false
  renovate-sync:
    if: >-
      github.event_name == 'pull_request'
      && startsWith(github.head_ref, 'renovate/')
      && github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      actions: write
    uses: AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v1
```

A sync failure then shows on `renovate-sync / Renovate sync` rather than on
`ci / checks`. The bump stays gated: `pnpm run checks` runs `sync:check`, so a
head whose sync output was not applied fails `ci / checks`, and a head pushed
without a successful dispatch has no `ci / checks` at all.

Callers still on a single `ci` job that grants `contents: write` and
`actions: write` and calls `ci-node.yml` without inputs keep working unchanged:
`ci-node.yml` runs the same sync as a nested call of `ci-renovate-sync.yml`, and
its failure or cancellation still fails `ci / checks`.

The status check context of the `checks` job of `ci-node.yml` is `ci / checks`
when the caller job id is `ci`.

## Module locks update

A repository that commits `antelope-lock/` installs each npm module from its
recorded lock, so a module and its dependencies move only when the locks are
recorded again. Renovate cannot do that: it does not read `antelope-lock/`, and
the hosted Renovate app runs no `ajs` command. The reusable
`modules-update.yml` workflow records the locks again and opens or updates one
pull request per base branch, from the `antelopejs/modules-update/<base>`
branch.

It accepts these inputs and one secret:

| Input | Default | Description |
| ----- | ------- | ----------- |
| `refresh-command` | `pnpm exec ajs project modules update` | Shell command, run with `bash -euo pipefail` after `pnpm install --frozen-lockfile`, that records every lock again. |
| `base` | `""` | Branch whose locks are refreshed and that the pull request targets. Empty uses the branch the run started on. |
| `weekday` | `1` | Day of the week, 1 for Monday to 7 for Sunday in UTC, on which a scheduled run refreshes the locks. |
| `ci-workflow` | `ci.yml` | Workflow file dispatched on the branch after a push made with the default token. |
| `token` (secret) | `GITHUB_TOKEN` | Token that pushes the branch and opens the pull request. |

A project passes no input: `ajs project modules update` moves each npm module
to its latest version in `antelope.config.ts`, then records every lock again.
A module records its locks while its tests install the modules of its test
configuration, so it passes `rm -rf antelope-lock && pnpm run test`: each range
then resolves to its latest version.

Every run first reads every package version in `antelope-lock/` and asks the
npm advisory API for the advisories that affect them. A manual run and a
scheduled run on `weekday` refresh the locks. A scheduled run on any other day
refreshes them only when an advisory appeared since the last successful run on
the same base, so call the workflow once a day. A failed run leaves the
advisory new, and the next day retries it.

When nothing changed, the run ends. It closes the open pull request if the base
branch already holds the same locks. Otherwise it commits `antelope-lock/` and
`antelope.config.ts`, and nothing else. The pull request body lists the modules
that moved and from which version to which, the direct dependencies of each
module that moved, and the advisories the change fixes or leaves.

When the refresh command fails after recording as many locks for every module
as the base holds, the pull request still opens with a warning, so its checks
show the failure. When it records fewer, or changes no lock, the run fails,
pushes nothing and leaves the open pull request alone.

A push made with `GITHUB_TOKEN` starts no workflow run. So after it pushes, the
workflow dispatches `ci-workflow` on the branch, which runs `checks` on the new
head. With a `token` secret, the push starts the pull request checks itself and
nothing is dispatched. GitHub Actions can open a pull request with
`GITHUB_TOKEN` only when the repository allows GitHub Actions to create pull
requests. Otherwise pass a `token` that may open them. When neither works, the
branch is pushed and the run fails with a link to open the pull request by hand.
See the [caller example](CONTRIBUTING.md#shared-ci-and-maintenance-workflows).

## Link rot

`link-rot.yml` runs weekly in this repository, and on demand by
`workflow_dispatch`. It checks the external links of `README.md` and `docs/**`
of every public, non-archived repository of the organization whose `pack`
custom property is not `none`, with lychee. Dead links never fail the run; only
a crash does. Links to npmjs.com are skipped because it rejects automated
requests. The run uploads one JSON artifact, `link-rot`, keyed by repository
and file.

## Stale issues

The reusable `stale.yml` workflow takes no inputs. Call it once a day with job
permissions `actions: write`, `issues: write`, and `pull-requests: write`.
Issues become stale after 60 inactive days and close after 30 more; the
`pending` label exempts issues. Pull requests never become stale. See the [daily
caller example](CONTRIBUTING.md#shared-ci-and-maintenance-workflows).

## Issue triage labels

The bug and feature issue forms apply `bug` or `feature`, plus `needs-triage`.
The reusable `triage.yml` workflow takes no inputs. Call it on `issues: opened`
with the job permission `issues: write`. It creates `bug`, `feature`, and
`needs-triage` in the repository when they are missing, then adds
`needs-triage` to the new issue, so issues opened without a form, through the
API or the CLI, are labelled too. GitHub drops a form label that does not exist
yet, so the first form issue in a repository may miss `bug` or `feature`. See
the [caller example](CONTRIBUTING.md#shared-ci-and-maintenance-workflows).

## pnpm workspaces

Before configuring the pnpm cache, both workflows resolve the lockfile that
governs the package: `<package-directory>/pnpm-lock.yaml` when that file
exists, otherwise the nearest `pnpm-lock.yaml` found while walking up to the
repository root. The release fails with an explicit message when no lockfile is
found between the package directory and the repository root.

In a pnpm workspace the lockfile lives at the repository root, so a caller
releasing a package below `packages/` needs no extra input:

```yaml
jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@main
    with:
      channel: ${{ inputs.channel }}
      package-directory: packages/dms-automation
    secrets: inherit
```

`pnpm install --frozen-lockfile` still runs from the package directory. In a
workspace, pnpm walks up to `pnpm-workspace.yaml`, validates the root lockfile,
and installs every workspace project, so the released package and the workspace
dependencies it links through `workspace:*` are installed together; no
`--filter` is required.
