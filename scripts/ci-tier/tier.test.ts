import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  type Checkout,
  type Expected,
  type Run,
  actionOutputs,
  checkout,
  ciNode,
  fakeEnv,
  git,
  leg,
  mergeGroup,
  mergeGroupAt,
  nodeJob,
  other,
  pullRequest,
  repo,
  root,
  runAction,
  runStep,
  shallowCheckout,
  succeeded,
} from "./helpers/harness.ts";
import { readText } from "./helpers/read.ts";
import { type Context, block, interpolateAll, keyed, keys, scope, step } from "./helpers/workflow.ts";

const BASE = "<the checkout's base commit>";
const nightly = scope("inputs", { nightly: "true" });

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
  { name: "workflow_dispatch with nightly", github: () => ({ ...other("workflow_dispatch", "fix/x")(), ...nightly }), expected: { tier: "nightly", base: "", tests: "true", "test-base": "", work: "true" } },
  { name: "PR from a caller that forwards nightly", github: (base) => ({ ...pullRequest("main", "feat/x")(base), ...nightly }), expected: { tier: "fast", base: BASE, tests: "true", "test-base": BASE, work: "true" } },
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

describe("a merge group the queue dropped", () => {
  const HEAD = "1111111111111111111111111111111111111111";
  const NEWER = "2222222222222222222222222222222222222222";
  const REF = "refs/heads/gh-readonly-queue/main/pr-1-abc";
  const MATCHING_REFS = String.raw`api repos/AntelopeJS/example/git/matching-refs/heads/gh-readonly-queue/main/pr-1-abc --jq .[] | "\(.ref) \(.object.sha)" token=token`;
  const COMPARE = `api repos/AntelopeJS/example/compare/main...${HEAD} --jq .status token=token`;
  let groups = 0;
  const group = (answers: Record<string, string>) => {
    groups += 1;
    const { cwd, base } = checkout(`dropped-${groups}`, ["src/index.ts"]);
    const log = join(root, `dropped-${groups}.log`);
    writeFileSync(log, "");
    const env = { FAKE_GH_LOG: log, ...answers };
    const calls = (): string[] => readText(log).split("\n").filter(Boolean);
    return { cwd, base, env, calls };
  };

  test("fails before any tier when its branch is gone, or holds a newer group, and its head is not on the base branch", () => {
    const cases = [
      { refs: "", status: "diverged", why: "branch deleted" },
      { refs: "", status: "ahead", why: "branch deleted, head one commit past the base" },
      { refs: `${REF} ${NEWER}`, status: "diverged", why: "the queue rebuilt the group on the same parent, under the same branch name" },
      { refs: `${REF}0 ${HEAD}`, status: "diverged", why: "only a longer branch name matches the prefix" },
    ];
    for (const { refs, status, why } of cases) {
      const { cwd, base, env, calls } = group({ FAKE_GH_REFS: refs, FAKE_GH_COMPARE: status });
      const run = runAction(mergeGroupAt(base, HEAD), {}, cwd, env);
      assert.equal(run.status, 1, why);
      assert.match(run.stdout, /^::error title=Superseded merge group::The merge queue dropped this group: gh-readonly-queue\/main\/pr-1-abc no longer points at its head 1{40}, which is not on main\./m, why);
      assert.match(run.summary, /^Superseded merge group: The merge queue dropped this group: /, why);
      assert.deepEqual(run.outputs, {}, `${why}: no tier, so no job reads one`);
      assert.deepEqual(calls(), [MATCHING_REFS, COMPARE], `${why}: both calls use the job token, contents: read`);
    }
  });

  test("runs the queue tier while its branch still points at its head, without asking where the head is", () => {
    for (const refs of [`${REF} ${HEAD}`, `${REF} ${HEAD}\n${REF}0 ${NEWER}`]) {
      const { cwd, base, env, calls } = group({ FAKE_GH_REFS: refs, FAKE_GH_COMPARE: "diverged" });
      assert.deepEqual(actionOutputs(mergeGroupAt(base, HEAD), {}, cwd, env), { tier: "queue", base });
      assert.deepEqual(calls(), [MATCHING_REFS]);
    }
  });

  test("runs the queue tier in a group that merged, whose branch is gone or moved but whose head is on the base branch", () => {
    for (const [refs, status] of [["", "identical"], ["", "behind"], [`${REF} ${NEWER}`, "behind"]]) {
      const { cwd, base, env, calls } = group({ FAKE_GH_REFS: refs, FAKE_GH_COMPARE: status });
      assert.deepEqual(actionOutputs(mergeGroupAt(base, HEAD), {}, cwd, env), { tier: "queue", base }, `${refs} ${status}`);
      assert.deepEqual(calls(), [MATCHING_REFS, COMPARE]);
    }
  });

  test("runs the queue tier when either API call fails, as before", () => {
    const failures: Record<string, string>[] = [{}, { FAKE_GH_REFS: "" }];
    for (const answers of failures) {
      const { cwd, base, env } = group(answers);
      assert.deepEqual(actionOutputs(mergeGroupAt(base, HEAD), {}, cwd, env), { tier: "queue", base }, JSON.stringify(answers));
    }
  });

  test("asks nothing on any other event", () => {
    const { cwd, base, env, calls } = group({ FAKE_GH_REFS: "", FAKE_GH_COMPARE: "diverged" });
    assert.equal(actionOutputs(pullRequest("main", "feat/x")(base), {}, cwd, env).tier, "fast");
    assert.equal(actionOutputs(other("push", "next")(), {}, cwd, env).tier, "full");
    assert.equal(actionOutputs(other("schedule", "main")(), {}, cwd, env).tier, "nightly");
    assert.deepEqual(calls(), []);
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

test("ci-node.yml calls the ci-tier action at v2, keeps the gate, checks the title in a leg, and has no gitleaks job", () => {
  const uses = ciNode.filter((line) => line.includes("ci-tier"));
  assert.notEqual(uses.length, 0);
  for (const line of uses) assert.equal(line.trim(), "uses: AntelopeJS/.github/.github/actions/ci-tier@v2");
  const jobs = keys(keyed(ciNode, "jobs"));
  assert.ok(jobs.includes("gate"), "the gate reports ci / checks");
  assert.ok(!jobs.includes("gitleaks"));
  assert.ok(block(ciNode, ciNode.indexOf("  node:")).some((line) => line.trim().startsWith("pattern='")), "the primary leg checks the pull request title");
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
      succeeded(runStep(fetch, cwd, interpolateAll(fetch.env, github)));
      assert.equal(git(cwd, "rev-parse", "refs/remotes/origin/main"), git(cwd, "ls-remote", "origin", "refs/heads/main").split("\t")[0]);
    });
  });
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
      const env = interpolateAll(runExtra.env, scope("inputs", { "extra-commands": "pnpm run integration" }));
      const run = runStep(runExtra, dir, { ...env, ...fakeEnv(dir, { ANTELOPEJS_CI_TIER: tier, FAKE_CODES: codes }) });
      assert.equal(run.status, status, run.stderr);
      assert.equal(readText(join(dir, "calls")).trim(), String(calls));
      assert.equal(run.outputs.flaky, flaky);
    });
  }

  test("the log of the first attempt, with its standard error, is the one the annotations read", () => {
    const dir = mkdtempSync(join(root, "extra-"));
    const env = interpolateAll(runExtra.env, scope("inputs", { "extra-commands": "pnpm run integration >&2" }));
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

  interface ManifestFields {
    scripts?: { test: string };
    dependencies?: Record<string, string>;
  }

  const manifest = (name: string, fields: ManifestFields = {}): string => JSON.stringify({ name, version: "1.0.0", private: true, ...fields });
  const logging = (name: string) => ({ scripts: { test: `echo ${name} >> "$TEST_LOG"` } });
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
      ...interpolateAll(runTests.env, scope("inputs", { "affected-tests": affectedTests })),
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
