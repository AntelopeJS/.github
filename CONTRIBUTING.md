<!-- Synced from https://github.com/AntelopeJS/.github - edit it there, not in this repository. -->
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

## Pull requests opened by tools and agents

GitHub only applies `.github/PULL_REQUEST_TEMPLATE.md` when a person opens the
pull request from the web interface. A pull request created through the API,
`gh pr create` with a body, or an AI agent must reproduce the template's
sections itself: Summary, Related issue, Verification and the Checklist, with
the boxes ticked for what was actually done. The same goes for issues: use the
fields of the forms in `.github/ISSUE_TEMPLATE/`.

Maintainers may ask for changes before merging. AntelopeJS repositories
normally squash pull requests, so the pull request title becomes the commit on
the default branch.
