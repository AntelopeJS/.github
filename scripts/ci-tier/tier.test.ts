import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { readText } from "./helpers/read.ts";

const repoFile = (path: string): string => readText(new URL(`../../${path}`, import.meta.url));
const action = repoFile(".github/actions/ci-tier/action.yml").split("\n");
const ciNode = repoFile(".github/workflows/ci-node.yml").split("\n");
const root = mkdtempSync(join(tmpdir(), "ci-tier-"));
after(() => rmSync(root, { recursive: true, force: true }));

const indent = (line: string): number => line.length - line.trimStart().length;

function block(lines: string[], start: number): string[] {
  const own = indent(lines[start]);
  const end = lines.findIndex((line, index) => index > start && line.trim() !== "" && indent(line) <= own);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function keyed(lines: string[], key: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  assert.notEqual(start, -1, `no ${key}`);
  return block(lines, start);
}

function field(lines: string[], key: string): string | undefined {
  const own = Math.min(...lines.filter((line) => line.trim() !== "").map(indent));
  const line = lines.find((candidate) => indent(candidate) === own && candidate.trim().startsWith(`${key}: `));
  return line?.trim().slice(key.length + 2);
}

function ownLines(lines: string[]): string[] {
  const own = Math.min(...lines.filter((line) => line.trim() !== "").map(indent));
  return lines.filter((line) => line.trim() !== "" && indent(line) === own);
}

const keys = (lines: string[]): string[] => ownLines(lines).map((line) => line.trim().split(":")[0]);

const mapping = (lines: string[]): Record<string, string> =>
  Object.fromEntries(
    ownLines(lines).map((line) => {
      const [key, ...value] = line.trim().split(": ");
      return [key, value.join(": ")];
    }),
  );

type Value = string | boolean | Context | Context[] | undefined;
interface Context {
  [key: string]: Value;
}

function lookup(path: string, context: Context): Value {
  let value: Value = context;
  for (const key of path.split(".")) value = typeof value === "object" && !Array.isArray(value) ? (Object.hasOwn(value, key) ? value[key] : undefined) : undefined;
  return value;
}

function evaluate(expression: string, context: Context): string {
  if (expression.includes(" || ")) return expression.split(" || ").map((operand) => evaluate(operand, context)).find((value) => value !== "") ?? "";
  const contains = /^contains\(([\w.-]+)\.\*\.([\w-]+), '([^']*)'\)$/.exec(expression);
  if (contains) {
    const [, path, key, wanted] = contains;
    const items = lookup(path, context);
    return String(Array.isArray(items) && items.some((item) => item[key] === wanted));
  }
  assert.match(expression, /^[\w.-]+$/, `not an expression this test evaluates: ${expression}`);
  const value = lookup(expression, context);
  if (value === undefined) return "";
  assert.ok(typeof value === "string" || typeof value === "boolean", `${expression} is not a value`);
  return String(value);
}

const interpolate = (value: string, context: Context): string =>
  value.replace(/^"(.*)"$/, "$1").replace(/\$\{\{ (.+?) \}\}/g, (_, expression: string) => evaluate(expression, context));

const interpolateAll = (values: Record<string, string>, context: Context): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolate(value, context)]));

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  shell?: string;
  env: Record<string, string>;
  with: Record<string, string>;
  run: string;
}

function step(lines: string[], name: string): Step {
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `no step ${name}`);
  const body = [lines[start].replace("- name:", "  name:"), ...block(lines, start)];
  const section = (key: string): Record<string, string> => (body.some((line) => line.trim() === `${key}:`) ? mapping(keyed(body, key)) : {});
  const runLine = body.findIndex((line) => line.trim() === "run: |");
  const script = runLine === -1 ? [] : block(body, runLine);
  const run = script.map((line) => line.slice(indent(script[0]))).join("\n");
  return { id: field(body, "id"), if: field(body, "if"), uses: field(body, "uses"), shell: field(body, "shell"), env: section("env"), with: section("with"), run };
}

function stepId({ id }: Step): string {
  assert.ok(id, "the step has no id");
  return id;
}

const keyValues = (path: string): Record<string, string> =>
  Object.fromEntries(
    readText(path)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  env: Record<string, string>;
  summary: string;
}

let runs = 0;
function runStep({ run }: Step, cwd: string, env: Record<string, string>): Run {
  runs += 1;
  const file = join(root, `step-${runs}.sh`);
  const files = { GITHUB_OUTPUT: `${file}.output`, GITHUB_ENV: `${file}.env`, GITHUB_STEP_SUMMARY: `${file}.summary` };
  writeFileSync(file, run);
  for (const path of Object.values(files)) writeFileSync(path, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: root, ...files, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs: keyValues(files.GITHUB_OUTPUT), env: keyValues(files.GITHUB_ENV), summary: readText(files.GITHUB_STEP_SUMMARY) };
}

