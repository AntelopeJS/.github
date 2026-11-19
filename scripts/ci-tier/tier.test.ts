import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";

const repoFile = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
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
  for (const key of path.split(".")) value = typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;
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
  assert.notEqual(typeof value, "object", `${expression} is not a value`);
  return value === undefined ? "" : String(value);
}

const interpolate = (value: string, context: Context): string =>
  value.replace(/^"(.*)"$/, "$1").replace(/\$\{\{ (.+?) \}\}/g, (_, expression: string) => evaluate(expression, context));

const interpolateAll = (values: Record<string, string>, context: Context): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolate(value, context)]));

interface Step {
  id?: string;
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
  return { id: field(body, "id"), uses: field(body, "uses"), shell: field(body, "shell"), env: section("env"), with: section("with"), run };
}

function stepId({ id }: Step): string {
  assert.ok(id, "the step has no id");
  return id;
}

const keyValues = (path: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(path, "utf8")
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
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs: keyValues(files.GITHUB_OUTPUT), env: keyValues(files.GITHUB_ENV) };
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

function checkout(name: string, changed: string[]): Checkout {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--quiet", "--initial-branch=main");
  write(cwd, ["README.md", "package.json", "docs/guide.md", "src/index.ts"], "base\n");
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  write(cwd, changed, "changed\n");
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", "change");
  return { cwd, base };
}

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
writeFileSync(
  join(bin, "curl"),
  [
    "#!/usr/bin/env bash",
    'method="" url=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -X) method="$2"; shift 2 ;;',
    "    -H | --data) shift 2 ;;",
    "    -*) shift ;;",
    '    *) url="$1"; shift ;;',
    "  esac",
    "done",
    'request="$FAKE_REQUESTS/$(ls "$FAKE_REQUESTS" | wc -l)"',
    'echo "$method $url" > "$request.target"',
    'cat > "$request.json"',
    'case "$url" in',
    '  */query) echo "$FAKE_QUERY" ;;',
    "  *) echo '{}' ;;",
    "esac",
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
      assert.equal(readFileSync(join(dir, "calls"), "utf8").trim(), String(calls));
      assert.equal(run.outputs.flaky, flaky);
    });
  }
});

describe("the flaky test filing", () => {
  const file = step(nodeJob, "File the flaky test in the Inbox");
  const github = event("merge_group", "gh-readonly-queue/main/pr-1-abc");

  function fileFlaky(token: string, query: string): { run: Run; requests: { target: string; body: Context }[] } {
    const dir = mkdtempSync(join(root, "flaky-"));
    const requests = join(dir, "requests");
    mkdirSync(requests);
    writeFileSync(join(dir, "test-attempt-1.log"), `${"x".repeat(3000)}\n\u001b[31mFAIL src/flaky.test.ts\u001b[0m\n`);
    const env = interpolateAll(file.env, { github, secrets: { NOTION_TOKEN: token } });
    const run = runStep(file, dir, { ...env, ...fakeEnv(dir, { FAKE_REQUESTS: requests, FAKE_QUERY: query }) });
    const sent = readdirSync(requests)
      .filter((name) => name.endsWith(".target"))
      .sort()
      .map((name) => ({ target: readFileSync(join(requests, name), "utf8").trim(), body: JSON.parse(readFileSync(join(requests, name.replace(".target", ".json")), "utf8")) }));
    return { run, requests: sent };
  }

  const runUrl = "https://github.com/AntelopeJS/example/actions/runs/42";

  test("without NOTION_TOKEN, warns and files nothing", () => {
    const { run, requests } = fileFlaky("", "{}");
    succeeded(run);
    assert.match(run.stdout, /::warning::.*NOTION_TOKEN/);
    assert.deepEqual(requests, []);
  });

  test("creates an Inbox task with the end of the failed attempt's log", () => {
    const { run, requests } = fileFlaky("secret", '{"results": []}');
    succeeded(run);
    assert.deepEqual(
      requests.map(({ target }) => target),
      ["POST https://api.notion.com/v1/data_sources/2f2d36f1-99db-4ff3-b040-f66d7480ac9a/query", "POST https://api.notion.com/v1/pages"],
    );
    assert.deepEqual(lookup("filter.and", requests[0].body), [
      { property: "Key", rich_text: { equals: "flaky-test:example" } },
      { property: "Status", status: { does_not_equal: "Done" } },
      { property: "Status", status: { does_not_equal: "Dropped" } },
    ]);
    const page = requests[1].body;
    assert.deepEqual(lookup("properties.Key", page), { rich_text: [{ text: { content: "flaky-test:example" } }] });
    assert.deepEqual(lookup("properties.Status", page), { status: { name: "Inbox" } });
    assert.deepEqual(lookup("properties.Repos", page), { multi_select: [{ name: "example" }] });
    const children = lookup("children", page);
    assert.ok(Array.isArray(children));
    assert.ok(JSON.stringify(children).includes(runUrl), "the task links the run");
    const richText = lookup("code.rich_text", children.find((child) => child.code !== undefined) ?? {});
    assert.ok(Array.isArray(richText), "the task holds a code block");
    const log = lookup("text.content", richText[0]);
    assert.ok(typeof log === "string");
    assert.ok(log.endsWith("FAIL src/flaky.test.ts"), log.slice(-80));
    assert.ok(log.length <= 1500 && !log.includes("\u001b"), "the log is a short tail without color codes");
  });

  test("appends to the open task of the repository instead of filing another", () => {
    const { run, requests } = fileFlaky("secret", '{"results": [{"id": "page-1"}]}');
    succeeded(run);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].target, "PATCH https://api.notion.com/v1/blocks/page-1/children");
    assert.match(JSON.stringify(requests[1].body), new RegExp(`Seen again.*${runUrl.replaceAll(".", "\\.")}`));
  });
});
