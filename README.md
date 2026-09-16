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
installation, and the `release-it` command. Git history, tags, and GitHub
release operations continue to use the checked-out repository.