function succeeded(run: Run): Run {
  assert.equal(run.status, 0, run.stderr);
  return run;
}

function actionOutputs(github: Context, inputs: Record<string, string>, cwd: string): Record<string, string> {
  assert.equal(field(keyed(action, "runs"), "using"), "composite");
  const pick = step(action, "Pick the tier and the diff base from the event, the label and the changed files");
  assert.equal(pick.shell, "bash");
  const declaredInputs = keyed(action, "inputs");
  const defaults = Object.fromEntries(keys(declaredInputs).map((name) => [name, interpolate(field(keyed(declaredInputs, name), "default") ?? "", {})]));
  const { outputs } = succeeded(runStep(pick, cwd, interpolateAll(pick.env, { github, inputs: { ...defaults, ...inputs } })));
  const declaredOutputs = keyed(action, "outputs");
  const steps = { [stepId(pick)]: { outputs } };
  return Object.fromEntries(keys(declaredOutputs).map((name) => [name, interpolate(field(keyed(declaredOutputs, name), "value") ?? "", { steps })]));
}

const nodeJob = block(ciNode, ciNode.indexOf("  node:"));
const tierStepName = "Pick the tier";
const legStepName = "Pick the work of this leg from the tier";

function leg(github: Context, vars: Context, part: string, cwd: string): Record<string, string> {
  const position = (name: string): number => nodeJob.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(position(tierStepName) < position(legStepName), "the tier is picked before the leg reads it");
  const pickTier = step(nodeJob, tierStepName);
  assert.equal(pickTier.uses, "AntelopeJS/.github/.github/actions/ci-tier@v2");
  const tier = actionOutputs(github, interpolateAll(pickTier.with, { vars }), cwd);
  const steps: Context = { [stepId(pickTier)]: { outputs: tier } };
  const pickWork = step(nodeJob, legStepName);
  const { outputs, env } = succeeded(runStep(pickWork, cwd, interpolateAll(pickWork.env, { github, steps, matrix: { part } })));
  steps[stepId(pickWork)] = { outputs };
  const job = interpolateAll(mapping(keyed(nodeJob, "outputs")), { steps });
  assert.equal(env.ANTELOPEJS_CI_TIER, job.tier, "the commands of the leg read the tier of the job");
  return { tier: job.tier, base: tier.base, tests: outputs.tests, "test-base": env.ANTELOPEJS_TEST_BASE, work: outputs.work };
}

