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
repository. Both are thin wrappers of `release-npm.yml`, the one release
workflow, which a caller may call directly with a `registry` input. npm trusted
publishing checks the calling workflow file, so previews and stable releases
run from that one `release.yml`. The event that
starts the run decides what it publishes. A caller only declares the triggers.

| Event | Branch | Publishes |
| ----- | ------ | --------- |
| `push` | the default branch | a preview under the npm dist-tag `next` |
| `pull_request` | a pull request with the `preview` label | a pull request preview: a [pkg.pr.new](https://pkg.pr.new) package for a public package, the dist-tag `pr-<number>` on `https://npm.antelopejs.cloud/` for a private one |
| `workflow_dispatch` | the default branch | a stable release under the npm dist-tag `latest`, or nothing without `release-version` |

A push to another branch, `next` included, skips the job, so a caller that
still triggers on `next` stays green and publishes nothing. Any other event
fails the run with the reason. Anyone allowed to run
the workflow can dispatch a stable release with any `release-version` above
`latest` in the same major. The release train is the way to start one, not a
guard against starting one by hand. A release runs no tests. The checks of the pull request that brought each commit are the gate.

A push to the default branch and a stable run use the `npm-publish` environment
of the repository. Its deployment branches need only the default branch. A pull
request preview run uses no environment, because the branch policy of the
environment allows only the default branch. A private pull request preview reads
`NPM_ANTELOPE_TOKEN` as an organization secret.

### Preview versions

Every push to the default branch publishes a preview of the package when its
directory changed since the commit of the current `next` preview, read from npm
as its `gitHead`. A change to the changelog, or to the `version` field of
`package.json`, does not count. The changelog is the `output` of
`changelogen.config.json`, or `CHANGELOG.md`. So the release commit of a
release that changed only the version and the changelog publishes no preview.
Neither does a change to
`pnpm-lock.yaml`, which no package ships, or a change inside a nested directory
that holds its own `.release-it.json`, which is another released package. A
release that wrote stable ranges changes `dependencies` too, so its release
commit publishes one preview that holds the stable ranges. A package that
changed nothing it ships publishes nothing and says so in a
notice. A push whose run GitHub dropped from the queue is still covered
by the next run. The preview version is
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
pnpm add @antelopejs/interface-database@0.4.3-next.161.g3f9a2c1 --save-exact
```

Merge that pin into the default branch of the dependent. The release train
releases the dependency first, then rewrites the range of the pin when it
releases the dependent.

### Pull request previews

A pull request that carries the `preview` label publishes a preview of the
package. It runs when the label is added and on each push to the pull request.
Adding another label to a labeled pull request does not run it. It builds the
head commit of the pull request, not the merge commit, and records that commit
as the `gitHead`.

The version is `0.0.0-pr.<number>.<commit count>.g<short sha>`, such as
`0.0.0-pr.12.161.g3f9a2c1`. It sorts below every release and every `next`
preview, so no range and no update tool picks it in their place. Unlike a
`next` preview, it publishes whether or not the package changed. A rerun of a
private preview finds the version already on the registry and publishes
nothing. A rerun of a public one publishes it to pkg.pr.new again.

A public package publishes through [pkg.pr.new](https://pkg.pr.new), which
comments the install commands on the pull request and updates that comment on
each push. The pkg.pr.new GitHub App must be installed on the repository. It
needs no token scope. The run installs `pkg-pr-new@0.0.94` and calls it with
`--pnpm`, so that each `workspace:` and `catalog:` spec resolves.

A private package publishes to `https://npm.antelopejs.cloud/` under the
dist-tag `pr-<number>`, such as `pr-12`:

```sh
pnpm add @antelopejs-private/my-package@pr-12
```

A pull request preview never moves `latest` or `next`. It pins no workspace
sibling, because `pnpm pack` writes each `workspace:` spec as the range in the
`package.json` of the sibling. A preview that needs an unreleased change of a
sibling does not get it. A pull request from a fork gets no secrets, so the
credentials check fails a private preview of it.

### Release train

The release train publishes the stable versions of several packages once, in
dependency order. Run it from a checkout of this repository with Node.js 24 and
an authenticated `gh`:

```sh
node scripts/release-train/train.ts plan AntelopeJS/interface-database AntelopeJS/mongodb AntelopeJS/dms-database
node scripts/release-train/train.ts plan --exclude @antelopejs/mongodb AntelopeJS/interface-database AntelopeJS/mongodb
node scripts/release-train/train.ts go AntelopeJS/interface-database AntelopeJS/mongodb AntelopeJS/dms-database
node scripts/release-train/train.ts plan AntelopeJS/dms-saas
```

A package is `owner/repo` or a path to a git checkout, followed by
`:<directory>` when the package is not at the repository root. A workspace
root whose `package.json` has no name or version is not a package. The train
reads it as every directory under it that holds a `package.json` beside a
`.release-it.json`, such as `packages/dms-saas` and
`packages/interface-dms-saas` for `AntelopeJS/dms-saas`. The train clones
each `owner/repo` into `~/.cache/antelopejs-release-train` with blobs on demand
and fetches it again on the next run. It reads a local checkout as it is.

`plan` prints the release plan and changes nothing. It reads each package at
the head of its default branch, `main`, which holds every stable tag. Neither
`plan` nor `go` takes a `--ref`. For each package the plan reads
`package.json`, the last stable tag the default branch holds (the
`git.tagName` of `.release-it.json`, `v${version}` by default), and the
commits since that tag that touched the package directory. A tag above the
version of `package.json`, such as an accidental major release, is never the
stable tag. When every tag is above that version, the plan stops and names
them. The plan does not read npm, so it cannot see a stable version that npm
holds without a tag. Release commits do not count, and neither do the
`fix(deps): depend on the stable` commits of a stable run. A merge commit
counts by its title. A directory inside the package that holds another listed
package does not count either, so a root package beside `packages/*` gets
only its own commits. Each numbered line of the plan names the repository and
the commit it read, such as `AntelopeJS/mongodb@3f9a2c1`.

The merge queue lands each pull request on the default branch as one squash
commit, so the plan lists the commits of the cycle instead. It reads the last
100 pull requests merged into the default branch. A pull request merged since
the stable tag gives the commits of its head, in place of its squash commit.
The heads of the pull requests merged before the tag mark where the cycle
starts, so a branch that brought a released pull request and then another one
gives only its new commits. A pull request whose head the checkout lacks, such as a person's branch deleted after the
merge, a reused branch name or a fork's branch, keeps its squash commit. When the checkout has that branch as
`origin/<branch>` and GitHub's branch still holds the head, the checkout is
stale, and the plan stops and asks to fetch it. The plan also stops when
GitHub cannot answer that question for a reason other than a 404. The train
never fetches a missing head, not even in its partial clone. A merge commit
inside a pull request's head, such as a merge of the default branch into its
branch, does not count, and neither does a release commit. When no pull
request was merged, the plan lists the default branch's commits. When
`gh pr list` fails, the plan stops, because the squash commits alone could
release a breaking cycle as a patch. The plan then decides each package in
dependency order.

- A commit with `!` or a `BREAKING CHANGE:` footer asks for a minor release.
  `feat`, `fix`, `perf`, `refactor`, `types` and `revert` ask for a patch.
  Tooling types (`build`, `ci`, `chore`, `test`, `docs`, `style`) and other
  types ask for nothing. The level is the highest one over the default
  branch's commits and the cycle's commits, so a squash commit titled below
  the commits of its pull request still releases at their level. A squash
  commit counts by its title as well, unless its own pull request holds a
  reverted commit that asks for at least that level, as when the title was
  written from every commit of the branch. It then counts through the
  commits left. A release never changes the major version.
- A commit whose message holds `This reverts commit <sha>` or
  `Reverts <owner>/<repo>#<n>`, as a squash merge of a revert pull request
  writes it, counts for nothing when the commit it reverts is in the same
  range, and that commit counts for nothing too. Neither sets the level or
  shows in the notes, and the tasks of their two pull requests do not either.
  A revert of a revert leaves the first commit counted. A revert of a commit
  older than the last stable tag counts as a change.
- A package whose commits ask for nothing still gets a patch when its
  `dependencies`, `peerDependencies` or `optionalDependencies` hold a spec
  that differs from the `package.json` of its last stable tag, which npm
  published. It also gets a patch when a listed sibling's
  release moves the range a `workspace:` spec packs to outside the range the
  package's own last stable release packed, read from the sibling's
  `package.json` at that tag, such as
  `moves dependencies @antelopejs/interface-dms-saas ^0.10.0 -> ^0.11.0`, and
  when a listed package pins a preview of it in `dependencies`,
  `peerDependencies` or `optionalDependencies` that is newer than its last
  stable release. The plan names each change and each pin. Otherwise the plan
  lists the package as unchanged with the types of its commits, such as
  `only build commits since 0.4.2`. Those commits stay in the cycle, so the
  release notes of the next release list them.
- The default branch may pin a preview of another listed package, the
  `<base>-next.<commit count>.g<short sha>` version that a push to the
  default branch of that package published, such as
  `0.4.3-next.161.g3f9a2c1`. Each preview pin moves to the stable range of
  the version its dependency gets, such as `>=0.5.0 <0.6.0`. That is the
  version the plan releases, or the last stable release of a dependency the
  plan leaves unchanged. The dependency must be one of the listed packages. A pin in
  `dependencies`, `peerDependencies` or `optionalDependencies` alone makes a
  patch release. A `devDependencies` pin alone makes no release, since npm
  does not install it. The plan lists the package as
  `repins devDependencies, publishes nothing` with each pin and its range,
  and `go` commits the ranges without a release.
- A pin moves only to a stable release that holds the pinned code. The last
  part of a preview version, `g<short sha>`, names its commit. A dependency the
  plan releases must contain that commit at the head of its default branch. A
  dependency the plan leaves unchanged must contain it at its last stable tag,
  so a hotfix release that lacks the commit refuses the pin. That tag settles
  it even when the preview's base is above it. That is the case of the preview
  a release commit publishes. A pin of `1.2.5-next.40.g<sha>` moves to
  `>=1.2.4 <1.3.0` when the tag of 1.2.4 holds the commit. A ref contains
  the commit when the commit is an ancestor of it. A squash merge keeps the
  commits of a pull request only in its head, so the train also looks in the
  merged pull requests. It reads the last 100 pull requests merged into the
  default branch, newest first. One counts when the ref holds its merge commit
  and its head contains the pinned commit. A failed comparison counts as not
  found.
- A package is refused when a spec in `dependencies`, `peerDependencies` or
  `optionalDependencies` does not resolve from the registry, such as a path,
  `file:`, `link:`, `catalog:`, git, tarball or dist-tag spec. Only a semver
  range, or an `npm:` alias to one, resolves from the registry.
- A `workspace:` spec in those fields names a sibling, which the stable run
  packs to a registry range with `pnpm pack`. The plan shows that range, such
  as `@antelopejs/interface-dms-saas workspace:^ -> ^0.11.0`, from the version
  the plan releases for the sibling or its last stable release. `workspace:*`
  packs to that exact version, and `workspace:^` and `workspace:~` to a caret
  or tilde range on it. The package is refused when the sibling is not listed
  from the same repository, is refused itself, has no stable release, or keeps
  a `package.json` version other than its last stable release while the plan
  does not release it. Any other `workspace:` form is refused too, such as
  `workspace:^0.10.0`, which the plan cannot check against the sibling's
  version, a path or an alias.
- A package is refused when one of those fields names a sibling listed from
  the same repository with anything but a `workspace:` spec, such as
  `>=0.4.0 <0.5.0`. Such a range stays behind when the sibling releases, so
  name the sibling as `workspace:^`. The stable run refuses it too, for any
  package of the checkout that has a `.release-it.json` beside its
  `package.json`.
- A package is refused when a preview pin in `dependencies`,
  `peerDependencies` or `optionalDependencies` cannot move. That happens when
  the dependency is not listed, is left out, is refused itself, has no stable
  release, is released by the plan at a version older than the preview's base,
  or does not hold the pinned commit. It also happens when the pin is not an exact version
  or names no commit. A refusal reaches every package that pins a preview of
  the refused one in those fields.
- A `devDependencies` preview never blocks a release. It moves like any other
  pin when it can. Otherwise the package keeps it, and the plan gives the
  reason on a line such as
  `keeps devDependency @antelopejs/a@0.1.1-next.1.gabc1234, which releases after it`.
- The order follows `dependencies`, `peerDependencies`,
  `optionalDependencies` and the `devDependencies` that pin a preview. When
  they form a cycle, the plan orders its packages again on the first three
  fields alone. A cycle that remains is refused, and the plan names its
  packages. A left-out package is never part of a cycle.
- A package with no releasable commit, no preview pin to move, no change to its
  runtime dependencies and no dependent that pins a newer preview of it is
  unchanged.
- `--exclude <name>` leaves a package out of this release. It is listed under
  "Not now". Its commits stay unreleased, so the next plan includes them.

`go` prints the plan, then dispatches `release.yml` on the
default branch of each package to release, one at a time, with the planned
`release-version`, `release-commit` and `dependency-ranges`, plus
`package-directory` for a package not at the root. Those are the only inputs a
caller declares. A package the plan repins gets no `release-version`, so its
run commits the ranges and publishes nothing. It waits for each
run to finish before it dispatches the next one. npm can serve a version
minutes after `npm publish` returned, so when a package left to run
depends on the one just released, `go` also polls `npm view <name>@<version>`
every 15 seconds until npm serves it, then dispatches the dependent. After the
last one it prints what it published, what it repinned and, when the plan
refused a package, what it did not publish.

`go` stops at the first release that does not succeed. A dispatch that GitHub
refused published nothing, and so did a repin run. For a release run that
concluded with anything but success, `go` asks npm with `npm view <name>@<version>` whether it holds the
version. When npm does not, nothing was published. When it does, the run
failed after the publish, and `go` lists the package as published. Run `go`
again: the plan still lacks its tag, so the stable run writes the release
commit, the tag and the GitHub release without publishing again. When the tag
exists, only the GitHub release is missing. A run whose end `go` cannot see is
unknown. That happens when no run appears after the dispatch, when
`gh run view` fails more than 8 times in a row, 15 seconds apart, or when
`npm view` fails. The stop message lists what was published, what was not,
and the unknown package with its run. Check an unknown run before you run `go`
again. `go` also stops when npm does not serve a release within 20 minutes:
the release is published, and its dependents are not. Run `go` again once
`npm view` prints the version. After a failure, fix it and run `go` again. The plan is read again from
the tags, so the train continues where it stopped.

A stable or repin run commits to the default branch of its repository. So
after each run, when the rest of the plan holds another package of the same
repository, `go` reads the plan again. It goes on from the new head when the
packages, versions and ranges left to release are the same. It stops when they
changed, and when the repository did not move, which happens with a local
checkout, read as it is. Fetch it, then run `go` again.

A stable run then does the following.

1. It refuses to release when the branch moved past `release-commit`, the
   commit the plan read. Run the release train again to plan the new commits.
2. It refuses a `release-version` that changes the major version of the `latest`
   version on npm, or that is lower than it. When `release-version` is the
   `latest` version and its tag is missing, an earlier run published it and
   then failed, so this run resumes that release without publishing it again.
   It resumes only when npm's `gitHead` for that version is `release-commit`,
   so the tag lands on the code npm holds. It refuses when the tag exists.
3. It fails when a value of `dependency-ranges` is not a stable semver range.
   It writes each range into the dependency fields of `package.json` where
   that name holds a preview. A stable spec of the same name in another field
   stays as it is. It fails when no field holds a preview of the name.
4. It fails when `dependencies`, `peerDependencies` or `optionalDependencies`
   still hold a prerelease spec, or a spec that does not resolve from the
   registry other than `workspace:`. A `devDependencies` preview gives a
   warning and stays.
5. When it wrote ranges, it updates the lockfile with
   `pnpm install --no-frozen-lockfile` and stages `package.json` and the
   lockfile, so the release commit holds them and npm records `release-commit`
   as the `gitHead` of the version. Otherwise it installs with
   `pnpm install --frozen-lockfile`.
6. It writes the release notes of the cycle in changelogen's format: the
   compare link, one line per task with one block per commit type and the
   oldest first, the breaking changes and the contributors. It reads the tasks
   the way the plan does, from the heads of the pull requests merged into the
   default branch since the last stable tag (`gh pr list` with
   `RELEASE_GITHUB_TOKEN`), and fails when `gh` fails. It leaves out a revert
   and the commit it reverts, with the tasks of their pull requests, as the
   plan does. A subject that is not conventional is left out. When the release writes stable ranges, the notes
   also list `Depend on the stable <names>` under Fixes. It writes them under a
   `## v<version>` heading on top of the changelog, the `output` of
   `changelogen.config.json` or `CHANGELOG.md`, and stages it. It writes a
   release-it config from the repository's `.release-it.json`, without the
   `release-it-changelogen` plugin and with the notes as the GitHub release
   notes.
7. It runs `pnpm exec release-it --ci --verbose --increment=<release-version>`
   with that config. `--verbose` prints the stdout and stderr of every hook,
   so the log of a failed hook shows why it failed. release-it bumps
   `package.json`. In place of release-it's own
   `npm publish`, a `before:npm:release` hook packs the package with
   `pnpm pack`, which resolves each `workspace:` and `catalog:` spec, and
   publishes the tarball under `latest`, as a preview does under `next`. The
   hook refuses a tarball whose `dependencies`, `peerDependencies` or
   `optionalDependencies` still hold a spec that resolves only inside the
   repository, and records `release-commit` as its `gitHead`. release-it then
   writes the release commit with the changelog, the tag and the GitHub
   release. A resumed run, and a package whose `.release-it.json` sets
   `npm.publish` to `false` because it publishes itself, get no hook. It never
   runs the repository's `release` script, so no tests run.

A dispatch without `release-version` is a repin run. It needs `release-commit`
and refuses a branch that moved past it, like a stable run. It refuses a
`dependency-ranges` that is empty or names a preview in `dependencies`,
`peerDependencies` or `optionalDependencies`, which only a release may move.
It writes the ranges into `package.json` as step 3 does, updates the lockfile
with `pnpm install --lockfile-only`, pushes the same
`fix(deps): depend on the stable <names>` commit to the default branch, and
publishes nothing. The plan and the release
notes skip that commit, so it releases nothing by itself.

### Workflow inputs

`release-npm.yml` holds the one release job, and a caller may call it directly.
`release-npm-public.yml` and `release-npm-private.yml` stay as thin wrappers:
each takes the same inputs but `registry`, and forwards them to
`release-npm.yml` with `registry` set to `public` or `private`. The registry
picks the npm registry, the scope and `publishConfig` that the metadata check
asks for, and whether `NPM_ANTELOPE_TOKEN` is required. A caller of a wrapper
keeps working unchanged.

| Input | Default | Description |
| ----- | ------- | ----------- |
| `registry` | required | `public` publishes to npmjs with provenance, `private` to `https://npm.antelopejs.cloud/` with `NPM_ANTELOPE_TOKEN`. Only `release-npm.yml` takes it. |
| `release-version` | `""` | Stable `M.m.p` version a `workflow_dispatch` run releases. The release train sets it. Empty, a dispatch only moves `devDependencies` pins. A preview ignores it. |
| `release-commit` | `""` | Commit SHA a `workflow_dispatch` run releases, 40 hexadecimal characters. The release train sets it to the commit it planned. A stable run fails when the branch moved past it. A preview ignores it. |
| `dependency-ranges` | `"{}"` | JSON object mapping a dependency name to the stable range that replaces its preview pin. The release train sets it. |
| `install-core` | `false`, and `true` for `release-npm-private.yml` | Install the AntelopeJS CLI before releasing. |
| `package-directory` | `.` | Directory of the package, relative to the repository root. |
| `integration-branch` | none | Unused. Only the two wrappers declare it, so that a caller that passes it keeps working. |

Both registries need the `RELEASE_GITHUB_TOKEN` secret for a stable or repin
run. The `public` registry publishes to npmjs with public access and
provenance. The `private` registry publishes to `https://npm.antelopejs.cloud/`
and also needs `NPM_ANTELOPE_TOKEN` for every run. Each validates that the
package directory resolves inside the repository and holds a `package.json`,
and checks the publication metadata of `package.json` before it publishes. Among them,
`repository.url` must name the calling repository, and a package npm already
holds must name it in its own `repository.url` too.

Both registries write to the repository only with `RELEASE_GITHUB_TOKEN`, so
the job holds `contents: read`, and a public one also `id-token: write` for npm
trusted publishing. Each wrapper grants these to its call of `release-npm.yml`,
which declares no permissions and so holds exactly that grant. A caller of
`release-npm.yml` grants the job `contents: read`, plus `id-token: write` for
`registry: public`. A private caller grants no `id-token`, and the job never
asks for it.

Runs share a concurrency group per repository, event, pull request and package
directory. A running release is never cancelled, except a pull request preview,
which a newer run of the same pull request cancels. Previews and stable
releases sit in different groups, so a queued preview never cancels a pending
stable release.

### What a caller declares

`antelopejs-sync` of `@antelopejs/tooling-configs` 0.8.5 writes this caller,
and the shared workflows at `@v2` work with it unchanged.

- **File.** `.github/workflows/release.yml`. npm trusted publishing names this
  file, and the release train dispatches it.
- **Triggers.** `push` to the default branch for previews, and
  `workflow_dispatch` for stable releases. A caller that adds `pull_request`
  with the types `opened`, `synchronize`, `reopened` and `labeled` publishes a
  [pull request preview](#pull-request-previews) for each pull request that
  carries the `preview` label.
- **Dispatch inputs.** `release-version`, `release-commit` and
  `dependency-ranges` (default `"{}"`), all optional strings that the release
  train sets. A repository whose package is not at its root adds
  `package-directory`. A repository with several packages has one job per
  package, and a dispatch runs only the job whose `package-directory` it names.
  The release train sends nothing else.
- **Permissions.** `contents: write`, and `id-token: write` when a package is
  public. The release jobs ask only `contents: read`, because they write with
  `RELEASE_GITHUB_TOKEN`.
- **Optional inputs.** Every other input of the shared workflows has a default
  that fits this caller. A caller may set `install-core`.
- **Secrets.** `RELEASE_GITHUB_TOKEN` for the public workflow, plus
  `NPM_ANTELOPE_TOKEN` for the private one, each passed by name.
- **Call.** `release-npm-public.yml@v2` or `release-npm-private.yml@v2`, with
  each dispatch input passed through under the same name. `release-npm.yml@v2`
  takes the same call with `registry: public` or `registry: private`.
- **Repository setting.** The `npm-publish` environment allows the default
  branch.

### Caller workflow

The caller is the `release.yml` of the repository. It needs both triggers and
passes the inputs the release train sets:

```yaml
name: Release

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      release-version:
        description: Stable version to release, set by the release train
        required: false
        type: string
      release-commit:
        description: Commit SHA to release, set by the release train
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
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@v2
    with:
      release-version: ${{ inputs.release-version }}
      release-commit: ${{ inputs.release-commit }}
      dependency-ranges: ${{ inputs.dependency-ranges }}
    secrets:
      RELEASE_GITHUB_TOKEN: ${{ secrets.RELEASE_GITHUB_TOKEN }}
```

A private package calls `release-npm-private.yml` and also passes
`NPM_ANTELOPE_TOKEN: ${{ secrets.NPM_ANTELOPE_TOKEN }}`. The caller grants
`id-token: write` only when one of its packages is public. A caller may call
`release-npm.yml@v2` instead of a wrapper, with `registry: public` or
`registry: private` under `with:`, and grants the job `contents: read` plus
`id-token: write` for `public`. A repository whose
package is not at its root also declares an optional `package-directory` input
in `workflow_dispatch`, because the release train passes it, and forwards it
with `package-directory: ${{ inputs.package-directory || 'packages/my-package' }}`.
A repository with several packages has one job per package, which forwards its
own directory and runs on a push or on a dispatch that names it, as in
[pnpm workspaces](#pnpm-workspaces).

Callers use `@v2`. `v1` keeps the previous interface.

## Node CI

The reusable `ci-node.yml` workflow installs dependencies with the frozen
lockfile, runs `pnpm run checks`, then `pnpm run test`. By default, it reads
Node.js from `.nvmrc`. Callers can pass `node-versions` to check several
versions. It reads pnpm from `packageManager` in `package.json`.

Each job picks how much to run from the event, so a caller only declares the
triggers: `pull_request`, `merge_group` for the merge queue, a nightly
`schedule` and `workflow_dispatch`. The diff base is the commit the change is
compared with.

| Event | Tier | Diff base | Jobs |
| ----- | ---- | --------- | ---- |
| Pull request with the `ci:full` label, from a repository whose `CI_SELECTION` variable is `full`, or that changes a root file | `full` | the pull request base | the Node.js jobs and the tests |
| Any other pull request, draft or ready, into any branch | `fast` | the pull request base | the Node.js jobs and the tests. A pull request that changes only documentation skips the tests. |
| `merge_group` | `queue` | the merge group base | the Node.js jobs and the tests, with one retry of a failed test and of failed `extra-commands` |
| Push to the default branch | `none` | none | none; `checks` succeeds |
| Push to any other branch | `full` | none | the Node.js jobs and the tests |
| `schedule` | `nightly` | none | as `full`, plus the Windows jobs and `Stress` |
| `workflow_dispatch` and any other event | `full` | none | as `full` |

A root file is a file at the repository root other than a `*.md` file, a
`pnpm-lock.yaml` at any depth, or a file under `.github/workflows/` or
`.github/actions/`. A run reads the labels the pull request has when it starts,
so a `ci:full` label added later counts from the next push.

The `node` job runs one job per runner, Node.js version and part:

- By default, with `single-job`, one `Node <version>` job per runner runs the
  checks, then the tests. A pull request on `.nvmrc` shows `Node .nvmrc` and
  `checks`.
- With `single-job: false`, or with `services-compose-file`, `Node <version>`
  runs the checks and `Test <version>` runs the tests, in parallel. A caller
  whose tests take minutes passes `single-job: false`.
- With `extra-commands-job`, `Extra <version>` also runs `extra-commands` in
  parallel.

On Windows, the job name ends with ` on Windows`. The jobs run on Linux, also on
Windows in the `nightly` tier when `windows` is set, and with
`windows-merge-queue` also in the `queue` tier and on manual runs. A pull request
never runs on Windows.

Each job picks the tier, then its own work. It runs `pnpm run checks` with
`test` in `ANTELOPEJS_CHECKS_SKIP`, since the tests run in a step of their own.
Lint and typecheck run once per run, inside `pnpm run checks`, on the Linux job
with the first `node-versions` entry or `.nvmrc`; the other jobs add
`lint,typecheck` to `ANTELOPEJS_CHECKS_SKIP`. The skill evals run on that job
only, on the skills the change touches since the diff base, or since `HEAD^1`
without one.

In the `queue` tier only, which is the `merge_group` event, a failed
`pnpm run test` runs once more, and so do failed `extra-commands`. When the
retry fails, the job fails. When it passes, the job passes and the
`Annotate the flaky tests` step reads the log of the failed attempt of each
command that passed on its retry. It writes one warning annotation per flaky
test, titled exactly `Flaky test`, with the message
`<owner>/<repo>: <test> passed only on its merge-queue retry.`, where `<test>`
is `<file> > <test title>`, the titles of nested suites joined by ` > `, or only
`<file>` when the whole file failed to run. `<file>` is the path as the test
runner printed it, so in a workspace it is relative to the package the runner
ran in, not to the repository. It reads the output of vitest, jest, mocha (the
spec reporter) and `node --test` (the spec reporter of Node.js 24), unprefixed.
When it finds no test file, `<file>` is `pnpm run test`, and when it parses
nothing or the parsing fails, there is one annotation naming `pnpm run test`.
The log of failed `extra-commands` goes through the same parsers, with
`extra-commands` in place of `pnpm run test` as the name of the command. When
both retries pass, the annotations of the tests come first. GitHub keeps at most
10 warning annotations per step, so above 10 tests, counting both logs together,
the step writes one annotation per test file, and above 10 files a single one
per log, naming `pnpm run test` or `extra-commands`. The message escapes `%`,
carriage returns and line feeds as workflow commands require. The step also adds
one list item to the job summary per annotation, `Flaky test: ` then the message
in a code span. Nothing is filed anywhere else. A scan of the check run
annotations of the repository is the machine-readable signal. A pull request or
a nightly run never retries a failed test or failed `extra-commands`.

In the `nightly` tier only, after the Node.js jobs, the `Stress` job looks for
tests that pass alone but time out under load. On Linux, with the first
`node-versions` entry or `.nvmrc`, it installs, runs `setup-commands` and
`checks:prepare`, starts the services, then runs `pnpm run test` three times
beside four busy loops per CPU. The loops take CPU time from the test runner's
workers, as a loaded machine does, while the workers keep the count the runner
picks from the CPUs it sees. It fails when any run fails, and its summary
counts the failed runs. A pull request never runs it, and a caller sets nothing
for it.

On a pull request and in the merge queue, each job fetches the target branch
into `origin/<branch>`, such as `origin/main`, and the diff base into the
checkout. Every job sets two variables for the commands it runs:

- `ANTELOPEJS_CI_TIER` holds the tier, so a repository can run a browser smoke
  test in `full` and its whole browser suite in `nightly`.
- `ANTELOPEJS_TEST_BASE` holds, in the `fast` tier only, the diff base. It is
  empty in every other tier, where all tests run. The `affected-tests` input
  uses it to narrow the tests of a pull request. In a pnpm workspace, it runs
  the `test` script of each package changed since the base and of its
  dependents, with `pnpm --filter "...[$ANTELOPEJS_TEST_BASE]" run test`. When
  a file outside the packages changes, it runs the root `test` script whole. In
  a single package whose `test` script is one `vitest` or `jest` command, it
  adds `--changed` or `--changedSince` to that command. Any other `test` script
  runs whole. A repository can also narrow its own `test` script with the
  variable, for example `vitest run --changed "$ANTELOPEJS_TEST_BASE"`.

The rule lives in the `ci-tier` composite action, which each job calls. A
caller cannot read `ci-node.yml`'s outputs before the whole call ends, so a
repository that declares jobs of its own picks the same tier in its own job
with that action. Its `selection` input, set to `full`, forces the `full` tier
on a pull request. Its `tier` output holds the tier and its `base` output the
diff base. On a pull request and in the merge queue, it fetches the diff base
when the checkout lacks it. On a pull request, it reads the changed files from
the checkout. Without a checkout, a pull request gets `fast` unless the label or
`selection` asks for `full`:

```yaml
jobs:
  tier:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      tier: ${{ steps.tier.outputs.tier }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 2
      - id: tier
        uses: AntelopeJS/.github/.github/actions/ci-tier@v2
        with:
          selection: ${{ vars.CI_SELECTION }}
```

It accepts these optional inputs:

| Input | Default | Description |
| ----- | ------- | ----------- |
| `node-versions` | `""` | JSON array of Node.js versions; each runs in its own jobs. Empty uses `.nvmrc`. |
| `docs-files` | `""` | Newline-separated files passed to the docs action as `files`; empty skips the step. |
| `docs-typescript-project` | `""` | TypeScript project passed to the docs action as `typescript-project`. |
| `services-compose-file` | `""` | Compose file resolving to a regular file inside the repository; empty skips services. With it, the tests run in a job of their own. |
| `cache-paths` | `""` | Newline-separated paths cached with `actions/cache`, such as downloaded binaries; empty skips the cache step. The job that runs the tests uses the cache; a `Node <version>` job that runs only the checks does not. With `extra-commands-job`, the extra-commands job also uses it, under its own key. On Windows, the job restores the cache a second time. Tar creates a Windows symlink as a file link when its target is not extracted yet, so the second pass, with every target present, recreates pnpm's links as directory links. |
| `cache-key-files` | `pnpm-lock.yaml` | Newline-separated globs hashed into the cache key, next to the runner OS and Node.js version. |
| `setup-commands` | `""` | Multiline shell commands run with `bash -euo pipefail` right after the root `pnpm install`, in every job, before checks, tests and `extra-commands`. Use it for installs that checks need, such as `pnpm --dir frontend-vue install --frozen-lockfile`; empty skips the step. |
| `extra-commands` | `""` | Multiline shell commands run after checks with `bash -euo pipefail`. In the `queue` tier, a failure runs them once more in the same job, after the first attempt, so they must be safe to run twice: a second `git fetch --unshallow` fails, and a server the first attempt started keeps its port. |
| `renovate-sync` | `false` | Accepted and ignored. Every caller passes `false` and runs the [Renovate sync](#renovate-sync) from its own job. |
| `single-job` | `true` | Run the checks and the tests in one job per runner. Pass `false` to run the tests in a job of their own, in parallel with the checks, when they take minutes. A caller with `services-compose-file` always gets separate jobs. |
| `test-job` | `false` | Accepted and ignored. The tests run as a step of the single job, or in a job of their own with `single-job: false`. |
| `extra-commands-job` | `false` | Run `extra-commands` in their own job, in parallel with the other checks. Use it only when the commands do not read files that `pnpm run checks` writes, such as a build. |
| `windows` | `true` | Also run the jobs on `windows-latest`, in parallel with `ubuntu-latest`, in the `nightly` tier, and with `windows-merge-queue` in the `queue` tier and on manual runs. Steps and package scripts run in Git Bash, and git checks out with `core.autocrlf false` and `core.symlinks true`. The Windows jobs skip services and the skill evals, so tests that need the services must not run there. A caller that cannot run on Windows passes `false` and states the reason in its workflow. |
| `windows-merge-queue` | `false` | With `windows`, also run the Windows jobs in the `queue` tier and on manual runs. |
| `windows-pull-requests` | `false` | Accepted. The former name of `windows-merge-queue`, with the same effect. |
| `affected-tests` | `false` | In the `fast` tier, run only the tests the pull request can affect. In a pnpm workspace, that is the `test` script of each package changed since the diff base and of its dependents, or the root `test` script whole when a file outside the packages changes. In a single package whose `test` script is one `vitest` or `jest` command, that command runs with its changed-file option. Any other `test` script runs whole. The `queue`, `full` and `nightly` tiers always run the whole suite. |

It declares one optional secret, `NOTION_TOKEN`, which is deprecated and
ignored. The workflow no longer writes to Notion. The secret stays declared
because callers still pass it and a reusable workflow rejects a secret it does
not declare.

The `checks` job stays the single required result. It checks that the pull
request title uses Conventional Commits. It fails when the `node` job did not
succeed, when any job it waits for failed or was cancelled, and in the
`nightly` tier when `Stress` did not succeed.

Services start with `docker compose up -d --wait` in the `Test` and `Extra`
jobs, and in a `Node <version>` job only when it runs `extra-commands`. After a
successful start, cleanup runs with `docker compose down -v` even if checks,
tests or extra commands fail. See the [checks
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
`checks` on the new head. A check from a `workflow_dispatch` run does not count
for the pull request's required status checks, so the job waits for that run and
reports, for each status check the base branch's rulesets require from GitHub
Actions or from any source, the result of the run's job of that name on the new
head as a commit status of the same name, which the ruleset counts. A required
check the run has no single job for fails the job. When the sync output touches `.github/workflows/**`
or `.github/actions/**`, nothing is pushed and the job fails with that reason in
its summary: the pull request stays One-tap. On any other event the job is
skipped.

The workflow declares no permissions: it inherits the token permissions of the
job that calls it, so a caller that grants less keeps working and only a bump
whose sync output must be pushed fails, with the missing permission named in the
log. Call it from its own job, next to `ci-node.yml` with
`renovate-sync: false`, so that only that job holds `contents: write`,
`actions: write` and `statuses: write`, and only on Renovate pull requests. The
caller must declare the `workflow_dispatch` trigger:

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
      statuses: write
    uses: AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v2
```

A sync failure then shows on `renovate-sync / Renovate sync` rather than on
`ci / checks`. The bump stays gated: `pnpm run checks` runs `sync:check`, so a
head whose sync output was not applied fails `ci / checks`, and a pushed head
whose dispatched result was not reported has no `ci / checks` the ruleset
counts.

The status check context of the `checks` job of `ci-node.yml` is `ci / checks`
when the caller job id is `ci`.

## Trunk and the merge queue

A repository develops on trunk: every pull request targets `main`, and GitHub's
merge queue squashes it onto `main` once the required check (`ci / checks`,
plus `ubuntu` in the DMS repositories) passes on the queued result. The
`merge_group` event runs the `queue` tier of `ci-node.yml`, and a push to
`main` publishes the preview described in [npm releases](#npm-releases). There
is no integration branch: nothing needs promoting, and `main` stays releasable
as stable at any time.

`scripts/next-branch-setup.sh <owner>/<repo>` sets up a rolling branch for a
repository that still keeps one, `cloud` with its `develop`, and defaults to
`--branch develop`. It prints the
changes it would make; with `--apply` it makes them and prints only failures.
It can run again at any time and changes only what differs. A trunk repository
does not run it.

### Develop sync

The reusable `next-sync.yml` workflow serves `cloud` alone, whose `develop`
branch still takes pull requests before it reaches `main`. It merges the default
branch into the branch named by its `branch` input after each push to the
default branch, so that the branch always contains `main`. It pushes the merge
commit with `RELEASE_GITHUB_TOKEN`, whose push starts the branch checks. When
the merge conflicts, it pushes nothing and fails with a message that names the
conflicting files. With the `NOTION_TOKEN` secret, it also files one task in the
Tasks Inbox, or adds the new run to the open task it filed before. Without it,
it opens one issue in the repository with the default token, or comments on the
one it opened before, and the next successful sync closes that issue. A
repository admin resolves the conflict by merging `main` into the branch and
pushing the merge commit straight to it: a pull request would squash it, and
the same conflict would come back.

| Input | Default | Description |
| ----- | ------- | ----------- |
| `branch` | `next` | Branch that receives the default branch. |
| `RELEASE_GITHUB_TOKEN` (secret) | | Token of a repository admin, which the branch ruleset lets push. |
| `NOTION_TOKEN` (secret) | | Optional. Notion integration token allowed to read, insert and update content in the Tasks database. Without it, a conflict opens a GitHub issue. |

The calling job must grant `issues: write`, with or without `NOTION_TOKEN`: a
called workflow cannot ask for more than its caller grants, so GitHub refuses
to start the sync otherwise. `gh workflow run next-sync.yml --repo <owner/repo>`
runs the sync on demand, for a push event GitHub dropped.

## Link rot

`link-rot.yml` runs weekly in this repository, and on demand by
`workflow_dispatch`. It checks the external links of `README.md` and `docs/**`
of every public, non-archived repository of the organization whose `pack`
custom property is not `none`, with lychee. Dead links never fail the run; only
a crash does. Links to npmjs.com are skipped because it rejects automated
requests. The run uploads one JSON artifact, `link-rot`, keyed by repository
and file.

## Templates from a fresh clone

`templates-fresh-clone.yml` runs every night in this repository, and on demand
by `workflow_dispatch`. A pull request does not run it, so whoever edits the
workflow or its table runs it on their branch before asking for a merge:
`gh workflow run templates-fresh-clone.yml --ref <branch>`. For each template
that `ajs project init` offers, it does what a new user does: it creates a
project with `npx @antelopejs/core@latest`, which clones the template's `main`
and installs it, then starts it the way the template's README says. The
AntelopeJS modules of `antelope.config.ts` install from npm at that start, so
a module release that breaks a template shows up the next night, with no pull
request in the template.

`.github/templates-fresh-clone/templates.json` holds one row per template: its
name in the AntelopeJS/interfaces manifest, `project` or `module` init, the
start command and the log line that means it is ready. The `Templates` job
fails when the rows and the manifest's templates differ. Each template then
runs in its own job beside a MongoDB on port 27017. The Docker templates
run their container as uid 1000, which differs from the runner's user, so
their rows make the project writable for every user before `docker compose up`. It fails when the command
exits or prints an error line of `ajs` (one that starts with `✖ `, or
`Failed to start modules` or `Failed to construct modules`), or the AdonisJS
watcher's `Underlying HTTP server died`, before the ready
line or in the 10 seconds after it, and when 25 minutes pass without it.

## Nightly failures the merge queue missed

`ci-metrics-nightly.yml` runs every day at 07:41 UTC, after the nightlies, in
this repository, on demand by `workflow_dispatch`, and on a pull request that
changes it or its script. It runs
[`scripts/ci-metrics/nightly-main.ts`](scripts/ci-metrics/README.md#nightly-failures-the-merge-queue-missed)
over the last 30 days, writes its Markdown report to the job summary, and
uploads it with the JSON report and dataset as the `nightly-report` artifact.
It reads the organization with the run's `GITHUB_TOKEN`, so it sees the public
repositories only.

## pnpm workspaces

Before configuring the pnpm cache, both workflows resolve the lockfile that
governs the package: `<package-directory>/pnpm-lock.yaml` when that file
exists, otherwise the nearest `pnpm-lock.yaml` found while walking up to the
repository root. The release fails with an explicit message when no lockfile is
found between the package directory and the repository root.

In a pnpm workspace the lockfile lives at the repository root, so a caller
releasing a package below `packages/` needs no extra input. This is the job
`antelopejs-sync` writes for one package of a repository that holds several:

```yaml
jobs:
  release-packages-dms-automation:
    if: github.event_name == 'push' || inputs.package-directory == 'packages/dms-automation'
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@v2
    with:
      release-version: ${{ inputs.release-version }}
      release-commit: ${{ inputs.release-commit }}
      dependency-ranges: ${{ inputs.dependency-ranges }}
      package-directory: packages/dms-automation
    secrets:
      RELEASE_GITHUB_TOKEN: ${{ secrets.RELEASE_GITHUB_TOKEN }}
```

Both workflows install from the nearest directory at or above the package
directory that holds `pnpm-workspace.yaml`, or from the package directory when
there is none. pnpm validates the root lockfile and installs every workspace
project, so the released package and the workspace dependencies it links
through `workspace:*` are installed together. No `--filter` is required.
