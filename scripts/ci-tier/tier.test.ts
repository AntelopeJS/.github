import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const repoFile = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const action = repoFile(".github/actions/ci-tier/action.yml").split("\n");
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
  id: string;
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
  const id = field(body, "id");
  assert.ok(id, `step ${name} has no id`);
  const section = (key: string): Record<string, string> => (body.some((line) => line.trim() === `${key}:`) ? mapping(keyed(body, key)) : {});
  const runLine = body.findIndex((line) => line.trim() === "run: |");
  const script = runLine === -1 ? [] : block(body, runLine);
  const run = script.map((line) => line.slice(indent(script[0]))).join("\n");
  return { id, uses: field(body, "uses"), shell: field(body, "shell"), env: section("env"), with: section("with"), run };
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
  return { status: result.status, stderr: result.stderr, outputs: keyValues(files.GITHUB_OUTPUT), env: keyValues(files.GITHUB_ENV) };
}

function succeeded(run: Run): Run {
  assert.equal(run.status, 0, run.stderr);
  return run;
}

const tierStep = "Pick the tier and the diff base from the event, the label and the changed files";

function actionOutputs(github: Context, inputs: Context, cwd: string): Record<string, string> {
  assert.equal(field(keyed(action, "runs"), "using"), "composite");
  const pick = step(action, tierStep);
  assert.equal(pick.shell, "bash");
  const declaredInputs = keyed(action, "inputs");
  const defaults = Object.fromEntries(keys(declaredInputs).map((name) => [name, interpolate(field(keyed(declaredInputs, name), "default") ?? "", {})]));
  const { outputs } = succeeded(runStep(pick, cwd, interpolateAll(pick.env, { github, inputs: { ...defaults, ...inputs } })));
  const declaredOutputs = keyed(action, "outputs");
  const steps = { [pick.id]: { outputs } };
  return Object.fromEntries(keys(declaredOutputs).map((name) => [name, interpolate(field(keyed(declaredOutputs, name), "value") ?? "", { steps })]));
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
  git(cwd, "init", "--quiet");
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

interface ContractRow {
  name: string;
  github: (base: string) => Context;
  changed?: string[];
  inputs?: Context;
  expected: { tier: string; base: string };
}

const contract: ContractRow[] = [
  { name: "draft PR", github: pullRequest("main", "feat/x", { draft: true }), expected: { tier: "fast", base: BASE } },
  { name: "ready PR", github: pullRequest("main", "feat/x"), expected: { tier: "fast", base: BASE } },
  { name: "PR changing the root package.json", github: pullRequest("main", "feat/x"), changed: ["package.json"], expected: { tier: "full", base: BASE } },
  { name: "PR changing a nested pnpm-lock.yaml", github: pullRequest("main", "feat/x"), changed: ["frontend/pnpm-lock.yaml"], expected: { tier: "full", base: BASE } },
  { name: "PR changing a workflow", github: pullRequest("main", "feat/x"), changed: [".github/workflows/ci.yml"], expected: { tier: "full", base: BASE } },
  { name: "PR changing the root README.md only", github: pullRequest("main", "docs/x"), changed: ["README.md"], expected: { tier: "fast", base: BASE } },
  { name: "PR labeled ci:full", github: pullRequest("main", "feat/x", { labels: ["bug", "ci:full"] }), expected: { tier: "full", base: BASE } },
  { name: "PR with selection full", github: pullRequest("main", "feat/x"), inputs: { selection: "full" }, expected: { tier: "full", base: BASE } },
  { name: "PR from next into main", github: pullRequest("main", "next"), expected: { tier: "fast", base: BASE } },
  { name: "merge_group", github: mergeGroup, expected: { tier: "queue", base: BASE } },
  { name: "push to main", github: other("push", "main"), expected: { tier: "none", base: "" } },
  { name: "push to next", github: other("push", "next"), expected: { tier: "full", base: "" } },
  { name: "schedule", github: other("schedule", "main"), expected: { tier: "nightly", base: "" } },
  { name: "workflow_dispatch", github: other("workflow_dispatch", "main"), expected: { tier: "full", base: "" } },
];

const withBase = (expected: ContractRow["expected"], base: string): ContractRow["expected"] => ({
  ...expected,
  base: expected.base === BASE ? base : expected.base,
});

contract.forEach((row, index) => {
  test(`${row.name} picks the ${row.expected.tier} tier`, () => {
    const { cwd, base } = checkout(`contract-${index}`, row.changed ?? ["src/index.ts"]);
    assert.deepEqual(actionOutputs(row.github(base), row.inputs ?? {}, cwd), withBase(row.expected, base));
  });
});

test("a PR whose base is missing from the shallow clone fetches it from origin", () => {
  const { cwd, base } = shallowCheckout("shallow", ["src/index.ts"]);
  assert.deepEqual(actionOutputs(pullRequest("main", "feat/x")(base), {}, cwd), { tier: "fast", base });
  assert.equal(git(cwd, "cat-file", "-t", base), "commit");
});

test("a PR without a checkout picks the fast tier, so a job that calls the action before any checkout keeps working", () => {
  const empty = join(root, "no-checkout");
  mkdirSync(empty);
  const base = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(actionOutputs(pullRequest("main", "feat/x")(base), {}, empty), { tier: "fast", base });
});