function git(cwd: string, ...args: string[]): string {
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

interface Checkout {
  cwd: string;
  base: string;
}

function repo(name: string, files: Record<string, string>, changed: string[]): Checkout {
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

const checkout = (name: string, changed: string[]): Checkout => repo(name, plainFiles, changed);

function shallowCheckout(name: string, changed: string[]): Checkout {
  const upstream = checkout(`${name}-upstream`, changed);
  const origin = join(root, `${name}-origin.git`);
  git(root, "clone", "--quiet", "--bare", upstream.cwd, origin);
  const cwd = join(root, name);
  git(root, "clone", "--quiet", "--depth=1", `file://${origin}`, cwd);
  assert.notEqual(spawnSync("git", ["cat-file", "-e", `${upstream.base}^{commit}`], { cwd }).status, 0, "the shallow clone lacks the base");
  return { cwd, base: upstream.base };
}

const repository = "AntelopeJS/example";
const event = (name: string, ref: string, payload: Context = {}): Context => ({
  event_name: name,
  ref_name: ref,
  repository,
  token: "token",
  server_url: "https://github.com",
  run_id: "42",
  event: { repository: { default_branch: "main" }, ...payload },
});
interface PullRequestOptions {
  draft?: boolean;
  labels?: string[];
}

const pullRequest =
  (target: string, head: string, { draft = false, labels = [] }: PullRequestOptions = {}) =>
  (base: string): Context => ({
    ...event("pull_request", "1/merge", { pull_request: { draft, base: { sha: base }, labels: labels.map((name) => ({ name })) } }),
    base_ref: target,
    head_ref: head,
  });
const mergeGroup = (base: string): Context => event("merge_group", "gh-readonly-queue/main/pr-1-abc", { merge_group: { base_sha: base, base_ref: "refs/heads/main" } });
const other = (name: string, ref: string) => (): Context => event(name, ref);

const BASE = "<the checkout's base commit>";

interface Expected {
  tier: string;
  base: string;
  tests: string;
  "test-base": string;
  work: string;
}

interface ContractRow {
  name: string;
  github: (base: string) => Context;
  changed?: string[];
  vars?: Context;
  part?: string;
  expected: Expected;
}

const contract: ContractRow[] = [
  { name: "draft PR", github: pullRequest("main", "feat/x", { draft: true }), expected: { tier: "fast", base: BASE, tests: "true", "test-base": BASE, work: "true" } },
  { name: "ready PR", github: pullRequest("main", "feat/x"), expected: { tier: "fast", base: BASE, tests: "true", "test-base": BASE, work: "true" } },
  { name: "docs-only PR, test leg", github: pullRequest("main", "docs/x"), changed: ["docs/guide.md"], part: "test", expected: { tier: "fast", base: BASE, tests: "false", "test-base": BASE, work: "false" } },
  { name: "docs-only PR, single leg", github: pullRequest("main", "docs/x"), changed: ["docs/guide.md"], expected: { tier: "fast", base: BASE, tests: "false", "test-base": BASE, work: "true" } },
  { name: "PR changing the root package.json", github: pullRequest("main", "feat/x"), changed: ["package.json"], expected: { tier: "full", base: BASE, tests: "true", "test-base": "", work: "true" } },
  { name: "PR changing a nested pnpm-lock.yaml", github: pullRequest("main", "feat/x"), changed: ["frontend/pnpm-lock.yaml"], expected: { tier: "full", base: BASE, tests: "true", "test-base": "", work: "true" } },
  { name: "PR changing a workflow", github: pullRequest("main", "feat/x"), changed: [".github/workflows/ci.yml"], expected: { tier: "full", base: BASE, tests: "true", "test-base": "", work: "true" } },
  { name: "PR changing a workflow whose name is not ASCII", github: pullRequest("main", "feat/x"), changed: [".github/workflows/déploiement.yml"], expected: { tier: "full", base: BASE, tests: "true", "test-base": "", work: "true" } },
  { name: "PR changing the root README.md only", github: pullRequest("main", "docs/x"), changed: ["README.md"], expected: { tier: "fast", base: BASE, tests: "false", "test-base": BASE, work: "true" } },
  { name: "PR labeled ci:full", github: pullRequest("main", "feat/x", { labels: ["bug", "ci:full"] }), expected: { tier: "full", base: BASE, tests: "true", "test-base": "", work: "true" } },
  { name: "PR in a repository whose CI_SELECTION is full", github: pullRequest("main", "feat/x"), vars: { CI_SELECTION: "full" }, expected: { tier: "full", base: BASE, tests: "true", "test-base": "", work: "true" } },
  { name: "PR from next into main", github: pullRequest("main", "next"), expected: { tier: "fast", base: BASE, tests: "true", "test-base": BASE, work: "true" } },
  { name: "merge_group", github: mergeGroup, expected: { tier: "queue", base: BASE, tests: "true", "test-base": "", work: "true" } },
  { name: "push to main", github: other("push", "main"), expected: { tier: "none", base: "", tests: "false", "test-base": "", work: "false" } },
  { name: "push to next", github: other("push", "next"), expected: { tier: "full", base: "", tests: "true", "test-base": "", work: "true" } },
  { name: "schedule", github: other("schedule", "main"), expected: { tier: "nightly", base: "", tests: "true", "test-base": "", work: "true" } },
  { name: "workflow_dispatch", github: other("workflow_dispatch", "main"), expected: { tier: "full", base: "", tests: "true", "test-base": "", work: "true" } },
];

const withBase = (expected: Expected, base: string): Expected => ({
  ...expected,
  base: expected.base === BASE ? base : expected.base,
  "test-base": expected["test-base"] === BASE ? base : expected["test-base"],
});

describe("the tier contract", () => {
  contract.forEach((row, index) => {
    test(`${row.name} runs the ${row.expected.tier} tier`, () => {
      const { cwd, base } = checkout(`contract-${index}`, row.changed ?? ["src/index.ts"]);
      assert.deepEqual(leg(row.github(base), row.vars ?? {}, row.part ?? "all", cwd), withBase(row.expected, base));
    });
  });

  test("a PR whose base is missing from the shallow clone fetches it from origin", () => {
    const { cwd, base } = shallowCheckout("shallow", ["src/index.ts"]);
    assert.deepEqual(leg(pullRequest("main", "feat/x")(base), {}, "all", cwd), { tier: "fast", base, tests: "true", "test-base": base, work: "true" });
    assert.equal(git(cwd, "cat-file", "-t", base), "commit");
  });

  test("a PR without a checkout picks the fast tier, so a job that calls the action before any checkout keeps working", () => {
    const empty = join(root, "no-checkout");
    mkdirSync(empty);
    const base = "0123456789abcdef0123456789abcdef01234567";
    assert.deepEqual(actionOutputs(pullRequest("main", "feat/x")(base), {}, empty), { tier: "fast", base });
  });
});

describe("the fast tier", () => {
  const fastTests = (name: string, changed: string[]): string => {
    const { cwd, base } = checkout(name, changed);
    return leg(pullRequest("main", "feat/x")(base), {}, "all", cwd).tests;
  };

  test("skips the tests for playground content only", () => {
    assert.equal(fastTests("playground", ["packages/dms/playground/src/app.ts", "README.md"]), "false");
  });

  test("runs the tests when a checks config under a playground changes", () => {
    assert.equal(fastTests("playground-checks", ["packages/dms/playground/checks/client-lint.config.mjs"]), "true");
  });

  test("runs the tests when a checks config changes next to playground content", () => {
    assert.equal(fastTests("playground-both", ["packages/dms/playground/src/app.ts", "packages/dms/playground/checks/client-lint.config.mjs"]), "true");
  });
});

test("ci-node.yml calls the ci-tier action at v2, keeps the checks gate with the title check, and has no gitleaks job", () => {
  const uses = ciNode.filter((line) => line.includes("ci-tier"));
  assert.notEqual(uses.length, 0);
  for (const line of uses) assert.equal(line.trim(), "uses: AntelopeJS/.github/.github/actions/ci-tier@v2");
  const jobs = keys(keyed(ciNode, "jobs"));
  assert.ok(jobs.includes("checks"), "the required check is ci / checks");
  assert.ok(!jobs.includes("gitleaks"));
  assert.ok(block(ciNode, ciNode.indexOf("  checks:")).some((line) => line.trim().startsWith("pattern='")), "the checks job checks the pull request title");
});

describe("the base branch fetch", () => {
  const cases = [
    { name: "a pull request", github: pullRequest("main", "feat/x")("") },
    { name: "a merge group", github: mergeGroup("") },
  ];
  cases.forEach(({ name, github }, index) => {
    test(`stores origin/main for ${name}`, () => {
      const { cwd } = shallowCheckout(`fetch-${index}`, ["src/index.ts"]);
      git(cwd, "update-ref", "-d", "refs/remotes/origin/main");
      const fetch = step(nodeJob, "Fetch the base branch");
      succeeded(runStep(fetch, cwd, interpolateAll(fetch.env, { github })));
      assert.equal(git(cwd, "rev-parse", "refs/remotes/origin/main"), git(cwd, "ls-remote", "origin", "refs/heads/main").split("\t")[0]);
    });
  });
});

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
const fakeEnv = (dir: string, extra: Record<string, string>): Record<string, string> => ({
  PATH: `${bin}:${process.env.PATH}`,
  RUNNER_TEMP: dir,
  FAKE_CALLS: join(dir, "calls"),
  ...extra,
});

describe("the test step", () => {
  const runTests = step(nodeJob, "Run tests");
  const cases = [
    { name: "a test that fails, then passes, in the merge queue marks the run flaky", tier: "queue", codes: "1 0", status: 0, calls: 2, flaky: "true" },
    { name: "a test that fails twice in the merge queue fails the job", tier: "queue", codes: "1 1", status: 1, calls: 2, flaky: undefined },
    { name: "a pull request never retries a failed test", tier: "fast", codes: "1 0", status: 1, calls: 1, flaky: undefined },
    { name: "a passing test runs once", tier: "queue", codes: "0", status: 0, calls: 1, flaky: undefined },
  ];
  for (const { name, tier, codes, status, calls, flaky } of cases) {
    test(name, () => {
      const dir = mkdtempSync(join(root, "tests-"));
      const run = runStep(runTests, dir, { ...interpolateAll(runTests.env, {}), ...fakeEnv(dir, { ANTELOPEJS_CI_TIER: tier, FAKE_CODES: codes }) });
      assert.equal(run.status, status, run.stderr);
      assert.equal(readText(join(dir, "calls")).trim(), String(calls));
      assert.equal(run.outputs.flaky, flaky);
    });
  }
});

describe("the extra commands step", () => {
  const runExtra = step(nodeJob, "Run extra commands");
  const cases = [
    { name: "commands that fail, then pass, in the merge queue mark the run flaky", tier: "queue", codes: "1 0", status: 0, calls: 2, flaky: "true" },
    { name: "commands that fail twice in the merge queue fail the job", tier: "queue", codes: "1 1", status: 1, calls: 2, flaky: undefined },
    { name: "a pull request never retries failed commands", tier: "fast", codes: "1 0", status: 1, calls: 1, flaky: undefined },
    { name: "a nightly run never retries failed commands", tier: "nightly", codes: "1 0", status: 1, calls: 1, flaky: undefined },
    { name: "passing commands run once", tier: "queue", codes: "0", status: 0, calls: 1, flaky: undefined },
  ];
  for (const { name, tier, codes, status, calls, flaky } of cases) {
    test(name, () => {
      const dir = mkdtempSync(join(root, "extra-"));
      const env = interpolateAll(runExtra.env, { inputs: { "extra-commands": "pnpm run integration" } });
      const run = runStep(runExtra, dir, { ...env, ...fakeEnv(dir, { ANTELOPEJS_CI_TIER: tier, FAKE_CODES: codes }) });
      assert.equal(run.status, status, run.stderr);
      assert.equal(readText(join(dir, "calls")).trim(), String(calls));
      assert.equal(run.outputs.flaky, flaky);
    });
  }

  test("the log of the first attempt, with its standard error, is the one the annotations read", () => {
    const dir = mkdtempSync(join(root, "extra-"));
    const env = interpolateAll(runExtra.env, { inputs: { "extra-commands": "pnpm run integration >&2" } });
    succeeded(runStep(runExtra, dir, { ...env, ...fakeEnv(dir, { ANTELOPEJS_CI_TIER: "queue", FAKE_CODES: "1 0" }) }));
    const log = readText(join(dir, "extra-attempt-1.log"));
    assert.match(log, /FAIL src\/flaky\.test\.ts attempt 1/);
    assert.doesNotMatch(log, /attempt 2/);
  });
});

describe("the affected tests", () => {
  const runTests = step(nodeJob, "Run tests");
  const runners = join(root, "runners");
  mkdirSync(runners);
  for (const name of ["vitest", "jest", "mocha"]) {
    writeFileSync(join(runners, name), ["#!/usr/bin/env bash", `echo "${name} $*" >> "$TEST_LOG"`].join("\n"), { mode: 0o755 });
  }

  const manifest = (name: string, fields: Record<string, unknown> = {}): string => JSON.stringify({ name, version: "1.0.0", private: true, ...fields });
  const logging = (name: string): { scripts: { test: string } } => ({ scripts: { test: `echo ${name} >> "$TEST_LOG"` } });
  const workspaceFiles = {
    "package.json": manifest("root", logging("root")),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/a/package.json": manifest("a", logging("a")),
    "packages/a/src/index.js": "base\n",
    "packages/b/package.json": manifest("b", { ...logging("b"), dependencies: { a: "workspace:*" } }),
    "packages/c/package.json": manifest("c", logging("c")),
    "packages/d/package.json": manifest("d"),
    "scripts/x.mjs": "base\n",
  };
  const workspace = (name: string, changed: string[]): Checkout => repo(name, workspaceFiles, changed);
  const single = (name: string, script: string): Checkout => repo(name, { "package.json": manifest(name, { scripts: { test: script } }), "src/index.ts": "base\n" }, ["src/index.ts"]);

  interface Outcome {
    run: Run;
    calls: string[];
    base: string;
  }

  function runPullRequestTests(project: Checkout, github: (base: string) => Context, affectedTests = "true"): Outcome {
    const pnpm = process.env.PNPM;
    assert.ok(pnpm, "PNPM names the pnpm 10 binary the affected tests drive");
    const picked = leg(github(project.base), {}, "all", project.cwd);
    const dir = mkdtempSync(join(root, "affected-"));
    const log = join(dir, "calls");
    const env = {
      ...interpolateAll(runTests.env, { inputs: { "affected-tests": affectedTests } }),
      PATH: `${dirname(pnpm)}:${runners}:${process.env.PATH}`,
      HOME: dir,
      RUNNER_TEMP: dir,
      TEST_LOG: log,
      PRIMARY_LEG: "true",
      ANTELOPEJS_CI_TIER: picked.tier,
      ANTELOPEJS_TEST_BASE: picked["test-base"],
    };
    const run = runStep(runTests, project.cwd, env);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    return { run, calls: (existsSync(log) ? readText(log) : "").split("\n").map((line) => line.trim()).filter((line) => line !== "").sort(), base: project.base };
  }

  const pull = pullRequest("main", "feat/x");

  test("a pull request that touches a package runs the tests of that package and of its dependents only", () => {
    const { run, calls } = runPullRequestTests(workspace("affected-package", ["packages/a/src/index.js"]), pull);
    assert.deepEqual(calls, ["a", "b"], "c has no link to a, d has no test script, the root test script stays out");
    assert.match(run.summary, /^Tests: `pnpm --filter \.\.\.\[[0-9a-f]{40}\] --workspace-concurrency=1 run test`$/m, "the primary leg names the command");
  });

  test("a pull request that touches a package without a test script runs nothing and passes", () => {
    const { calls } = runPullRequestTests(workspace("affected-no-script", ["packages/d/src/index.js"]), pull);
    assert.deepEqual(calls, []);
  });

  test("a pull request that touches a file outside the packages runs the root test script", () => {
    const { calls } = runPullRequestTests(workspace("affected-root-file", ["scripts/x.mjs"]), pull);
    assert.deepEqual(calls, ["root"]);
  });

  const singles = [
    { name: "vitest receives the changed-file option", script: "vitest run", expected: (base: string) => [`vitest run --changed=${base}`] },
    { name: "jest receives the changed-file option", script: "jest", expected: (base: string) => [`jest --changedSince=${base}`] },
    { name: "mocha has no changed-file mode, so the whole script runs", script: "mocha", expected: () => ["mocha"] },
    { name: "a compound script runs whole", script: 'vitest run && echo done >> "$TEST_LOG"', expected: () => ["done", "vitest run"] },
    { name: "a script with an environment prefix runs whole", script: "FORCE_COLOR=0 vitest run", expected: () => ["vitest run"] },
  ];
  singles.forEach(({ name, script, expected }, index) => {
    test(`in a single package, ${name}`, () => {
      const { calls, base } = runPullRequestTests(single(`affected-single-${index}`, script), pull);
      assert.deepEqual(calls, expected(base));
    });
  });

  const full = [
    { name: "the merge queue", github: mergeGroup, affectedTests: "true" },
    { name: "the nightly run", github: other("schedule", "main"), affectedTests: "true" },
    { name: "a pull request without affected-tests", github: pull, affectedTests: "false" },
  ];
  full.forEach(({ name, github, affectedTests }, index) => {
    test(`${name} runs the whole root test script on a workspace`, () => {
      const { run, calls } = runPullRequestTests(workspace(`affected-full-${index}`, ["packages/a/src/index.js"]), github, affectedTests);
      assert.deepEqual(calls, ["root"]);
      assert.equal(run.summary, "", "the summary names no command when the whole suite runs");
    });
  });
});

describe("the flaky test annotations", () => {
  const annotate = step(nodeJob, "Annotate the flaky tests");
  const github = event("merge_group", "gh-readonly-queue/main/pr-1-abc");
  const fixture = (name: string): string => readText(new URL(`./fixtures/${name}.log`, import.meta.url));

  interface Annotated {
    run: Run;
    warnings: string[];
    summary: string[];
  }

  interface Logs {
    tests?: string;
    extra?: string;
  }

  const flakySteps = (logs: Logs): Context => {
    const flaky = (log: string | undefined): Context => ({ outputs: log === undefined ? {} : { flaky: "true" } });
    return { [stepId(step(nodeJob, "Run tests"))]: flaky(logs.tests), [stepId(step(nodeJob, "Run extra commands"))]: flaky(logs.extra) };
  };

  function annotates(steps: Context): boolean {
    const condition = /^\$\{\{ !cancelled\(\) && \((.+)\) \}\}$/.exec(annotate.if ?? "");
    assert.ok(condition, `not a condition this test evaluates: ${annotate.if}`);
    return condition[1].split(" || ").some((operand) => {
      const flaky = /^([\w.-]+) == 'true'$/.exec(operand);
      assert.ok(flaky, `not an operand this test evaluates: ${operand}`);
      return evaluate(flaky[1], { steps }) === "true";
    });
  }

  test("the annotate step runs when either retry passed, and not when neither step flaked", () => {
    assert.equal(annotates(flakySteps({ tests: "" })), true);
    assert.equal(annotates(flakySteps({ extra: "" })), true);
    assert.equal(annotates(flakySteps({})), false);
  });

  function annotateLogs({ tests, extra }: Logs): Annotated {
    const dir = realpathSync(mkdtempSync(join(root, "flaky-")));
    const steps = flakySteps({ tests, extra });
    assert.ok(annotates(steps), "the annotate step runs when a retry passed");
    for (const [file, log] of Object.entries({ "test-attempt-1.log": tests, "extra-attempt-1.log": extra })) {
      if (log !== undefined) writeFileSync(join(dir, file), log.replaceAll("/home/runner/work/example/example", dir));
    }
    const run = succeeded(runStep(annotate, dir, { ...interpolateAll(annotate.env, { github, steps }), ...fakeEnv(dir, {}) }));
    return { run, warnings: run.stdout.split("\n").filter((line) => line !== ""), summary: run.summary.split("\n").filter((line) => line !== "") };
  }

  const annotateLog = (log: string): Annotated => annotateLogs({ tests: log });

  const warning = (message: string): string => `::warning title=Flaky test::AntelopeJS/example: ${message} passed only on its merge-queue retry.`;
  const summaryLine = (message: string): string => `- Flaky test: \`\` AntelopeJS/example: ${message} passed only on its merge-queue retry. \`\``;

  function expectLogs(logs: Logs, messages: string[]): void {
    const { warnings, summary } = annotateLogs(logs);
    assert.deepEqual(warnings, messages.map(warning));
    assert.deepEqual(summary, messages.map(summaryLine));
  }

  const expectAnnotations = (log: string, messages: string[]): void => expectLogs({ tests: log }, messages);

  test("the annotations come after the two steps whose retry they read, and before the services stop", () => {
    const position = (name: string): number => nodeJob.findIndex((line) => line.trim() === `- name: ${name}`);
    assert.ok(position("Run tests") < position("Run extra commands"));
    assert.ok(position("Run extra commands") < position("Annotate the flaky tests"));
    assert.ok(position("Annotate the flaky tests") < position("Stop services"));
  });

  const math = "test/math.test.js";
  const runners = [
    { name: "vitest", fixture: "vitest", messages: ["test/broken.test.js", `${math} > math > add > adds 1 and 2`, `${math} > math > top level fails`] },
    { name: "vitest with colors", fixture: "vitest-color", messages: ["test/broken.test.js", `${math} > math > add > adds 1 and 2`, `${math} > math > top level fails`] },
    { name: "jest", fixture: "jest", messages: [`${math} > math > add > adds 1 and 2`, `${math} > math > top level fails`, "test/broken.test.js"] },
    { name: "mocha", fixture: "mocha", messages: [`${math} > math > top level fails`, `${math} > math > add > adds 1 and 2`] },
    { name: "mocha with ES modules", fixture: "mocha-esm", messages: ["test/math.test.mjs > math > add > adds 1 and 2"] },
    { name: "mocha with a timeout, a multi-line message and a suite title ending in a colon", fixture: "mocha-timeout", messages: ["test/timeout.test.js > slow suite > times out", "test/timeout.test.js > slow suite > multi-line message", "test/timeout.test.js > slow suite > ends with colon: > inner"] },
    { name: "two mocha runs in one log", fixture: "mocha-two", messages: ["m1/a.test.js > first > flakes", "m2/b.test.js > root level bad", "m2/b.test.js > second > bad"] },
    { name: "node:test", fixture: "node-test", messages: ["test/broken.test.js", `${math} > math > add > adds 1 and 2`, `${math} > math > top level fails`] },
  ];
  for (const { name, fixture: file, messages } of runners) {
    test(`${name}: one annotation and one summary line per failed test of the first attempt`, () => {
      expectAnnotations(fixture(file), messages);
    });
  }

  test("a failure whose test file is not found is named after the command", () => {
    const log = ["  1 failing", "", "  1) math", "       adds:", "", "      Error: boom", "      at Context.<anonymous> (src/helper.js:1:1)", ""].join("\n");
    expectAnnotations(log, ["pnpm run test > math > adds"]);
  });

  test("jest: a test file slower than its slow threshold keeps its name", () => {
    const log = ["FAIL test/slow.test.js (6.12 s)", "  ● slow › waits", "", "    expect(received).toBe(expected)", ""].join("\n");
    expectAnnotations(log, ["test/slow.test.js > slow > waits"]);
  });

  test("jest: only the failure bullets of a FAIL block name tests", () => {
    const log = ["FAIL test/a.test.js", "  ● list › fails", "", "    Error: list:", "      ● item one", "", "  ●  Cannot log after tests are done. Did you forget to wait for something async in your test?", ""].join("\n");
    expectAnnotations(log, ["test/a.test.js > list > fails"]);
  });

  test("a parser that throws falls back to one annotation naming the command", () => {
    const log = ["  1 failing", "", "  1) math", "       adds:", "     Error: boom", "      at Context.<anonymous> (file:///home/runner/work/x/x/test/a%2Fb.test.js:5:20)", ""].join("\n");
    expectAnnotations(log, ["pnpm run test"]);
  });

  test("an unparseable log gives one annotation naming the command", () => {
    expectAnnotations("something went wrong\nbut no runner says what\n", ["pnpm run test"]);
  });

  const vitestLog = (failures: { file: string; name: string }[]): string => failures.map(({ file, name }) => ` FAIL  ${file} > ${name}\n`).join("");

  test("more than ten failed tests collapse to one annotation per test file", () => {
    const failures = Array.from({ length: 12 }, (_, index) => ({ file: `test/file-${index % 3}.test.js`, name: `case ${index}` }));
    expectAnnotations(vitestLog(failures), ["test/file-0.test.js", "test/file-1.test.js", "test/file-2.test.js"]);
  });

  test("more than ten failed test files collapse to one annotation naming the command", () => {
    const failures = Array.from({ length: 11 }, (_, index) => ({ file: `test/file-${index}.test.js`, name: "case" }));
    expectAnnotations(vitestLog(failures), ["pnpm run test"]);
  });

  test("ten failed tests keep their names", () => {
    const failures = Array.from({ length: 10 }, (_, index) => ({ file: "test/many.test.js", name: `case ${index}` }));
    expectAnnotations(vitestLog(failures), failures.map(({ name }) => `test/many.test.js > ${name}`));
  });

  const mochaNotFound = ["  1 failing", "", "  1) math", "       adds:", "", "      Error: boom", "      at Context.<anonymous> (src/helper.js:1:1)", ""].join("\n");

  test("extra commands: a mocha integration timeout is named after its test", () => {
    expectLogs({ extra: fixture("extra-mocha-timeout") }, ["test/integration/media.test.ts > media integration > uploads > generates the thumbnails"]);
  });

  test("extra commands: an unparseable log gives one annotation naming extra-commands", () => {
    expectLogs({ extra: "building\nsomething went wrong\n" }, ["extra-commands"]);
  });

  test("extra commands: a failure whose test file is not found is named after extra-commands", () => {
    expectLogs({ extra: mochaNotFound }, ["extra-commands > math > adds"]);
  });

  test("tests and extra commands that both flaked give the annotations of the tests, then those of the extra commands", () => {
    expectLogs({ tests: fixture("vitest"), extra: fixture("extra-mocha-timeout") }, [
      "test/broken.test.js",
      `${math} > math > add > adds 1 and 2`,
      `${math} > math > top level fails`,
      "test/integration/media.test.ts > media integration > uploads > generates the thumbnails",
    ]);
  });

  test("each log keeps its own command name when the other log has the failure", () => {
    expectLogs({ tests: mochaNotFound, extra: mochaNotFound }, ["pnpm run test > math > adds", "extra-commands > math > adds"]);
  });

  const vitestFiles = (prefix: string, files: number, perFile: number): string =>
    vitestLog(Array.from({ length: files * perFile }, (_, index) => ({ file: `test/${prefix}-${index % files}.test.js`, name: `case ${index}` })));

  test("ten failed tests across both logs keep their names", () => {
    expectLogs({ tests: vitestFiles("a", 1, 5), extra: vitestFiles("b", 1, 5) }, [
      ...Array.from({ length: 5 }, (_, index) => `test/a-0.test.js > case ${index}`),
      ...Array.from({ length: 5 }, (_, index) => `test/b-0.test.js > case ${index}`),
    ]);
  });

  test("more than ten failed tests across both logs collapse both to one annotation per test file", () => {
    expectLogs({ tests: vitestFiles("a", 2, 3), extra: vitestFiles("b", 2, 3) }, ["test/a-0.test.js", "test/a-1.test.js", "test/b-0.test.js", "test/b-1.test.js"]);
  });

  test("more than ten failed test files across both logs collapse to one annotation naming each command", () => {
    expectLogs({ tests: vitestFiles("a", 6, 1), extra: vitestFiles("b", 6, 1) }, ["pnpm run test", "extra-commands"]);
  });

  test("a log that parses nothing keeps its command name beside a log that collapses", () => {
    expectLogs({ tests: vitestFiles("a", 11, 1), extra: "no runner output\n" }, ["pnpm run test", "extra-commands"]);
  });

  test("the message of an annotation escapes percent signs, and the summary keeps them", () => {
    const { warnings, summary } = annotateLog(" FAIL  test/escape.test.js > 100% sure, %0A stays text\n");
    assert.deepEqual(warnings, ["::warning title=Flaky test::AntelopeJS/example: test/escape.test.js > 100%25 sure, %250A stays text passed only on its merge-queue retry."]);
    assert.deepEqual(summary, [summaryLine("test/escape.test.js > 100% sure, %0A stays text")]);
  });

  test("the workflow files nothing in Notion and still declares the deprecated secret", () => {
    assert.ok(!ciNode.join("\n").includes("api.notion.com"));
    const secret = keyed(keyed(keyed(ciNode, "on"), "workflow_call"), "secrets");
    assert.equal(field(keyed(secret, "NOTION_TOKEN"), "required"), "false");
  });
});
