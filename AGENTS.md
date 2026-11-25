# AGENTS.md

This repository holds the AntelopeJS organization defaults: the community health files and `profile/`, the reusable workflows of `.github/workflows/` that other repositories call, and the release train of `scripts/release-train/`. `README.md` documents every workflow and its inputs, and `CONTRIBUTING.md` the caller examples.

## Callers

Every repository calls the shared workflows at the `v2` tag, as in `AntelopeJS/.github/.github/workflows/ci-node.yml@v2`. A change on `main` reaches no caller until the tag moves, and `v2` moves only when Antony says so. The callers are frozen: a change keeps every existing input, default, secret and permission as they are, so each caller keeps working without an edit. Release and next-sync callers forward `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`, as `antelopejs-sync` writes them. The app token is the only write token. `scripts/release-train/frozen-caller.yml` is the release caller that `antelopejs-sync` writes, and `caller.test.ts` checks the release workflows against it.

## Checks

The `Checks` workflow runs on every pull request and merge group. It calls the four `*-checks.yml` workflows, and its `checks` job, the check the merge queue requires, fails when any of them did not succeed. `release-train-checks.yml` runs these. Run them locally with Node.js 24 and pnpm 10. `pnpm run checks` runs oxlint with the full `antelopePreset()` of `@antelopejs/tooling-configs`, anti-slop and complexity rules included, over `scripts/**/*.ts` with the `SAFETY:` rule on:

```sh
pnpm install --frozen-lockfile
pnpm run checks
tools=$(mktemp -d)
npm install --no-save --no-audit --no-fund --silent --prefix "$tools" typescript@5.9.3 @types/node@24.10.1 release-it@19.2.4
"$tools/node_modules/.bin/tsc" -p scripts/release-train/tsconfig.json --typeRoots "$tools/node_modules/@types"
RELEASE_IT="$tools/node_modules/release-it/bin/release-it.js" node --test 'scripts/release-train/*.test.ts'
actionlint .github/workflows/*.yml
```

`RELEASE_IT` names the `bin/release-it.js` of release-it 19, which the stable release tests drive. Use actionlint 1.7.12, the version CI pins.
