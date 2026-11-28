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
| `workflow_dispatch` with `preview: true` | the default branch or a `work/*` branch | a preview under the npm dist-tag `next` |
| `pull_request` | a pull request with the `preview` label | a pull request preview: a [pkg.pr.new](https://pkg.pr.new) package for a public package, the dist-tag `pr-<number>` on `https://npm.antelopejs.cloud/` for a private one |
| `workflow_dispatch` | the default branch | a stable release under the npm dist-tag `latest`, or nothing without `release-version` |

A push publishes nothing and skips the job, so a caller that still triggers on
`push` stays green. A preview dispatch of any other branch, and any other
event, fails the run with the reason. Anyone allowed to run
the workflow can dispatch a stable release with any `release-version` above
`latest` in the same major. The release train is the way to start one, not a
guard against starting one by hand. A release runs no tests. The checks of the pull request that brought each commit are the gate.

A preview run and a stable run use the `npm-publish` environment of the
repository. Its deployment branches need the default branch, and `work/*` for a
preview of a work branch. A pull
request preview run uses no environment, because the branch policy of the
environment allows no pull request ref. A private pull request preview reads
`NPM_ANTELOPE_TOKEN` as an organization secret.

### Preview versions

A dispatch with `preview: true` publishes a preview of the package when its
directory changed since the commit of the current `next` preview, read from npm
as its `gitHead`. A change to the changelog, or to the `version` field of
`package.json`, does not count. The changelog is the `output` of
`changelogen.config.json`, or `CHANGELOG.md`. So a preview of the release
commit of a release that changed only the version and the changelog publishes
nothing.
Neither does a change to
`pnpm-lock.yaml`, which no package ships, or a change inside a nested directory
that holds its own `.release-it.json`, which is another released package. A
release that wrote stable ranges changes `dependencies` too, so a preview of
its release commit holds the stable ranges. A package that
changed nothing it ships publishes nothing and says so in a
notice. The preview version is
`<base>-next.<commit count>.g<short sha>`, such as `0.4.3-next.161.g3f9a2c1`.
The base is the patch after the current `latest` version on npm. A package that
was never published uses the version of its `package.json` without its
prerelease part. A rerun of the same commit finds the version already on npm and
publishes nothing.

A preview moves only the `next` dist-tag. `latest` stays on the last stable
release. The run writes no commit, no tag, no changelog and no GitHub release.

A preview resolves each `workspace:` spec in `dependencies`,
`peerDependencies` and `optionalDependencies` whose sibling holds its own
`.release-it.json`. A sibling with an unreleased preview, the one this commit
publishes or a `next` newer than its `latest`, is pinned to that exact preview
only when its public API changed since its `latest` release. The run packs the
sibling with `pnpm pack`, fetches its `latest` tarball from npm and compares
the `.d.ts`, `.d.mts` and `.d.cts` files of both by path and content. When
they match, the preview gets `^<latest>` instead, so a module that already
depends on a stable range of the sibling installs one copy of it. A sibling
never released is always pinned. A preview that would pin a sibling preview npm
does not hold fails before it publishes and names the sibling's directory:
dispatch the preview of that directory first, then run the dependent's again.
The trade-off: a runtime-only change of a
sibling, such as a bug fix behind unchanged types, reaches the previews of its
dependents only once the sibling is released. A sibling that ships no
declaration files always counts as unchanged. A stable release keeps its
ranges as before.

Publish a preview of the default branch, or of a `work/*` branch, then pin the
exact preview in the dependent:

```sh
gh workflow run release.yml --repo AntelopeJS/interface-database --ref work/ant-12-cursor -f preview=true
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
`--pnpm`, so that each `workspace:` and `catalog:` spec resolves. pkg.pr.new
takes one publish per workflow run, so in a workspace only the job of the first
released directory in path order calls it, once, on every directory of the
workspace that holds a `.release-it.json` and is not `private`. The jobs of the other packages say so
in a notice and publish nothing. pkg.pr.new then points each `workspace:` spec
on another package of that call at its pkg.pr.new preview.

A private package publishes to `https://npm.antelopejs.cloud/` under the
dist-tag `pr-<number>`, such as `pr-12`:

```sh
pnpm add @antelopejs-private/my-package@pr-12
```

A pull request preview never moves `latest` or `next`. A private one pins no workspace
sibling, because `pnpm pack` writes each `workspace:` spec as the range in the
`package.json` of the sibling. A preview that needs an unreleased change of a
sibling does not get it. A pull request from a fork gets no secrets, so the
credentials check fails a private preview of it.

### Release train

The release train publishes the stable versions of several packages once, in
dependency order. Run it from a checkout of this repository with Node.js 26 and
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
  `<base>-next.<commit count>.g<short sha>` version that a preview dispatch
  of that package published, such as
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
- The plan refuses a release that raises or adds an `engines` or
  `peerDependencies` floor on another `@antelopejs` package, in any
  `package.json` under its directory, when the caret range of its stable
  version admits the bump: a patch of a 0.x package, any release from 1.0.0
  on. Dependents that lock the older version would break. Release a 0.x
  package as a minor instead, or release those dependents with it and pass
  `--coordinated <name>`, which releases it and lists each raise.

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
again. `go` prints `published` for a release only once npm shows its version as
`dist-tags.latest`. It stops when npm does not within 10 minutes: the release is
published, and the rest is not. Run `go` again once
`npm view <package> dist-tags.latest` prints the version. After a failure, fix it and run `go` again. The plan is read again from
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
   `pnpm install --frozen-lockfile`. It then builds each workspace package
   under `packages/interface-*` that has a `build` script, so a
   `before:init` lint that reads their types finds them.
6. It writes the release notes of the cycle in changelogen's format: the
   compare link, one line per task with one block per commit type and the
   oldest first, the breaking changes and the contributors. It reads the tasks
   the way the plan does, from the heads of the pull requests merged into the
   default branch since the last stable tag (`gh pr list` with the release
   app token), and fails when `gh` fails. It leaves out a revert
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
   `package.json`. After the repository's own `after:bump` hooks, the config
   runs the workspace root's `sync` script, then
   `node scripts/check-docs-module-version.mts --write` in the package, each
   when it exists, and stages every changed tracked file of the repository.
   In place of
   release-it's own
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
| `preview` | `false` | `true` makes a `workflow_dispatch` of the default branch or of a `work/*` branch publish a [preview](#preview-versions) under `next`. It ignores `release-version` and `release-commit`. |
| `integration-branch` | none | Unused. Only the two wrappers declare it, so that a caller that passes it keeps working. |

A stable or repin run writes with a token of the `antelopejs-release` GitHub
App, which `actions/create-github-app-token` mints from the `RELEASE_APP_ID`
and `RELEASE_APP_PRIVATE_KEY` secrets, scoped to the calling repository and to
`contents: write` and `pull_requests: read` (the release notes read merged pull
requests). It pushes the release commit and tag and creates the GitHub release.
The run fails when either app secret is unset. The `public` registry publishes to npmjs with public access and
provenance. The `private` registry publishes to `https://npm.antelopejs.cloud/`
and also needs `NPM_ANTELOPE_TOKEN` for every run. Each validates that the
package directory resolves inside the repository and holds a `package.json`,
and checks the publication metadata of `package.json` before it publishes. Among them,
`repository.url` must name the calling repository, and a package npm already
holds must name it in its own `repository.url` too.

Both registries write to the repository only with the release app token, so
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

`antelopejs-sync` of the first `@antelopejs/tooling-configs` release after
0.9.2 writes this caller. Every caller forwards the two app secrets.

- **File.** `.github/workflows/release.yml`. npm trusted publishing names this
  file, and the release train dispatches it.
- **Triggers.** `pull_request` with the types `labeled`, `synchronize` and
  `reopened` for a [pull request preview](#pull-request-previews) of each pull
  request that carries the `preview` label, and `workflow_dispatch` for
  previews and stable releases. A `push` trigger left from an older caller
  publishes nothing.
- **Dispatch inputs.** `release-version`, `release-commit` and
  `dependency-ranges` (default `"{}"`), all optional strings that the release
  train sets, and the optional boolean `preview` (default `false`) that a
  maintainer sets to publish a preview. A repository whose package is not at
  its root adds `package-directory`. A repository with several packages has one job per
  package, and a dispatch runs only the job whose `package-directory` it names.
  The release train sends nothing else.
- **Permissions.** `contents: write`, and `id-token: write` when a package is
  public. The release jobs ask only `contents: read`, because they write with
  the release app token.
- **Optional inputs.** Every other input of the shared workflows has a default
  that fits this caller. A caller may set `install-core`.
- **Secrets.** `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`, plus
  `NPM_ANTELOPE_TOKEN` for the private workflow, each passed by name. A stable
  or repin run mints its token from the two app secrets.
- **Call.** `release-npm-public.yml@v2` or `release-npm-private.yml@v2`, with
  each dispatch input passed through under the same name, `preview` as
  `${{ inputs.preview == true }}` so that a pull request run passes `false`.
  `release-npm.yml@v2` takes the same call with `registry: public` or `registry: private`.
- **Repository setting.** The `npm-publish` environment allows the default
  branch, and `work/*` for previews of work branches.

### Caller workflow

The caller is the `release.yml` of the repository. It declares the two
triggers, passes the dispatch inputs and forwards the secrets:

```yaml
name: Release

on:
  pull_request:
    types: [labeled, synchronize, reopened]
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
      preview:
        description: Publish a preview under the npm dist-tag next from the default branch or a work/* branch
        required: false
        default: false
        type: boolean

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
      preview: ${{ inputs.preview == true }}
    secrets:
      RELEASE_APP_ID: ${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
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
| Pull request from a `renovate/*` branch of the repository whose head commit is a lock commit marked `Checks-Passed` (see [module locks of a Renovate pull request](#module-locks-of-a-renovate-pull-request)) | `none` | the pull request base | none: the run that recorded the locks passed every other job; `ci / checks` succeeds |
| Push to the default branch | `none` | none | none: the first Linux job installs the dependencies when the pnpm store of its lockfile is not saved yet, and saves it; `ci / checks` succeeds unless that install fails |
| Push to any other branch | `full` | none | the Node.js jobs and the tests |
| `schedule`, or `workflow_dispatch` with the `nightly` input | `nightly` | none | as `full`, plus the Windows jobs and `Stress` on the Sunday `schedule` run (UTC), the night of Saturday to Sunday, and on every `workflow_dispatch` with `nightly` |
| Any other `workflow_dispatch`, and any other event | `full` | none | as `full` |

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
  parallel. With `extra-commands-shards` above 1, `Extra <version> <i>/<n>`
  runs them once per shard, after an `Extra shards` job lists the shards.
- With `test-shards` above 1, `Test <version> <i>/<n>` runs the tests once per
  shard, in parallel, and `Node <version>` runs only the checks, even with
  `single-job`. The same `Extra shards` job lists the test shards.

A caller whose tests take minutes splits them with one input:

```yaml
jobs:
  ci:
    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2
    with:
      renovate-sync: false
      test-shards: 4
```

A test script must run its share of the tests when `ANTELOPEJS_CI_SHARD` is set
to `<i>/<n>`, and everything when it is unset.

On Windows, the job name ends with ` on Windows`. The jobs run on Linux, also on
Windows in the `nightly` tier of the Sunday `schedule` run and of a
`workflow_dispatch` with `nightly` when `windows` is set, and with
`windows-merge-queue` also in the `queue` tier and on manual runs. A pull request
never runs on Windows, and neither does a private or internal repository.

Each job picks the tier, then its own work. It runs `pnpm run checks` with
`test` in `ANTELOPEJS_CHECKS_SKIP`, since the tests run in a step of their own.
Lint and typecheck run once per run, inside `pnpm run checks`, on the Linux job
with the first `node-versions` entry or `.nvmrc`; the other jobs add
`lint,typecheck` to `ANTELOPEJS_CHECKS_SKIP`. The skill evals run on that job
only, on the skills the change touches since the diff base, or since `HEAD^1`
without one.

Each Node.js job restores the pnpm store saved for its lockfile. On a pull
request, in the merge queue and on a manual run of another branch, a job
whose lockfile has no store, such as a Renovate pull request's, restores the
newest store instead and installs the difference, and it saves nothing: its
store would serve that branch alone. A run on the default branch saves the
store when its lockfile has none yet: the push that merges a lockfile change,
the nightly run and a manual run of `main`. It never starts from an older
store, so a saved store holds one lockfile's packages and stays that size. The
push's leg only looks the key up, so a push that leaves the lockfile alone
downloads nothing. `Stress` and `formal` keep `setup-node`'s own cache. The key,
`node-cache-<os>-<arch>-pnpm-<lockfile hash>`, is the one `setup-node` used, so
the stores saved before this rule still serve.

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

In the `nightly` tier of the Sunday `schedule` run and of a `workflow_dispatch`
with `nightly` only, after the Node.js jobs, the `Stress` job looks for
tests that pass alone but time out under load. On Linux, with the first
`node-versions` entry or `.nvmrc`, it installs, runs `setup-commands`,
`checks:prepare` and `typecheck`, starts the services, then runs `pnpm run test`
three times beside four busy loops per CPU the job may use: its cgroup CPU
quota, rounded up, when that is below `nproc`, else `nproc`. On a runner pod,
the loop count follows the pod's CPU limit, not the node's CPUs. The loops take
CPU time from the test runner's workers, as a loaded machine does, while the
workers keep the count the runner picks from the CPUs it sees. It fails when any
run fails, and its summary counts the failed runs. A pull request never runs
it, and a caller sets nothing for it. It runs no `pnpm run checks`, so
`typecheck` gives the tests the build, such as a `dist/` folder, that `checks`
gives them in the Node.js job.

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
`selection` asks for `full`. In a merge group the queue has dropped, it fails
instead, before any work (see the gate below), so the jobs that need a
caller's own tier job are skipped too:

```yaml
jobs:
  tier:
    runs-on: ${{ vars.RUNNER_CI || 'blacksmith-4vcpu-ubuntu-2404' }}
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
| `extra-commands-shards` | `1` | With `extra-commands-job`, run `extra-commands` in this many jobs, `Extra <version> 1/<n>` to `Extra <version> <n>/<n>`, each on its own runner with `ANTELOPEJS_CI_SHARD` set to its `<i>/<n>`. The commands read it to run their share of the work, such as `playwright test --shard="$ANTELOPEJS_CI_SHARD"`. In the `queue` tier, each job runs its share once more after a failure. The gate needs every job. `1` keeps one job and leaves `ANTELOPEJS_CI_SHARD` unset. |
| `test-shards` | `1` | Run the tests in this many jobs, `Test <version> 1/<n>` to `Test <version> <n>/<n>`, each on its own runner with `ANTELOPEJS_CI_SHARD` set to its `<i>/<n>` on the test step. The test script must run its share when `ANTELOPEJS_CI_SHARD` is set and everything when it is unset. Above `1`, `Node <version>` runs only the checks, even with `single-job`, so nothing runs twice. Each job keeps the merge queue's one retry, the flaky annotation, the fast-tier test selection and the skip of a documentation-only pull request. The gate needs every job. `1` keeps today's jobs and leaves `ANTELOPEJS_CI_SHARD` unset. |
| `windows` | `true` | Also run the jobs on Windows, in parallel with Linux, in the `nightly` tier of the Sunday `schedule` run (UTC) and of a `workflow_dispatch` with `nightly`, and with `windows-merge-queue` in the `queue` tier and on manual runs. Windows runs only when the calling repository is public, which a `Windows and Stress eligibility` job reads from the API once per run, because a `schedule` payload names no repository. Private and internal repositories skip it. Steps and package scripts run in Git Bash, and git checks out with `core.autocrlf false` and `core.symlinks true`. The Windows jobs skip services and the skill evals, so tests that need the services must not run there. A caller that cannot run on Windows passes `false` and states the reason in its workflow. |
| `windows-merge-queue` | `false` | With `windows`, also run the Windows jobs in the `queue` tier and on manual runs. |
| `windows-pull-requests` | `false` | Accepted. The former name of `windows-merge-queue`, with the same effect. |
| `module-locks` | `false` | After the install, tests and `extra-commands` of each job, run the [module locks committed](#module-locks-committed) action: the job fails when it wrote an `antelope-lock/` file that is not committed, and on a Renovate pull request it uploads what it wrote. Pass `true` in a repository that commits an `antelope-lock/` folder. |
| `affected-tests` | `false` | In the `fast` tier, run only the tests the pull request can affect. In a pnpm workspace, that is the `test` script of each package changed since the diff base and of its dependents, or the root `test` script whole when a file outside the packages changes. In a single package whose `test` script is one `vitest` or `jest` command, that command runs with its changed-file option. Any other `test` script runs whole. The `queue`, `full` and `nightly` tiers always run the whole suite. |
| `nightly` | `false` | On a `workflow_dispatch` run, run the `nightly` tier instead of `full`, with the Windows jobs and `Stress` whatever the day, so a fix to a nightly failure can be proven on a branch. A caller forwards the `nightly` input of its own `workflow_dispatch` trigger, as in [the verdict of a caller](#the-verdict-of-a-caller). Any other event ignores it. |
| `formal-checks` | `""` | JSON array of the formal checks to run, each in a `Formal (<skill>, …)` job that the `gate` job needs. See [Formal checks](#formal-checks). Empty or `[]` runs none. |

It declares one optional secret, `NOTION_TOKEN`, which is deprecated and
ignored. The workflow no longer writes to Notion. The secret stays declared
because callers still pass it and a reusable workflow rejects a secret it does
not declare.

The `gate` job, named `checks`, is the one reporting job of the run, the check
`ci / checks` that every ruleset requires and the result the merge queue waits
for. It needs every other job, runs with `if: ${{ !cancelled() }}` whatever
they ended with, and fails, naming them, when any job failed or was cancelled,
when `node` did not succeed, and in a `nightly` tier that runs `Stress` when
`Stress` did not succeed. The leg that runs the checks on the first `node-versions` entry, on
Linux, checks that a pull request's title uses Conventional Commits.

Every job that a run can skip has a constant `name`: GitHub never evaluates the
name of a skipped job and shows its expression as is, such as
`Formal ${{ matrix.skill }}`. No name can read `checks` when the gate runs and
something else when it skips, so the gate runs in every run that is not
cancelled. A matrix job with a constant name gets its matrix values appended,
as in `Formal (formal-a)`. The `node` legs keep their `Node <version>` names,
an expression, because a leg skips only after `Windows and Stress eligibility` or
`Extra shards` failed, or in a run that was cancelled before it started, and
the gate then fails or ends cancelled. A required check that is
skipped passes, so a gate that a failed job would skip gates nothing:
`!cancelled()` never skips it in a run that goes on, and in a run that was
cancelled, whether a newer run of the same pull request or someone cancelled it,
it ends cancelled without a runner, which blocks a merge as a failure does.
`always()` would run it there too, so each cancelled run would wait for a
runner of the pool only to fail. In a run that was not cancelled, a cancelled
job, such as a leg that timed out, still fails the gate. There is no second
reporting job: each one is a queue hop on the pool, after `node` and before a
caller's own gate, for a run that is already decided.

In the merge queue, a group the queue rebuilds or drops loses its
`gh-readonly-queue/…` branch, or the branch moves to the new group when the
queue rebuilds it on the same parent, but GitHub leaves the old group's runs
queued, and no expression can name the pull request of a group to cancel them
by: the payload names it only inside the branch name. So the `ci-tier` action,
which each job calls first, ends a `merge_group` job whose branch no longer
points at its head and whose head is not on the base branch: it fails with a
`Superseded merge group` error, before the install or the tests. A group that
merged also loses its branch, but its head is then on the base branch, so a late
job of it runs as before. When either API call fails, the job runs as before.
The run's `ci / checks` then fails in seconds, on a commit no queue
waits for.

The Linux jobs run on Blacksmith's 4 vCPU Ubuntu 24.04 runner,
`blacksmith-4vcpu-ubuntu-2404`, unless the calling repository's `RUNNER_CI`
variable names another runner label. A reusable workflow reads the caller's
variables, so one variable switches a repository to another runner. The three
small jobs, `Windows and Stress eligibility`, `Extra shards` and the gate, run a few
seconds of shell and install nothing: they go to the label the caller's
`RUNNER_CI_SMALL` variable names when it is set, before `RUNNER_CI`. A caller's
own gate and tier jobs can read the same variables. The Windows legs run only
for a public repository, on Blacksmith's 4 vCPU Windows Server 2025 runner,
`blacksmith-4vcpu-windows-2025`, unless `RUNNER_CI_WINDOWS` names another
label.
The npm release workflows follow the same default and `RUNNER_CI` for a
private or internal repository, and a public repository's release stays on
`ubuntu-latest`, because npm trusted publishing and provenance refuse
self-hosted runners, Blacksmith's included. Every other workflow here follows
the Linux default and `RUNNER_CI`, and `workflows-runners.test.ts` fails on a
`runs-on` that resolves to any other label when no variable is set.

Services start with `docker compose up -d --wait` in the `Test` and `Extra`
jobs, and in a `Node <version>` job only when it runs `extra-commands`. After a
successful start, cleanup runs with `docker compose down -v` even if checks,
tests or extra commands fail. See the [checks
contract](CONTRIBUTING.md#the-pnpm-run-checks-contract) and [caller
examples](CONTRIBUTING.md#shared-ci-and-maintenance-workflows).

### Formal checks

The `formal-checks` input runs a repository's formal checks, the `formal-*`
skills under `.agents/skills/`, as one `Formal (<skill>, …)` job each, in parallel
with the Node.js jobs. The `gate` job needs them, so a failing formal check
fails `ci / checks` and blocks the merge. Each entry of the JSON array takes:

| Key | Required | Description |
| --- | -------- | ----------- |
| `skill` | yes | The folder under `.agents/skills/`, such as `formal-billing-lease`. The job is named `Formal (<skill>, …)`: GitHub appends every value of the entry, `paths` and `run` included, to the constant name. |
| `run` | no | Multiline shell commands run with `bash -euo pipefail` instead of `node .agents/skills/<skill>/check.mjs`, such as a `node --test` of the skill's own tests before its `check.mjs`. |
| `paths` | no | The git pathspecs of the files the check models, the files of its SKILL.md coverage record. A pull request in the `fast` tier runs the check only when one of them or the skill folder changed, and the job summary says when it skipped. Without `paths`, every pull request runs it. |

The `full`, `queue` and `nightly` tiers run every check, and the `none` tier
none. A pull request that changes a root file, such as `pnpm-lock.yaml`, is in
the `full` tier, so it runs every check whatever its `paths`. A job installs with `pnpm install --frozen-lockfile --ignore-scripts`,
sets up Temurin Java 21, and restores `~/.cache/antelopejs-formal`, the cache
where `@antelopejs/tooling-configs/formal` keeps the TLC model checker, under a
key of the skill and `pnpm-lock.yaml`, falling back to any skill's cache. It
runs on the `RUNNER_CI` label, Blacksmith 4 vCPU by default, with a 60-minute
timeout against a hung checker. No time budget fails a check: the job summary
gives the exit code and time in seconds of each check that exits.

A repository adopts it by moving each hand-written formal job of its `ci.yml`
into the input of its `ci` job, then deleting those jobs and dropping them from
the `needs` of its own gate, which keeps only `ci` and its other jobs:

```yaml
jobs:
  ci:
    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2
    with:
      formal-checks: |
        [
          {"skill": "formal-billing-lease", "paths": ["src/engine.ts", "src/transitions.ts", "src/records.ts"]},
          {"skill": "formal-module-lifecycle", "run": "node --test .agents/skills/formal-module-lifecycle/*.test.mjs\nnode .agents/skills/formal-module-lifecycle/check.mjs"}
        ]
```

### The verdict of a caller

The merge queue waits only for the checks the rulesets of the default branch
require. A job of the caller's own `ci.yml`, beside the `ci-node.yml` call, is
one more result the queue would merge past. Such a caller adds a job named
`verdict` that needs every job of the file, runs with `if: ${{ !cancelled() }}`,
and fails when any of them failed or was cancelled, and its rulesets require `verdict`
alone. A caller whose `ci.yml` is the `ci-node.yml` call alone needs no job of
its own: its rulesets require `ci / checks`. The
[verdict conformance](#verdict-conformance) workflow lists every repository that
does neither.

The caller also forwards the `nightly` input of its `workflow_dispatch` trigger,
so `gh workflow run ci.yml --ref <branch> -f nightly=true` runs the `nightly`
tier on a branch:

```yaml
name: CI

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, labeled, unlabeled]
  merge_group:
  push:
    branches: [main]
  schedule:
    - cron: "17 2 * * *"
  workflow_dispatch:
    inputs:
      nightly:
        description: Run the nightly tier, with the Windows jobs and Stress
        type: boolean
        default: false

permissions:
  contents: read

jobs:
  ci:
    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2
    permissions:
      contents: read
    with:
      renovate-sync: false
      test-job: true
      nightly: ${{ inputs.nightly == true }}
  renovate-sync:
    if: >-
      github.event_name == 'pull_request' && startsWith(github.head_ref, 'renovate/') && github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      actions: write
      statuses: write
    uses: AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v2
  verdict:
    needs: [ci, renovate-sync]
    if: ${{ !cancelled() }}
    runs-on: ${{ vars.RUNNER_CI || 'blacksmith-4vcpu-ubuntu-2404' }}
    timeout-minutes: 5
    permissions: {}
    steps:
      - name: Fail when a job failed or was cancelled
        env:
          NEEDS: ${{ toJSON(needs) }}
        run: |
          failed=$(jq -r 'to_entries[] | select(.value.result == "failure" or .value.result == "cancelled") | "\(.key): \(.value.result)"' <<< "$NEEDS")
          if [ -n "$failed" ]; then
            echo "$failed"
            exit 1
          fi
```

### Renovate sync

The reusable `ci-renovate-sync.yml` workflow takes no inputs and two optional
secrets, `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`. On a pull request
from a `renovate/*` branch of the same repository whose diff changes a
`package.json` or a `pnpm-lock.yaml`, its `renovate-sync` job installs, runs the
repository's `sync` script (the write side of the `sync:check` its checks run,
so the profile is the repository's own; a repository without one is left
alone), then its `format` script when it has one, so a bump of `oxfmt` lands
with the files it formats, and hands the output as a patch artifact to its
`push` job, which commits it to the branch as `github-actions[bot]`, so the bump
pull request becomes conformant on its own. The hosted Renovate app runs
no `postUpgradeTasks`, so this workflow does that work. The `push` job runs
nothing from the repository: it checks out the head, applies the patch and
pushes.

With both secrets, the `push` job mints an installation token of that GitHub
App, scoped to the calling repository with `contents: write` only, and pushes
with it. The `renovate-sync` job, which installs and runs the bumped
dependencies, never holds the key or the token. A push made with the app token
starts the pull request's checks on the new head, so no job waits for another
run.

A sync output that touches `.github/workflows/**` or `.github/actions/**` is
always One-tap, with either token: nothing is pushed, the job fails, and its
summary lists the paths. Neither token may push a workflow file.

Without the secrets, the `push` job pushes with `GITHUB_TOKEN`. A push made with
`GITHUB_TOKEN` starts no workflow run, so the job then
dispatches the caller workflow on the branch (`gh workflow run`), which runs
`checks` on the new head. A check from a `workflow_dispatch` run does not count
for the pull request's required status checks, so the job waits for that run and
reports, for each status check the base branch's rulesets require from GitHub
Actions or from any source, the result of the run's job of that name on the new
head as a commit status of the same name, which the ruleset counts. A required
check the run has no single job for fails the job. When the sync output touches `.github/workflows/**`
or `.github/actions/**`, nothing is pushed and the job fails with that reason in
its summary: the pull request stays One-tap. When the `format` script changes
more than whitespace and line breaks (a lint fix, a quote or comma rewrite, or
a file it adds, deletes or changes the mode of), nothing is pushed and the job fails with the paths
in its summary, so only a layout-only reformat lands without a human. On any
other event the job is skipped.

The workflow declares no permissions: it inherits the token permissions of the
job that calls it, so a caller that grants less keeps working and only a bump
whose sync output must be pushed fails, with the missing permission named in the
log. Call it from its own job, next to `ci-node.yml` with
`renovate-sync: false`, so that only that job holds `contents: write`,
`actions: write` and `statuses: write`, and only on Renovate pull requests. A
caller that forwards the app secrets adds `secrets: RELEASE_APP_ID` and
`RELEASE_APP_PRIVATE_KEY` to that job, as it does for `module-locks-renovate.yml`.
A caller without them must declare the `workflow_dispatch` trigger:

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

The status check context of `ci-node.yml`'s reporting job is `ci / checks`
when the caller job id is `ci`.

## Module locks

A project records the dependencies of each npm module it installs in
`antelope-lock/<package>@<version>/`, next to its `antelope.config.ts`, and a
module's tests record theirs next to its `package.json`. An install replays the
lock of a module version and writes one only for a version that has none, so a
locked module's dependencies move only when `ajs project modules update` runs.
Three shared pieces keep the committed locks complete and current.

### Module locks refresh

The reusable `module-locks-refresh.yml` workflow runs
`ajs project modules update --fix` in each project of its `projects` input. The
command records the newest release each range accepts, resolves the
dependencies of every locked module again and deletes the locks no environment
uses. It runs a second time when the first run fails, until a core release
carries AntelopeJS/antelopejs#535. The workflow then runs
`pnpm install --no-frozen-lockfile`, the caller's `commands` and the
repository's `sync` script, so a moved range reaches the files
`antelopejs-sync` writes from it, such as the README compatibility table. It
fails without pushing when the change touches `.github/` or `.gitmodules`, adds a
symlink or a submodule, or holds a path `git apply` refuses, such as one under
`.git` or outside the checkout. When a file changed, it pushes the result to `antelopejs/module-locks` with an installation
token of the `antelopejs-release` GitHub App and opens a pull request into the
default branch, or
updates the one already open. The pull request body lists the module versions
that moved, the locks resolved again at the same version, the ranges that moved
in `antelope.config.ts` and `package.json`, and the other files that changed.
When the default branch has a merge queue, it turns on squash auto-merge on
that pull request, unless auto-merge is already on or the pull request is
already in the queue, so the queue merges it once its checks pass. It never
does so in `cloud`, `k8s-gitops-infra`, `antelope-hardening` and
`antelope-compliance`, the repositories the Renovate preset leaves to a person.
A pull request whose checks fail stays open. When nothing changed, it closes
that pull request and deletes `antelopejs/module-locks`, or deletes the branch
alone when a person closed its pull request unmerged; a repository that calls
[bot branch cleanup](#bot-branch-cleanup) deletes it at the close itself. On a `pull_request` event it only refreshes and writes the
summary, as a dry run.

`ajs` is the `node_modules/.bin/ajs` of the project folder or of the closest
folder above it.

| Input | Default | Description |
| ----- | ------- | ----------- |
| `projects` | `.` | Newline-separated folders that hold an `antelope.config.ts`, such as `playground` or `e2e/playground`. |
| `setup-commands` | `""` | Multiline shell commands run after the root `pnpm install`, before the refresh. Write the variables a configuration needs to load to `$GITHUB_ENV`. |
| `commands` | `""` | Multiline shell commands run after the refresh, such as a test run that records the locks of a test configuration again after it deletes them. |
| `RELEASE_APP_ID` (secret) | | ID of the GitHub App whose installation token pushes the branch and opens the pull request. A push made with it starts the pull request's checks. The app needs `contents: write` and `pull_requests: write` on the repository. |
| `RELEASE_APP_PRIVATE_KEY` (secret) | | Private key of that GitHub App. |

Call it daily:

```yaml
name: module locks

on:
  schedule:
    - cron: "47 4 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  refresh:
    permissions:
      contents: read
    uses: AntelopeJS/.github/.github/workflows/module-locks-refresh.yml@v2
    with:
      projects: |
        playground
    secrets:
      RELEASE_APP_ID: ${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```

### Module locks committed

The `module-locks-committed` action runs as a step of the job that installs the
modules or runs the tests, after them. It fails the job when the job wrote an
`antelope-lock/` file anywhere in the repository that is not committed, and
lists the files. On a pull request from a `renovate/*` branch of the same
repository, a Linux job first uploads the files it wrote as a `module-locks-*`
artifact, at their paths in the repository. A Windows job only fails. Use
`module-locks: true` of `ci-node.yml` when the tests run there, or the action in
a job of your own:

```yaml
      - run: pnpm exec ajs project modules install
      - uses: AntelopeJS/.github/.github/actions/module-locks-committed@v2
```

### Module locks of a Renovate pull request

Mend's hosted Renovate cannot run `ajs`, so a Renovate bump of a module arrives
without its lock, and the checks record it. The reusable
`module-locks-renovate.yml` workflow runs after those checks, on a pull request
from a `renovate/*` branch of the same repository. When the run uploaded
`module-locks-*` artifacts, it downloads them into a scratch folder. The job
that uploaded them ran the bumped dependencies, so it copies into the pull
request's head only regular files at `antelope-lock/<package>@<version>/<file>`
paths, and fails on anything else. In the folder of each new lock, it deletes
the locks of the same package whose version a line the pull request removed
names and no line it adds names. It commits the result as `github-actions[bot]`,
an author the [Renovate preset](#renovate-preset) ignores, with git hooks off.
Only then does it mint an installation token of the same app and push, so the
checks run on the new head. On such a pull request, the `module-locks-committed`
action warns on the locks it uploaded instead of failing the job. When every
other job of the run passed, the commit carries a `Checks-Passed: <run URL>`
trailer, and the [`ci-tier` action](#node-ci) picks the `none` tier on it,
since it changes nothing but the locks: the bump runs its checks once. When a
job failed or still runs, the commit has no trailer and the checks run again in
full. A branch that already holds two of these
commits gets no third: the job fails and names the locks to commit by hand. The
lock of a version a range resolved to stays until the next refresh deletes it.

```yaml
jobs:
  ci:
    permissions:
      contents: read
    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2
    with:
      module-locks: true
  module-locks:
    needs: ci
    if: ${{ !cancelled() }}
    permissions:
      contents: read
      actions: read
    uses: AntelopeJS/.github/.github/workflows/module-locks-renovate.yml@v2
    secrets:
      RELEASE_APP_ID: ${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```

`needs` names every job that records locks.

## Renovate preset

Every repository's `renovate.json` extends `renovate.json5`:

```json
{ "extends": ["github>AntelopeJS/.github:renovate.json5"] }
```

The preset:

- runs daily before 4:00 in Europe/Brussels, and rebases a branch only when it
  conflicts, since the merge queue tests the merged result;
- opens no Dependency Dashboard issue;
- enables GitHub's auto-merge on every update, majors and 0.x minors
  included, so a green one enters the merge queue. Every update in
  `cloud`, `k8s-gitops-infra`, `antelope-hardening` and
  `antelope-compliance` stays manual, since they have no merge queue. A
  third-party patch, minor or major waits three days before it opens; an
  `@antelopejs` one, a pin and a digest do not;
- bumps every `@antelopejs` package of a repository but the tooling configs in
  one `AntelopeJS packages` pull request, majors included, since the interface
  resolver couples core, the modules and the interfaces they declare. It
  reads the module versions that `antelope.config.ts`, `antelope.test.ts`,
  `src/test/antelope-modules.ts` and `src/test/stack-modules.json` pin into
  the same pull request, whose locks the
  [Renovate lock job](#module-locks-of-a-renovate-pull-request) commits;
- bumps every other npm patch and minor of a repository in one
  `non-major dependencies` pull request, since the merge queue removes with
  `merge_conflict` a pull request whose `pnpm-lock.yaml` change meets a
  sibling's. A third-party major keeps its own pull request, so a breaking
  one holds back no patch;
- keeps `@types/node` in the major each package declares, and bumps the range
  in that package's `package.json`, since a lockfile-only update moves every
  workspace importer to one version;
- groups GitHub Actions updates, and `@antelopejs/tooling-configs` with the
  linters it pins, majors included;
- updates nothing in template-dms-adonis's `demo/src`, `demo/content` and
  `demo/frontend-vue`, copies of template-dms-demo that the
  [template demo sync](#template-demo-sync) keeps in step;
- ignores the commits of `github-actions[bot]` on its branches.

A repository's own `renovate.json` keeps only what is specific to it.

## Renovate sweep

`renovate-sweep.yml` runs every hour at minute 29 in this repository. It runs
`scripts/module-locks/renovate-sweep-main.ts` with the release app's token over
every open Renovate pull request of the organization, from a `renovate/*`
branch of its own repository, outside `cloud`, `k8s-gitops-infra`,
`antelope-hardening` and `antelope-compliance`:

- a green one whose last merge-queue or auto-merge event is its removal by the
  queue gets auto-merge armed again, when its base is the default branch and
  has a merge queue and it does not conflict. A removal turns auto-merge off.
  The sweep re-arms a head once: when the queue removes the same head again,
  the pull request stays as it is until its head changes. A pull request a
  person dequeued, or whose auto-merge a person turned off, stays as it is;
- a red one whose head lacks commits of its base gets Renovate's rebase
  checkbox ticked. Renovate rebases it on the current base, and its checks run
  again against it. Once rebased, the head holds the base, so the pull request
  gets no second request before the base moves again, and none while a
  request is waiting for Renovate. When its head commit is not Renovate's or
  the Renovate sync's, or Renovate noted someone else's commit, the sweep
  leaves it alone, since the rebase would drop that commit.

The preset keeps `rebaseWhen: 'conflicted'`: `behind-base-branch` would rebase
every open Renovate pull request on every merge, green ones included.

`gh workflow run renovate-sweep.yml` runs it on demand as a dry run, which
changes nothing and lists the moves it would make in the job summary;
`-f dry-run=false` makes them.

## Bot branch cleanup

GitHub deletes the head branch of a merged pull request and leaves the branch
of one closed unmerged. Renovate deletes its own: Mend's hosted app within a
minute or two of the close, the self-hosted one of `k8s-gitops-infra` on its
next run. The [module locks refresh](#module-locks-refresh) deletes
`antelopejs/module-locks` on its next daily run. Every other bot leaves its
branch behind. The reusable `bot-branch-cleanup.yml` workflow deletes it at the
close itself. Called on the `closed` type of `pull_request`, its job runs only
when the pull request is not merged, its author is a GitHub App or a bot
(`user.type` is `Bot`) and its head is a branch of the same repository, never
a fork's. It then deletes the head branch with the caller's `GITHUB_TOKEN`. It
leaves the branch alone, and says so in the job summary, when it is the default
branch or the pull request's base, when it is already gone, when it moved since
the pull request closed because a new push or a new pull request reuses it, when
it is protected or a ruleset forbids its deletion, or when another pull request
is open from it. A deletion GitHub refuses fails the job and names the
permission the caller lacks. A branch deleted with `GITHUB_TOKEN` starts no
other workflow.

```yaml
name: bot branch cleanup

on:
  pull_request:
    types: [closed]

permissions:
  contents: read

jobs:
  cleanup:
    permissions:
      contents: write
    uses: AntelopeJS/.github/.github/workflows/bot-branch-cleanup.yml@v2
```

The calling job grants `contents: write` and nothing else. The workflow takes no
input and no secret.

## Trunk and the merge queue

A repository develops on trunk: every pull request targets `main`, and GitHub's
merge queue squashes it onto `main` once the required check (`ci / checks`,
plus `ubuntu` in the DMS repositories) passes on the queued result. The
`merge_group` event runs the `queue` tier of `ci-node.yml`. A push to `main`
publishes nothing; a dispatch with `preview: true` publishes the preview
described in [npm releases](#npm-releases). There
is no integration branch: nothing needs promoting, and `main` stays releasable
as stable at any time.

This repository's own merge queue requires `checks`, the verdict job of
`checks.yml`. It runs on every pull request and merge group, with no path
filter, and calls the reusable `ci-metrics-checks.yml`, `ci-tier-checks.yml`,
`module-locks-checks.yml` and `release-train-checks.yml`. It fails and names
each one whose result is not `success`.

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
commit with a token of the `antelopejs-release` GitHub App, minted from
`RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` and scoped to the repository,
whose push starts the branch checks. When
the merge conflicts, it pushes nothing and fails with a message that names the
conflicting files: a `Next sync conflict` error annotation on the run, a line in
the job summary, and a failed run. It also opens one issue in the repository
with the default token, or comments on the one it opened before, and the next
successful sync closes that issue. A
repository admin resolves the conflict by merging `main` into the branch and
pushing the merge commit straight to it: a pull request would squash it, and
the same conflict would come back.

| Input | Default | Description |
| ----- | ------- | ----------- |
| `branch` | `next` | Branch that receives the default branch. |
| `RELEASE_APP_ID` (secret) | | ID of the GitHub App whose token pushes the merge. The branch ruleset must list the app as a bypass actor. |
| `RELEASE_APP_PRIVATE_KEY` (secret) | | Private key of that GitHub App. |
| `NOTION_TOKEN` (secret) | | Optional and unused: no workflow writes to Notion. Kept so that callers which still pass it are accepted. |

The calling job must grant `issues: write`: a
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

## Template demo sync

template-dms-adonis keeps a copy of template-dms-demo in `demo/`, and the
`demo-drift` job of its `ci.yml` fails while that copy differs from
template-dms-demo's `main`. `template-demo-sync.yml` runs every hour, at minute
47, in this repository and on demand by `workflow_dispatch`, and keeps one pull
request open on template-dms-adonis while they differ:

1. The `sync` job checks out both repositories, runs template-dms-adonis's own
   `scripts/sync-demo.sh` against template-dms-demo's `main`, which mirrors its
   `src`, `content` and `frontend-vue` into `demo/`. The synced
   `demo/frontend-vue/package.json` can declare a package at a higher version
   than the template's own `package.json` and `demo/package.json`, which its
   `dependency:one-range` check refuses, so
   [`scripts/module-locks/demo-sync-ranges-main.ts`](scripts/module-locks/demo-sync-ranges.ts)
   raises those ranges to the synced ones, and never lowers one. When a
   manifest moved, `pnpm install --lockfile-only` updates the root
   `pnpm-lock.yaml`. The job holds no write token.
2. The `publish` job pushes the result to the `antelopejs/demo-sync` branch of
   template-dms-adonis with the release app's token, limited to that
   repository, so the pull request's checks start. It refuses a patch that
   changes a path outside `demo/`, `package.json` and `pnpm-lock.yaml`, or
   makes a symlink or a submodule. It opens the
   `chore(demo): sync demo/ with template-dms-demo` pull request, whose body
   lists the raised ranges, or updates its body, and turns on its auto-merge,
   so it enters the merge queue once green. When `demo/` on `main` already
   matches, it closes that pull request.

The workflow lives here rather than in either template because `ajs project
init` copies every workflow of a template into each project made from it,
except `module-locks.yml` and `next-canary.yml`: an hourly schedule there would
run, skipped, in every such project. A pull request that changes the workflow
runs the `sync` job only and publishes nothing.

## Nightly failures the merge queue missed

`ci-metrics-nightly.yml` runs every day at 07:41 UTC, after the nightlies, in
this repository, on demand by `workflow_dispatch`, and on a pull request that
changes it or its script. It runs
[`scripts/ci-metrics/nightly-main.ts`](scripts/ci-metrics/README.md#nightly-failures-the-merge-queue-missed)
over the last 30 days, writes its Markdown report to the job summary, and
uploads it with the JSON report and dataset as the `nightly-report` artifact.
It reads the organization with the run's `GITHUB_TOKEN`, so it sees the public
repositories only.

Its `issue` job then keeps one issue of this repository, titled `Nightly CI
report`, in step with the latest nightly of each of those repositories, through
[`scripts/ci-metrics/nightly-issue-main.ts`](scripts/ci-metrics/README.md#the-nightly-ci-report-issue).
While a latest nightly is red, the issue is open and lists each red repository
with a link to that run and its failed jobs. A night that changes that list
rewrites the issue and comments with the new list, so whoever watches this
repository gets one notification for it. Once every latest nightly passes, the
job comments and closes the issue. The job writes with the run's
`GITHUB_TOKEN` and `issues: write` on this repository only, and does not run
on a pull request: a pull request run prints the issue it would write to its
job summary instead.

## Verdict conformance

`verdict-conformance.yml` runs every day at 06:11 UTC in this repository, on
demand by `workflow_dispatch`, and on a pull request that changes it or its
script. It runs `scripts/ci-verdict/main.ts`, which reads every unarchived
repository of the organization that has a `.github/workflows/ci.yml` with the
release app's token, and fails, listing each repository and its problems in the
job summary, when the merge queue of its default branch does not wait on
[its verdict](#the-verdict-of-a-caller) alone:

- `ci.yml` is not one `ci-node.yml` call and has no `verdict` job;
- its `verdict` job does not need a job of the file, or runs with anything but
  `if: ${{ !cancelled() }}`: without a status function a failed job skips it,
  and with `always()` a cancelled run waits for a runner only to fail it;
- a ruleset of the default branch requires a check other than the verdict, or
  none requires the verdict.

On a pull request the list does not fail the run, since it reads the
organization as it is, not the change.

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
    if: github.event_name != 'workflow_dispatch' || inputs.package-directory == 'packages/dms-automation'
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@v2
    with:
      release-version: ${{ inputs.release-version }}
      release-commit: ${{ inputs.release-commit }}
      dependency-ranges: ${{ inputs.dependency-ranges }}
      package-directory: packages/dms-automation
    secrets:
      RELEASE_APP_ID: ${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```

Both workflows install from the outermost directory at or above the package
directory whose `pnpm-workspace.yaml` lists the package in its `packages` globs.
A member's own standalone `pnpm-workspace.yaml`, which `antelopejs-sync` writes
next to each lockfile, does not stop that walk. When no workspace lists the
package, they install from the nearest directory that holds a
`pnpm-workspace.yaml`, or from the package directory when there is none. pnpm validates the root lockfile and installs every workspace
project, so the released package and the workspace dependencies it links
through `workspace:*` are installed together. No `--filter` is required.
