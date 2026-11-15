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
CI accepts the types `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`,
`ci`, and `chore`, with an optional scope and `!` for breaking changes.

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

Repositories call `ci-node.yml` and `stale.yml` through the same `v2` tag as
the [release workflows](#reusable-release-workflows). Call Node CI on the triggers its
[tiers](README.md#node-ci) read, with the [Renovate sync](README.md#renovate-sync)
in its own job so that only that job, and only on Renovate pull requests, holds
a write token:

```yaml
name: ci

on:
  push:
    branches:
      - next
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
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

Call `stale.yml` once a day. The actions permission lets the stale action store
its state in the actions cache:

```yaml
name: Stale issues
on:
  schedule:
    - cron: "30 1 * * *"
  workflow_dispatch:
permissions: {}
jobs:
  stale:
    permissions:
      actions: write
      issues: write
      pull-requests: write
    uses: AntelopeJS/.github/.github/workflows/stale.yml@v2
```

A repository with a [`next` branch](README.md#next-branch) calls
`next-sync.yml` on each push to `main`. The job must grant `issues: write`,
which the sync uses to open and close the conflict issue when no `NOTION_TOKEN`
secret exists:

```yaml
name: Next sync
on:
  push:
    branches:
      - main
permissions: {}
jobs:
  next-sync:
    permissions:
      issues: write
    uses: AntelopeJS/.github/.github/workflows/next-sync.yml@v2
    secrets:
      RELEASE_GITHUB_TOKEN: ${{ secrets.RELEASE_GITHUB_TOKEN }}
      NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
```

Use the shared Renovate preset in `renovate.json5`:

```json
{ "extends": ["github>AntelopeJS/.github:renovate.json5"] }
```

## Release channels

Work moves from `next` to `main` to the npm `latest` dist-tag:

| Branch | npm dist-tag | Versions | Published by |
| ------ | ------------ | -------- | ------------ |
| `next` | `next` | `0.4.3-next.161.g3f9a2c1` | every push that changes the package |
| `main` | `latest` | `0.5.0` | the release train |

Anything merged into `main` must be releasable as stable at any time.

### Reusable release workflows

Repositories call the reusable workflows of this repository,
`release-npm-public.yml` or `release-npm-private.yml`, from their own
`release.yml`. See the [caller workflow](README.md#caller-workflow).

Repositories call the shared workflows at the `v2` tag, which moves to each
merge on `main` that changes them. `v1` stays frozen for the repositories that
have not synced yet, and is deleted once the rollout is done.

### Working on `next`

1. If the repository has no `next`, set it up with
   `scripts/next-branch-setup.sh` of this repository.
2. Open the pull request against `next`.
3. After the merge, the push publishes a preview of each package it changed.
4. A repository that needs the change pins the exact preview on its own `next`
   branch, as described in [preview versions](README.md#preview-versions).

A preview writes nothing to git, so `next` keeps the version of the last stable
release in its `package.json`. Cross-repository work never waits for a stable
release or a tarball.

### Promoting `next` to stable

1. A pull request from `next` to `main` brings the work to `main` once a
   maintainer approves it. Merge it with **Squash and merge**. The Next sync
   workflow then merges `main` back into `next`, so `next` holds the release
   commits, the changelogs and the stable ranges. That merge publishes no
   preview of a package whose release changed only its version and its
   changelog.
2. Run the [release train](README.md#release-train) with `plan`. Leave out with
   `--exclude` any package that should not ship now. Its commits stay on `main`
   and the next plan includes them.
3. Run `go` once a maintainer approves the plan. Each stable run releases the
   commit the plan read, replaces the preview pins with stable ranges and
   refuses to publish a version whose `dependencies`, `peerDependencies` or
   `optionalDependencies` still hold a preview.

`next` stays: the `next history` ruleset forbids deleting it and
force-pushing to it.

The squash commit is the only commit of the cycle on `main`. The release train
reads each task's commit from the head of the promotion pull request instead,
so the changelog lists every task. Title the pull request with the highest
change type of the cycle, `feat!:` when it holds a breaking change, then
`feat:`, then `fix:`. The release level reads that title beside the tasks'
commits, so a title that is too low never releases too little. A breaking
change gives a minor release, never a major one.

### Stable fixes during a cycle

1. Open the fix against `main`. It ships with the next release train like any
   other change.
2. The Next sync workflow merges `main` into `next`, so the cycle includes the
   fix. When the merge conflicts, it files a task in the Inbox, or opens an
   issue when the repository has no `NOTION_TOKEN` secret. A repository
   admin merges `origin/main` into `next`, resolves the conflicts and pushes
   the merge commit straight to `next`, not through a pull request, which
   would squash it and bring the same conflict back.
