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
lockfile and runs `pnpm run checks`. It reads Node.js from `.nvmrc` and pnpm
from `packageManager` in `package.json`. It accepts these optional inputs:

| Input | Default | Description |
| ----- | ------- | ----------- |
| `docs-files` | `""` | Newline-separated files passed to the docs action as `files`; empty skips the step. |
| `docs-typescript-project` | `""` | TypeScript project passed to the docs action as `typescript-project`. |
| `services-compose-file` | `""` | Compose file resolving to a regular file inside the repository; empty skips services. |
| `extra-commands` | `""` | Multiline shell commands run after checks with `bash -euo pipefail`. |

Services start with `docker compose up -d --wait`. After a successful start,
cleanup runs with `docker compose down -v` even if checks or extra commands
fail. Pull request titles must use Conventional Commits. See the [checks
contract](CONTRIBUTING.md#the-pnpm-run-checks-contract) and [caller
examples](CONTRIBUTING.md#shared-ci-and-maintenance-workflows).

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
