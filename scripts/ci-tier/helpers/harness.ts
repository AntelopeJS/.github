import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { readText } from "./read.ts";
import { type Context, type Step, block, field, interpolate, interpolateAll, keyed, keys, mapping, scope, step, stepOutputs } from "./workflow.ts";

const repoFile = (path: string): string => readText(new URL(`../../../${path}`, import.meta.url));
const action = repoFile(".github/actions/ci-tier/action.yml").split("\n");

/** The lines of `ci-node.yml`. */
export const ciNode = repoFile(".github/workflows/ci-node.yml").split("\n");

/** The lines of the `node` job of `ci-node.yml`. */
export const nodeJob = block(ciNode, ciNode.indexOf("  node:"));

/** The scratch directory of this test file, removed once its tests end. */
export const root = mkdtempSync(join(tmpdir(), "ci-tier-"));
after(() => rmSync(root, { recursive: true, force: true }));

const keyValues = (path: string): Record<string, string> =>
  Object.fromEntries(
    readText(path)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

/** What a step run left behind. */
export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  env: Record<string, string>;
  summary: string;
}

let runs = 0;

/** Runs the script of `step` in `cwd` the way a runner does, with only `PATH` and `env` set. */
export function runStep({ run }: Step, cwd: string, env: Record<string, string>): Run {
  runs += 1;
  const file = join(root, `step-${runs}.sh`);
  const files = { GITHUB_OUTPUT: `${file}.output`, GITHUB_ENV: `${file}.env`, GITHUB_STEP_SUMMARY: `${file}.summary` };
  writeFileSync(file, run);
  for (const path of Object.values(files)) writeFileSync(path, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
    cwd,
    encoding: "utf8",
    env: { PATH: `${ghBin}:${process.env.PATH}`, GIT_CEILING_DIRECTORIES: root, ...files, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs: keyValues(files.GITHUB_OUTPUT), env: keyValues(files.GITHUB_ENV), summary: readText(files.GITHUB_STEP_SUMMARY) };
}

/** `run`, once it exited 0. */
export function succeeded(run: Run): Run {
  assert.equal(run.status, 0, run.stderr);
  return run;
}

const pickName = "Pick the tier and the diff base from the event, the label and the changed files";

/** The run of the ci-tier action for the `github` context and the `inputs` set on it, with `env` added, such as the answers of the fake `gh`. */
export function runAction(github: Context, inputs: Record<string, string>, cwd: string, env: Record<string, string> = {}): Run {
  assert.equal(field(keyed(action, "runs"), "using"), "composite");
  const pick = step(action, pickName);
  assert.equal(pick.shell, "bash");
  const declaredInputs = keyed(action, "inputs");
  const defaults = Object.fromEntries(keys(declaredInputs).map((name) => [name, interpolate(field(keyed(declaredInputs, name), "default") ?? "", {})]));
  return runStep(pick, cwd, { ...interpolateAll(pick.env, { ...github, ...scope("inputs", { ...defaults, ...inputs }) }), ...env });
}

/** The outputs of the ci-tier action for the `github` context and the `inputs` set on it. */
export function actionOutputs(github: Context, inputs: Record<string, string>, cwd: string, env: Record<string, string> = {}): Record<string, string> {
  const pick = step(action, pickName);
  const { outputs } = succeeded(runAction(github, inputs, cwd, env));
  const declaredOutputs = keyed(action, "outputs");
  const steps = stepOutputs(pick, outputs);
  return Object.fromEntries(keys(declaredOutputs).map((name) => [name, interpolate(field(keyed(declaredOutputs, name), "value") ?? "", steps)]));
}

/** What one leg of the node job runs. */
export interface Expected {
  tier: string;
  base: string;
  tests: string;
  "test-base": string;
  work: string;
}

const tierStepName = "Pick the tier";
const legStepName = "Pick the work of this leg from the tier";

/** What the `part` leg of the node job runs for the `github` event and the repository `vars`. */
export function leg(github: Context, vars: Context, part: string, cwd: string): Expected {
  const position = (name: string): number => nodeJob.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(position(tierStepName) < position(legStepName), "the tier is picked before the leg reads it");
  const pickTier = step(nodeJob, tierStepName);
  assert.equal(pickTier.uses, "AntelopeJS/.github/.github/actions/ci-tier@v2");
  const tier = actionOutputs(github, interpolateAll(pickTier.with, scope("vars", vars)), cwd);
  const pickWork = step(nodeJob, legStepName);
  const tierSteps = stepOutputs(pickTier, tier);
  const { outputs, env } = succeeded(runStep(pickWork, cwd, interpolateAll(pickWork.env, { ...github, ...tierSteps, ...scope("matrix", { part }) })));
  const job = interpolateAll(mapping(keyed(nodeJob, "outputs")), { ...tierSteps, ...stepOutputs(pickWork, outputs) });
  assert.equal(env.ANTELOPEJS_CI_TIER, job.tier, "the commands of the leg read the tier of the job");
  return { tier: job.tier, base: tier.base, tests: outputs.tests, "test-base": env.ANTELOPEJS_TEST_BASE, work: outputs.work };
}

/** The trimmed output of `git args` in `cwd`, once it exited 0. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd: string, files: string[], content: string): void {
  for (const file of files) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  }
}

/** A repository and the commit its change starts from. */
export interface Checkout {
  cwd: string;
  base: string;
}

/** A repository with `files` in its base commit and `changed` in the commit on top. */
export function repo(name: string, files: Record<string, string>, changed: string[]): Checkout {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--quiet", "--initial-branch=main");
  for (const [file, content] of Object.entries(files)) write(cwd, [file], content);
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  write(cwd, changed, "changed\n");
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", "change");
  return { cwd, base };
}

const plainFiles = Object.fromEntries(["README.md", "package.json", "docs/guide.md", "src/index.ts"].map((file) => [file, "base\n"]));

/** A plain repository whose change touches `changed`. */
export const checkout = (name: string, changed: string[]): Checkout => repo(name, plainFiles, changed);

/** A depth-1 clone of a plain repository whose change touches `changed`. */
export function shallowCheckout(name: string, changed: string[]): Checkout {
  const upstream = checkout(`${name}-upstream`, changed);
  const origin = join(root, `${name}-origin.git`);
  git(root, "clone", "--quiet", "--bare", upstream.cwd, origin);
  const cwd = join(root, name);
  git(root, "clone", "--quiet", "--depth=1", `file://${origin}`, cwd);
  assert.notEqual(spawnSync("git", ["cat-file", "-e", `${upstream.base}^{commit}`], { cwd }).status, 0, "the shallow clone lacks the base");
  return { cwd, base: upstream.base };
}

/** The `github` context of a `name` event on `ref`, with `fields` added under `github`. */
export const event = (name: string, ref: string, fields: Context = {}): Context =>
  scope("github", {
    event_name: name,
    ref_name: ref,
    repository: "AntelopeJS/example",
    token: "token",
    server_url: "https://github.com",
    run_id: "42",
    "event.repository.default_branch": "main",
    ...fields,
  });

interface PullRequestOptions {
  draft?: boolean;
  labels?: string[];
}

/** The `github` context of a pull request from `head` into `target`, given its base commit. */
export const pullRequest =
  (target: string, head: string, { draft = false, labels = [] }: PullRequestOptions = {}) =>
  (base: string): Context =>
    event("pull_request", "1/merge", {
      "event.pull_request.draft": String(draft),
      "event.pull_request.base.sha": base,
      "event.pull_request.labels.*.name": labels,
      base_ref: target,
      head_ref: head,
    });

/** The `github` context of a merge group on `main`, given its base commit. */
export const mergeGroup = (base: string): Context => event("merge_group", "gh-readonly-queue/main/pr-1-abc", { "event.merge_group.base_sha": base, "event.merge_group.base_ref": "refs/heads/main" });

/** The `github` context of a `name` event on `ref`, for any base commit. */
export const other = (name: string, ref: string) => (): Context => event(name, ref);

const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "pnpm"),
  [
    "#!/usr/bin/env bash",
    'calls=$(( $(cat "$FAKE_CALLS" 2> /dev/null || echo 0) + 1 ))',
    'echo "$calls" > "$FAKE_CALLS"',
    "printf '\\033[31m%s\\033[0m\\n' \"FAIL src/flaky.test.ts attempt ${calls}\"",
    "codes=($FAKE_CODES)",
    'exit "${codes[calls - 1]}"',
  ].join("\n"),
  { mode: 0o755 },
);

