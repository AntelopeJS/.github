# Contributing to AntelopeJS

Thank you for helping improve AntelopeJS.

## Before you start

- Search existing issues and discussions before opening a new one.
- Use an issue to discuss substantial features or behavior changes first.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

Each repository documents its prerequisites and commands in its README. Most
AntelopeJS JavaScript projects use Node.js and pnpm.

1. Fork or clone the repository.
2. Create a focused branch from the default branch.
3. Install dependencies with `pnpm install --frozen-lockfile`.
4. Make the smallest change that solves the problem.
5. Run `pnpm run checks`, the repository's complete, read-only validation gate.
6. Add or update documentation and tests when behavior changes.

Do not commit generated artifacts, credentials, or unrelated formatting
changes unless the repository explicitly requires them.

### The `pnpm run checks` contract

Every repository defines a `checks` script that runs its whole gate:
`typecheck`, `lint`, `format:check`, `knip`, `test`, `size`, `ratchet` and
`sync:check`. `size` enforces the file size limit, `ratchet` fails when recorded
debt grows, and `sync:check` fails when the files written by the
[guardrail pack](https://github.com/AntelopeJS/tooling-configs#guardrail-pack)
drift. The script must not modify files, and it exits with a non-zero status
when a check fails.

CI runs `pnpm install --frozen-lockfile` then `pnpm run checks`, plus optional
documentation checks, services, and extra commands. A green local `checks`
predicts green CI when those optional checks also pass. Node.js comes from
`.nvmrc` (`24`) unless the caller passes `node-versions`. pnpm comes from the
`packageManager` field in `package.json`.

### Guardrail pack

`@antelopejs/tooling-configs` owns the lint and format presets, the git hooks,
the `checks` scripts, `.nvmrc` and `guardrails.ratchet.json`. Run
`pnpm exec antelopejs-sync` to write them, then `pnpm install`. Do not edit
these files by hand. `sync:check` reports any difference.

### Git hooks

Do not hand-write a `lefthook.yml`; `antelopejs-sync` writes it.

- pre-commit runs `oxfmt`, `oxlint` and the size check on staged files.
- pre-push runs `typecheck`.

Tests run in CI only, through `pnpm run checks`.

### Comments

Write no comments except TSDoc (`/** */`) on public contracts and a
`SAFETY: <reason>` comment on a type assertion. Encode any other constraint in a
type, a lint rule, or a test. The `antelopejs/no-comments` lint rule enforces
this. It also accepts tool directives such as `oxlint-disable` and
`@ts-expect-error <reason>`.

### File size limit

An authored file may hold at most 20,000 bytes (about 5,000 tokens), tests
included, and at most 500 lines (`max-lines`). Generated code, fixtures,
lockfiles, `CHANGELOG.md` and Markdown are excluded. Split an oversize file by
responsibility.

Files that were already over a limit when a repository adopted the pack are
listed under `oversizeFiles` in `guardrails.ratchet.json`. This allowlist only
shrinks: a listed file may not grow past its recorded size, and no file is added
to it. `pnpm exec antelopejs-ratchet --update` lowers the recorded sizes after a
file shrinks.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit and
pull request titles, for example `fix(api): handle an empty response`.
CI accepts the types `feat`, `fix`, `refactor`, `perf`, `revert`, `docs`, `test`,
`build`, `ci`, and `chore`, with an optional scope and `!` for breaking changes.

Pull requests should:

- explain the problem and the chosen solution;
- link the relevant issue or discussion;
- call out breaking changes and migration steps;
- include evidence that the change was tested;
- remain small enough to review safely.

Maintainers may ask for changes before merging. AntelopeJS repositories
normally squash pull requests, so the pull request title becomes the commit on
the default branch.

## Shared CI and maintenance workflows

Repositories call `ci-node.yml` through the same `v2` tag as
the [release workflows](#reusable-release-workflows). Call Node CI on the triggers its
[tiers](README.md#node-ci) read, with the [Renovate sync](README.md#renovate-sync)
in its own job so that only that job, and only on Renovate pull requests, holds
a write token:

```yaml
name: ci

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  ci:
    permissions:
      contents: read
    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2
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
      statuses: write
    uses: AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v2
```

Libraries (published npm packages) pass `node-versions` listing every major
Node.js version their `package.json` `engines.node` range allows. For example,
use `node-versions: '[22, 24]'` for `engines.node: ">=22"`:

```yaml
jobs:
  ci:
    permissions:
      contents: read
    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2
    with:
      renovate-sync: false
      node-versions: '[22, 24]'
```

Applications keep the `.nvmrc` default.

Optional inputs enable documentation checks, compose services, and commands
after `checks`. See the [workflow inputs](README.md#node-ci).

`next-sync.yml` serves `cloud` alone, which merges its `develop` branch into
`next` on each push; a repository on trunk calls no sync. See
[`develop` sync](README.md#develop-sync).

Use the shared Renovate preset in `renovate.json5`:

```json
{ "extends": ["github>AntelopeJS/.github:renovate.json5"] }
```

Keep only what is specific to the repository in its `renovate.json`; the
[preset](README.md#renovate-preset) already reads the module versions of
`antelope.config.ts` and the test stacks.

A repository that commits an `antelope-lock/` folder refreshes it daily with
`module-locks-refresh.yml`, passes `module-locks: true` to `ci-node.yml` (or
runs the `module-locks-committed` action after its own install), and commits the
locks of a Renovate bump with `module-locks-renovate.yml`. See [module
locks](README.md#module-locks) for the caller jobs.

## Release channels

Work reaches the npm `next` dist-tag when a maintainer dispatches a preview,
and the `latest` dist-tag when the release train releases it. A push publishes
nothing:

| Source | npm dist-tag | Versions | Published by |
| ------ | ------------ | -------- | ------------ |
| `main` or a `work/*` branch | `next` | `0.4.3-next.161.g3f9a2c1` | a `release.yml` dispatch with `preview: true`, when the package changed since the current `next` |
| `main` | `latest` | `0.5.0` | the release train |

Anything merged into `main` must be releasable as stable at any time.

### Reusable release workflows

Repositories call the reusable workflows of this repository,
`release-npm.yml` or its wrappers `release-npm-public.yml` and
`release-npm-private.yml`, from their own `release.yml`. See the
[caller workflow](README.md#caller-workflow).

Repositories call the shared workflows at the `v2` tag, which moves to each
merge on `main` that changes them. `v1` stays frozen for the repositories that
have not synced yet, and is deleted once the rollout is done.

### Working on `main`

1. Open the pull request against `main`. To try it from another repository
   before it merges, add the `preview` label, as described in
   [pull request previews](README.md#pull-request-previews).
2. When another repository needs the change before a stable release, dispatch
   a preview from `main` after the merge, or from the `work/*` branch before
   it: `gh workflow run release.yml --ref main -f preview=true`. The merge
   itself publishes nothing.
3. The repository that needs the change pins the exact preview on its own
   `main`, as described in [preview versions](README.md#preview-versions).

A preview writes nothing to git, so `main` keeps the version of the last stable
release in its `package.json`. Cross-repository work never waits for a stable
release or a tarball.

### Releasing

1. Run the [release train](README.md#release-train) with `plan`. It reads
   `main` since the last stable tag. Leave out with `--exclude` any package
   that should not ship now. Its commits stay on `main` and the next plan
   includes them.
2. Run `go` once a maintainer approves the plan. It releases each dependency
   before the packages that pin its preview. Each stable run releases the
   commit the plan read, replaces the preview pins with stable ranges and
   refuses to publish a version whose `dependencies`, `peerDependencies` or
   `optionalDependencies` still hold a preview.

Title each pull request with its highest change type, `feat!:` when it holds a
breaking change, then `feat:`, then `fix:`. The release train reads each task's
commit from the head of its pull request, so the changelog lists every task. A
breaking change gives a minor release, never a major one.

### Stable fixes during a cycle

1. Open the fix against `main`. The merge queue squashes it onto `main` once
   the checks pass on the queued result, and it ships with the next release
   train like any other change.
