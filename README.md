# AntelopeJS organization defaults

This repository contains the public profile, community health files, issue and
pull request templates, and reusable GitHub Actions workflows shared by the
[AntelopeJS organization](https://github.com/AntelopeJS).

The issue forms, the pull request template and `CONTRIBUTING.md` are also
copied into every AntelopeJS repository by the `sync-community-files`
workflow (`.github/sync.yml` lists the targets), so tools and agents that read
the repository see them too. Edit them here only; the workflow opens a pull
request on each target repository. Repositories can override any other
community file when they need project-specific guidance. Reusable workflows remain centrally maintained and are called from a
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
installation, and the `release-it` command. Git history, tags, and GitHub
release operations continue to use the checked-out repository.

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
repository and contains a `package.json`. It uses that directory for pnpm
caching, metadata validation, dependency installation, and the release command,
so unrelated root-level runtime packages are not installed. Public packages
continue to use npmjs with public access and provenance.
