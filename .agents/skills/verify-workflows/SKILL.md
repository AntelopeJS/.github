---
name: verify-workflows
description: Check a change in AntelopeJS/.github (the shared workflows, the release train and the scripts that test them) before pushing. Use it to pick the one command that checks what your diff touched.
---

# Verify a change in AntelopeJS/.github

The `Checks` workflow runs every check below in full on each pull request and in the merge queue. Locally, run only the rows your diff touches.

## Setup

Once per checkout. The tests need Node.js 26 and pnpm 12 (`packageManager`). The other tools go in a scratch prefix, at the versions CI pins:

```sh
pnpm install --frozen-lockfile
tools="$TMPDIR/verify-workflows-tools"
npm install --no-save --no-audit --no-fund --silent --prefix "$tools" node@26 typescript@5.9.3 @types/node@24.10.1 release-it@19.2.4 renovate@44.247.1
npm install --no-save --no-audit --no-fund --silent --prefix "$tools/pnpm10" pnpm@10.20.0
curl -fsSLo "$tools/actionlint.tgz" https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz
echo "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  $tools/actionlint.tgz" | sha256sum -c --quiet
tar -xzf "$tools/actionlint.tgz" -C "$tools" actionlint
curl -fsSL https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.xz | tar -xJ -C "$tools"
export PATH="$tools/node_modules/.bin:$tools/shellcheck-v0.11.0:$PATH"
```

`node -v` prints `v26.x` and `shellcheck --version` prints `0.11.0` once `PATH` is set. actionlint skips every shell rule when no `shellcheck` is on `PATH`, and the CI runners have one.

## What to run for your change

`<dir>` is the `scripts/` folder that owns the change: `ci-metrics`, `ci-tier`, `ci-verdict`, `module-locks` or `release-train`. Each test row runs one file with at most 4 workers. Name the test file next to the code you changed.

| Change | Command |
| --- | --- |
| A TypeScript file under `scripts/` | `pnpm exec oxlint <files>` then `tsc -p scripts/<dir>/tsconfig.json --typeRoots "$tools/node_modules/@types"` |
| A test or source of `release-train` | `RELEASE_IT="$tools/node_modules/release-it/bin/release-it.js" node --test --test-concurrency=4 scripts/release-train/<file>.test.ts` |
| A test or source of `module-locks` | `LOG_LEVEL=warn RENOVATE_MODULES="$tools/node_modules" node --test --test-concurrency=4 scripts/module-locks/<file>.test.ts` |
| A test or source of `ci-tier` | `PNPM="$tools/pnpm10/node_modules/.bin/pnpm" node --test --test-concurrency=4 scripts/ci-tier/<file>.test.ts` |
| A test or source of `ci-metrics` or `ci-verdict` | `node --test --test-concurrency=4 scripts/<dir>/<file>.test.ts` |
| A workflow under `.github/workflows/` | Lint: `"$tools/actionlint" <files>`, adding `-ignore SC2016` only for `ci-node.yml` and `ci-tier-checks.yml`, as `ci-tier-checks.yml` does. Test: `RELEASE_IT="$tools/node_modules/release-it/bin/release-it.js" node --test --test-concurrency=4 'scripts/release-train/workflows*.test.ts' scripts/release-train/caller.test.ts`, which read every workflow (runners, gates, publish steps, app tokens and their permissions). Then run each test that names the file, `grep -l '<file>.yml' scripts/*/*.test.ts`, with its folder's row: `ci-node.yml` alone is read by tests in `ci-tier`, `ci-verdict`, `module-locks` and `release-train`. |
| `scripts/release-train/frozen-caller.yml` | `RELEASE_IT="$tools/node_modules/release-it/bin/release-it.js" node --test --test-concurrency=4 scripts/release-train/caller.test.ts` |
| `renovate.json5` | `LOG_LEVEL=warn renovate-config-validator --strict --no-global renovate.json5`, then the `module-locks` row with `renovate-preset.test.ts` |
| `package.json`, `pnpm-lock.yaml`, `oxlint.config.ts` | `pnpm install --frozen-lockfile && pnpm run checks` |
| Markdown (`README.md`, `CONTRIBUTING.md`, `profile/`, community files) | No local command. Read the rendered file. The nightly `link-rot.yml` checks its links. |

A change to a reusable workflow (`on: workflow_call`) keeps every input, default, secret and permission, as `AGENTS.md` says. `caller.test.ts` and `workflows*.test.ts` enforce part of that rule.

## Services

No test needs a service. The tests stub git, GitHub and npm themselves.

## Left to CI

Read these results on your pull request. Rerun only the scoped row of a check that failed, to reproduce it.

- `Checks` (`checks.yml`, on pull requests and the merge queue). Five legs run on Linux: `ci-metrics`, `ci-tier`, `ci-verdict`, `module-locks` and `release-train`. Each leg typechecks, tests and actionlints its folder, and `release-train` also runs `pnpm run checks`. The `checks` job fails when a leg did not succeed. It is the check the merge queue requires.
- `ci-metrics-nightly.yml`, `verdict-conformance.yml` and `template-demo-sync.yml` also run on a pull request that touches their paths, and nightly or hourly on schedule.
- The schedule-only runs: `link-rot.yml`, `templates-fresh-clone.yml` and `renovate-sweep.yml`.
- How a reusable workflow behaves inside a caller (Windows legs, browser suites, releases). Nothing here runs it. It reaches callers only when Antony moves the `v2` tag.

## Done

The change is checked when every row its diff touches passed, with the command and its output shown. A row that could not run says why in the report.
