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
3. Install dependencies with the lockfile intact.
4. Make the smallest change that solves the problem.
5. Run the repository's formatting, linting, type-checking, and test commands.
6. Add or update documentation and tests when behavior changes.

Do not commit generated artifacts, credentials, or unrelated formatting
changes unless the repository explicitly requires them.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit and
pull request titles, for example `fix(api): handle an empty response`.

Pull requests should:

- explain the problem and the chosen solution;
- link the relevant issue or discussion;
- call out breaking changes and migration steps;
- include evidence that the change was tested;
- remain small enough to review safely.

Maintainers may ask for changes before merging. AntelopeJS repositories
normally squash pull requests, so the pull request title becomes the commit on
the default branch.

## Release channels

npm packages are published from two branches, each bound to one npm
distribution tag:

| Branch | npm dist-tag | Versions             |
| ------ | ------------ | -------------------- |
| `main` | `latest`     | `1.9.0`              |
| `next` | `next`       | `1.9.0-next.0`, etc. |

The Release workflow refuses any other combination: `latest` only releases
from `main`, and `next` only releases from `next`.

Anything merged into `main` must be releasable as stable at any time.

### Reusable release workflows

Repositories call the reusable workflows of this repository,
`release-npm-public.yml` or `release-npm-private.yml`, through the `v1` tag:

```yaml
jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@v1
```

`v1` is a moving tag. After each merge that changes these workflows, it is
re-pointed to the latest `main` commit, so every repository picks up the change
without editing its own workflow. Changes released under `v1` must therefore be
backward compatible. A breaking change, such as a new required input or a
removed input, needs a new `v2` tag, and repositories move to it explicitly.

When the tests run by `pnpm release` need service containers, such as a
database or a storage emulator, describe them in a docker compose file and pass
its path, relative to the repository root, as `services-compose-file`. The
workflow runs `docker compose -f <file> up -d --wait` before publishing, so
give each service a healthcheck when readiness matters, and always runs
`docker compose -f <file> down -v` at the end of the job. The file must be a
regular file inside the repository. Release secrets are not passed to the
compose commands.

### Work that is not ready to ship

Keep the feature branch open, as a draft pull request against `main`, until the
change is ready to release.

If consumers need a published build to test it, open a prerelease cycle:

1. Create `next` from `main` if it does not exist yet.
2. Open the pull request against `next` instead of `main`.
3. After merging, run the Release workflow on `next` with the `next` channel.
4. Consumers install `@antelopejs/<package>@next`.

Prerelease commits are named `release: v1.9.0-next.0` instead of
`chore(release): v1.9.0-next.0`. `release` is not a changelog type, so these
commits never show up in a changelog, in particular not in the stable changelog
that later covers the whole cycle. Stable releases keep
`chore(release): v1.9.0`.

### Stable fixes during a prerelease cycle

1. Open the fix against `main` and release it on the `latest` channel.
2. Rebase `next` onto `main` so the cycle includes the fix:

   ```sh
   git switch next
   git fetch origin
   git rebase origin/main
   git push --force-with-lease
   ```

   On conflicts in the `package.json` version or at the top of `CHANGELOG.md`,
   keep the `next` side.

### Promoting `next` to stable

1. Open a pull request from `next` to `main` and merge it with **Rebase and
   merge**, so the cycle's commits land on `main` individually.
2. Run the Release workflow on `main` with the `latest` channel.
3. Delete the `next` branch.

Stable releases ignore prerelease tags. The stable changelog therefore covers
every commit since the previous stable release, not just those since the last
`-next` tag. When `package.json` holds a prerelease such as `1.9.0-next.4`, the
stable release is pinned to its base version, `1.9.0`, even if the cycle
contains breaking commits. Choose the right major or minor version when
opening the cycle.
