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
| `cache-paths` | `""` | Newline-separated paths cached with `actions/cache`, such as downloaded binaries; empty skips the cache step. |
| `cache-key-files` | `pnpm-lock.yaml` | Newline-separated globs hashed into the cache key, next to the runner OS and Node.js version. |
| `extra-commands` | `""` | Multiline shell commands run after checks with `bash -euo pipefail`. |

The `checks` job stays the single required result. It succeeds only when every
Node.js job succeeds.

Services start with `docker compose up -d --wait`. After a successful start,
cleanup runs with `docker compose down -v` even if checks or extra commands
fail. Pull request titles must use Conventional Commits. See the [checks
contract](CONTRIBUTING.md#the-pnpm-run-checks-contract) and [caller
examples](CONTRIBUTING.md#shared-ci-and-maintenance-workflows).

### Renovate sync

On a pull request from a `renovate/*` branch of the same repository whose diff
changes `@antelopejs/tooling-configs`, the `renovate-sync` job installs,
runs `antelopejs-sync` (with `--profile template` when the repository's `pack`
custom property is `template`) and commits the output to the branch as
`github-actions[bot]`, so the bump pull request becomes conformant on its own.
A push made with `GITHUB_TOKEN` starts no workflow run, so the job then
dispatches the caller workflow on the branch (`gh workflow run`), which runs
`checks` on the new head. When the sync output touches `.github/workflows/**`
or `.github/actions/**`, nothing is pushed and the job fails with that reason in
its summary: the pull request stays One-tap.

The caller must therefore declare the `workflow_dispatch` trigger and grant
`contents: write` and `actions: write` to the job that calls `ci-node.yml`. The
job inherits the token permissions of its caller, so a caller that grants less
keeps working: only a bump whose sync output must be pushed fails, with the
missing permission named in the log.

```yaml
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  ci:
    permissions:
      contents: write
      actions: write
    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v1
```

The status check context of the `checks` job of `ci-node.yml` is `ci / checks`
when the caller job id is `ci`.

## Mutation testing

The reusable `mutation.yml` workflow runs incremental Stryker mutation testing
of the calling repository. The caller schedules it weekly:

```yaml
name: Mutation
on:
  schedule:
    - cron: "0 3 * * 0"
  workflow_dispatch:
permissions: {}
jobs:
  mutation:
    permissions:
      contents: read
    uses: AntelopeJS/.github/.github/workflows/mutation.yml@v1
```

It reads the repository's `tier` custom property and exits successfully without
running unless it is `N1` or `N2`. The repository provides Stryker and its
configuration. The workflow keeps the incremental file in the actions cache and
uploads the Stryker JSON report as the `mutation-report` artifact. It accepts
these optional inputs:

| Input | Default | Description |
| ----- | ------- | ----------- |
| `stryker-command` | `pnpm exec stryker run` | Command that runs Stryker; the workflow appends the incremental and JSON reporter options. |
| `report-file` | `reports/mutation/mutation.json` | Path of the JSON report to upload. |
| `incremental-file` | `reports/stryker-incremental.json` | Path of the incremental file kept in the actions cache. |
| `timeout-minutes` | `180` | Time limit of the Stryker job. |

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
