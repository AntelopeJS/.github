# AntelopeJS organization defaults

This repository contains the public profile, community health files, issue and
pull request templates, and reusable GitHub Actions workflows shared by the
[AntelopeJS organization](https://github.com/AntelopeJS).

Repositories can override a community file when they need project-specific
guidance. Reusable workflows remain centrally maintained and are called from a
small workflow in each consuming repository.

## npm releases

Each repository that publishes an npm package has a `release.yml` workflow
that calls `release-npm-public.yml` or `release-npm-private.yml` of this
repository. npm trusted publishing checks the calling workflow file, so both
previews and stable releases run from that one `release.yml`. The event that
starts the run decides what it publishes. A caller only declares the triggers.

| Event | Branch | Publishes |
| ----- | ------ | --------- |
| `push` | any branch but the default one, normally `next` | a preview under the npm dist-tag `next` |
| `workflow_dispatch` | the default branch | a stable release under the npm dist-tag `latest` |

Any other event or branch fails the run with the reason. A release runs no
tests. The checks of the pull request that brought each commit are the gate.

### Preview versions

Every push to `next` publishes a preview of the package when the push changed
its directory. A push that left the directory alone publishes nothing and says
so in a notice. The preview version is
`<base>-next.<commit count>.g<short sha>`, such as `0.4.3-next.161.g3f9a2c1`.
The base is the patch after the current `latest` version on npm. A package that
was never published uses the version of its `package.json` without its
prerelease part. A rerun of the same commit finds the version already on npm and
publishes nothing.

A preview moves only the `next` dist-tag. `latest` stays on the last stable
release. The run writes no commit, no tag, no changelog and no GitHub release.

A dependent pins the exact preview it needs:

```sh
npm view @antelopejs/interface-database dist-tags.next
pnpm add @antelopejs/interface-database@0.5.0-next.12.g3f9a2c1 --save-exact
```

Commit that pin on the dependent's `next` branch. The release train replaces it
with a stable range when both packages are released.

### Release train

The release train publishes the stable versions of several packages once, in
dependency order. Run it from a checkout of this repository with Node.js 24 and
an authenticated `gh`:

```sh
node scripts/release-train/train.ts plan AntelopeJS/interface-database AntelopeJS/mongodb AntelopeJS/dms-database
node scripts/release-train/train.ts plan --ref next AntelopeJS/interface-database AntelopeJS/mongodb
node scripts/release-train/train.ts plan --exclude @antelopejs/mongodb AntelopeJS/interface-database AntelopeJS/mongodb
node scripts/release-train/train.ts go AntelopeJS/interface-database AntelopeJS/mongodb AntelopeJS/dms-database
```

A package is `owner/repo` or a path to a git checkout, followed by
`:<directory>` when the package is not at the repository root. The train clones
each `owner/repo` into `~/.cache/antelopejs-release-train` with blobs on demand
and fetches it again on the next run. It reads a local checkout as it is.

`plan` prints the release plan and changes nothing. It reads each package at
the head of its default branch. `--ref next` reads the `next` branch instead, so
you see what merging `next` would release. For each package it reads
`package.json`, the last stable tag reachable from that branch (the
`git.tagName` of `.release-it.json`, `v${version}` by default) and the commits
since that tag that touched the package directory. Release commits do not
count. The plan then decides each package in dependency order.

- A commit with `!` or a `BREAKING CHANGE:` footer asks for a minor release.
  `feat`, `fix`, `perf`, `refactor`, `docs`, `build`, `types` and `revert` ask
  for a patch. Other types ask for nothing. A release never changes the major
  version.
- Each preview pin moves to the stable range of the version the plan releases
  for that dependency, such as `>=0.5.0 <0.6.0`. A dependency the plan does not
  release moves to its `latest` version on npm. A pin alone makes a patch
  release.
- A package is refused when one of its preview pins has no stable version to
  move to. That happens when the dependency is left out, is refused itself, has
  no stable release, or has a stable release older than the preview's base, or
  when the pin is not an exact version. A refusal reaches every package that
  pins a preview of the refused one.
- A package with no releasable commit and no preview pin is unchanged.
- `--exclude <name>` leaves a package out of this release. It is listed under
  "Not now". Its commits stay unreleased, so the next plan includes them.

`go` takes no `--ref`. It prints the plan, then dispatches `release.yml` on the
default branch of each package to release, one at a time, with the planned
`release-version` and `dependency-ranges`. It waits for each run to finish
before it dispatches the next one, so a dependent installs a dependency that is
already published. It stops at the first run that does not succeed and names
what was published and what was not. Fix the failure and run `go` again. The
plan is read again from the tags, so the train continues where it stopped.

A stable run then does the following.

1. It refuses a `release-version` that changes the major version of the `latest`
   version on npm, or that is not greater than it.
2. It writes each range of `dependency-ranges` into every dependency field of
   `package.json` that names the package. It fails when a name is in no field.
3. It fails when `package.json` still holds a prerelease spec in
   `dependencies`, `peerDependencies`, `optionalDependencies` or
   `devDependencies`.
4. When it wrote ranges, it updates the lockfile with
   `pnpm install --no-frozen-lockfile` and commits `package.json` and the
   lockfile as `fix(deps): depend on the stable <names>`. Otherwise it installs
   with `pnpm install --frozen-lockfile`.
5. It runs `pnpm exec release-it --ci --increment=<release-version>`, which
   writes the changelog since the last stable tag, the release commit, the tag
   and the GitHub release, and publishes to npm. It never runs the
   repository's `release` script, so no tests run.

### Workflow inputs

`release-npm-public.yml` and `release-npm-private.yml` take the same inputs.

| Input | Default | Description |
| ----- | ------- | ----------- |
| `release-version` | `""` | Stable `M.m.p` version a `workflow_dispatch` run releases. The release train sets it. A preview ignores it. |
| `dependency-ranges` | `"{}"` | JSON object mapping a dependency name to the stable range that replaces its preview pin. The release train sets it. |
| `install-core` | `false` public, `true` private | Install the AntelopeJS CLI before releasing. |
| `package-directory` | `.` | Directory of the package, relative to the repository root. |

The public workflow publishes to npmjs with public access and provenance and
needs the `RELEASE_GITHUB_TOKEN` secret for a stable release. The private
workflow publishes to `https://npm.antelopejs.cloud/` and also needs
`NPM_ANTELOPE_TOKEN` for every run. Each validates that the package directory
resolves inside the repository and holds a `package.json`, and checks the
publication metadata of `package.json` before it publishes.

Runs share a concurrency group per repository, event and package directory,
and a running release is never cancelled. Previews and stable releases sit in
different groups, so a queued preview never cancels a pending stable release.

### Caller workflow

The caller is the `release.yml` of the repository. It needs both triggers and
passes both inputs:

```yaml
name: Release

on:
  push:
    branches:
      - next
  workflow_dispatch:
    inputs:
      release-version:
        description: Stable version to release, set by the release train
        required: false
        type: string
      dependency-ranges:
        description: JSON object of stable ranges that replace preview pins, set by the release train
        required: false
        default: "{}"
        type: string

permissions:
  contents: write
  id-token: write

jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@main
    with:
      release-version: ${{ inputs.release-version }}
      dependency-ranges: ${{ inputs.dependency-ranges }}
    secrets:
      RELEASE_GITHUB_TOKEN: ${{ secrets.RELEASE_GITHUB_TOKEN }}
```

A private package calls `release-npm-private.yml` and also passes
`NPM_ANTELOPE_TOKEN`, or uses `secrets: inherit`. A repository whose package is
not at its root also declares a `package-directory` input in
`workflow_dispatch`, because the release train passes it, and forwards it with
`package-directory: ${{ inputs.package-directory || 'packages/my-package' }}`.

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
| `cache-paths` | `""` | Newline-separated paths cached with `actions/cache`, such as downloaded binaries; empty skips the cache step. With `test-job`, the test job uses the cache instead of the Node.js job. With `extra-commands-job`, the extra-commands job also uses it, under its own key. On Windows, the job restores the cache a second time. Tar creates a Windows symlink as a file link when its target is not extracted yet, so the second pass, with every target present, recreates pnpm's links as directory links. |
| `cache-key-files` | `pnpm-lock.yaml` | Newline-separated globs hashed into the cache key, next to the runner OS and Node.js version. |
| `setup-commands` | `""` | Multiline shell commands run with `bash -euo pipefail` right after the root `pnpm install`, in every job, before checks, tests and `extra-commands`. Use it for installs that checks need, such as `pnpm --dir frontend-vue install --frozen-lockfile`; empty skips the step. |
| `extra-commands` | `""` | Multiline shell commands run after checks with `bash -euo pipefail`. |
| `renovate-sync` | `true` | Run the [Renovate sync](#renovate-sync) inside this workflow. Callers that call `ci-renovate-sync.yml` from their own job pass `false`. |
| `test-job` | `false` | Run `pnpm run test` in its own job, in parallel with the other checks. The `node` job sets `ANTELOPEJS_CHECKS_SKIP=test` for `pnpm run checks`. |
| `extra-commands-job` | `false` | Run `extra-commands` in their own job, in parallel with the other checks. Use it only when the commands do not read files that `pnpm run checks` writes, such as a build. |
| `extra-job-timeout-minutes` | `360` | Minutes the `extra-commands-job` job may run before GitHub cancels it. |
| `windows` | `true` | Also run the Node.js, test and extra-commands jobs on `windows-latest`, in parallel with `ubuntu-latest`. Steps and package scripts run in Git Bash, and git checks out with `core.autocrlf false` and `core.symlinks true`. The Windows jobs skip services, the pull request title check and the skill evals, so tests that need the services must not run there. A caller that cannot run on Windows passes `false` and states the reason in its workflow. |

On a pull request, the `gitleaks` job scans the commits the pull request adds,
merge commits included, with gitleaks 8.30.1 and fails on any finding. It reads
the commits between the parents of the pull request's merge ref, so base branch
commits merged into the pull request are not scanned again. It loads the
repository's `.gitleaks.toml` and skips the fingerprints listed in its
`.gitleaksignore`; both are optional. A fingerprint without its leading commit,
`<file>:<rule>:<line>`, still matches after a rebase or a squash. A finding in a
file whose merge conflict was resolved by hand is reported as `b/<file>`. The
job fails on an octopus merge, whose changes it cannot scan. On other events
the job is skipped.

The `checks` job stays the single required result. It succeeds only when every
Node.js job, every test job and every extra-commands job, if enabled, succeeds, the `gitleaks` job, if run, succeeds and the Renovate sync run by this workflow, if any, did not
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
`actions: write` and calls `ci-node.yml` without inputs keep the Renovate sync:
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
      release-version: ${{ inputs.release-version }}
      dependency-ranges: ${{ inputs.dependency-ranges }}
      package-directory: packages/dms-automation
    secrets: inherit
```

Both workflows install from the nearest directory at or above the package
directory that holds `pnpm-workspace.yaml`, or from the package directory when
there is none. pnpm validates the root lockfile and installs every workspace
project, so the released package and the workspace dependencies it links
through `workspace:*` are installed together. No `--filter` is required.