/**
 * A fake `gh`, first on the `PATH` of every step, so no test calls GitHub. It logs each call and its token to
 * `FAKE_GH_LOG`, and answers `gh api …/git/matching-refs/…` with `FAKE_GH_REFS` and `gh api …/compare/…` with
 * `FAKE_GH_COMPARE`, as their `--jq` would print them. An unset answer fails the call, as a failed API call does.
 */
const ghBin = join(root, "gh-bin");
mkdirSync(ghBin);
writeFileSync(
  join(ghBin, "gh"),
  [
    "#!/usr/bin/env bash",
    'printf "%s token=%s\\n" "$*" "${GH_TOKEN:-none}" >> "${FAKE_GH_LOG:-/dev/null}"',
    'case "$1 $2" in',
    '  "api "*/git/matching-refs/*) [ -n "${FAKE_GH_REFS+set}" ] || exit 1; [ -z "$FAKE_GH_REFS" ] || printf "%s\\n" "$FAKE_GH_REFS" ;;',
    '  "api "*/compare/*) [ -n "${FAKE_GH_COMPARE+set}" ] || exit 1; printf "%s\\n" "$FAKE_GH_COMPARE" ;;',
    "  *) exit 1 ;;",
    "esac",
  ].join("\n"),
  { mode: 0o755 },
);

/** The `github` context of a merge group on `main` whose branch is `gh-readonly-queue/main/pr-1-<parent>` and whose head is `head`. */
export const mergeGroupAt = (base: string, head: string): Context => ({
  ...mergeGroup(base),
  ...scope("github", { "event.merge_group.head_ref": "refs/heads/gh-readonly-queue/main/pr-1-abc", "event.merge_group.head_sha": head }),
});

/** The environment of a fake `pnpm` that prints a failure and exits with each code of `FAKE_CODES` in turn, counting its calls in `dir`. */
export const fakeEnv = (dir: string, extra: Record<string, string>) => ({
  PATH: `${bin}:${process.env.PATH}`,
  RUNNER_TEMP: dir,
  FAKE_CALLS: join(dir, "calls"),
  ...extra,
});
