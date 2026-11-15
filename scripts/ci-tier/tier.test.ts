import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

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

function expression(value: string | undefined): string {
  const match = /^\$\{\{ ([\w.-]+) \}\}$/.exec(value ?? "");
  assert.ok(match, `not a plain expression: ${value}`);
  return match[1];
}

function expressions(lines: string[]): Record<string, string> {
  const own = Math.min(...lines.filter((line) => line.trim() !== "").map(indent));
  return Object.fromEntries(
    lines
      .filter((line) => indent(line) === own)
      .map((line) => {
        const [key, ...value] = line.trim().split(": ");
        return [key, expression(value.join(": "))];
      }),
  );
}

interface Step {
  id: string;
  uses?: string;
  shell?: string;
  env: Record<string, string>;
  run: string;
}

function step(lines: string[], name: string): Step {
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `no step ${name}`);
  const body = [lines[start].replace("- name:", "  name:"), ...block(lines, start)];
  const id = field(body, "id");
  assert.ok(id, `step ${name} has no id`);
  const runLine = body.findIndex((line) => line.trim() === "run: |");
  const script = runLine === -1 ? [] : block(body, runLine);
  const run = script.map((line) => line.slice(indent(script[0]))).join("\n");
  const env = body.some((line) => line.trim() === "env:") ? expressions(keyed(body, "env")) : {};
  return { id, uses: field(body, "uses"), shell: field(body, "shell"), env, run };
}

type Context = { [key: string]: string | boolean | Context | undefined };

function resolve(path: string, context: Context): string {
  let value: Context[string] = context;
  for (const key of path.split(".")) value = typeof value === "object" ? value[key] : undefined;
  assert.notEqual(typeof value, "object", `${path} is not a value`);
  return value === undefined ? "" : String(value);
}

const evaluate = (mapping: Record<string, string>, context: Context): Record<string, string> =>
  Object.fromEntries(Object.entries(mapping).map(([key, path]) => [key, resolve(path, context)]));

let runs = 0;
function runStep({ run }: Step, cwd: string, env: Record<string, string>): Context {
  runs += 1;
  const file = join(root, `step-${runs}.sh`);
  const output = join(root, `output-${runs}`);
  writeFileSync(file, run);
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(root, "summary"), ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const tierStep = "Pick the tier from the event, the target branch and the draft flag";
const tierJob = block(ciNode, ciNode.indexOf("  tier:"));

function tierJobOutputs(github: Context, inputs: Context, cwd: string): Record<string, string> {
  assert.equal(field(keyed(action, "runs"), "using"), "composite");
  const pickTier = step(action, tierStep);
  assert.equal(pickTier.shell, "bash");
  const actionOutputs = runStep(pickTier, cwd, evaluate(pickTier.env, { github }));
  const tierValue = expression(field(keyed(keyed(action, "outputs"), "tier"), "value"));
  const tier = resolve(tierValue, { steps: { [pickTier.id]: { outputs: actionOutputs } } });

  const pick = step(tierJob, tierStep);
  assert.equal(pick.uses, "AntelopeJS/.github/.github/actions/ci-tier@v2");
  const steps: Context = { [pick.id]: { outputs: { tier } } };
  const jobs = step(tierJob, "Pick the jobs and runners from the tier");
  steps[jobs.id] = { outputs: runStep(jobs, cwd, evaluate(jobs.env, { github, inputs, steps })) };
  return evaluate(expressions(keyed(tierJob, "outputs")), { steps });
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function checkout(name: string, changed: string): { cwd: string; base: string } {
  const cwd = join(root, name);
  mkdirSync(join(cwd, "docs"), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  git(cwd, "init", "--quiet");
  writeFileSync(join(cwd, "README.md"), "readme\n");
  writeFileSync(join(cwd, "docs/guide.md"), "guide\n");
  writeFileSync(join(cwd, "src/index.ts"), "export {};\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, changed), "changed\n");
  git(cwd, "commit", "--quiet", "-am", "change");
  return { cwd, base };
}

const code = checkout("code", "src/index.ts");
const docs = checkout("docs", "docs/guide.md");

const repository = "AntelopeJS/example";
const event = (name: string, ref: string): Context => ({
  event_name: name,
  ref_name: ref,
  repository,
  event: { repository: { default_branch: "main" } },
});
const pullRequest = (base: string, head: string, { draft = false, headRepository = repository } = {}): Context => ({
  ...event("pull_request", "1/merge"),
  base_ref: base,
  head_ref: head,
  event: { repository: { default_branch: "main" }, pull_request: { draft, head: { repo: { full_name: headRepository } } } },
});

interface ContractEvent {
  name: string;
  github: Context;
  checkout?: typeof code;
  windowsPullRequests?: boolean;
  expected: { tier: string; lint: string; checks: string; tests: string; os: string; fast?: true };
}

const linux = '["ubuntu-latest"]';
const both = '["ubuntu-latest","windows-latest"]';

const contract: ContractEvent[] = [
  { name: "draft PR into next", github: pullRequest("next", "feat/x", { draft: true }), expected: { tier: "draft", lint: "true", checks: "false", tests: "false", os: linux } },
  { name: "ready PR into next", github: pullRequest("next", "feat/x"), expected: { tier: "fast", lint: "true", checks: "true", tests: "true", os: linux, fast: true } },
  { name: "ready PR into next, docs only", github: pullRequest("next", "docs/x"), checkout: docs, expected: { tier: "fast", lint: "true", checks: "true", tests: "false", os: linux, fast: true } },
  { name: "ready PR into next, windows-pull-requests", github: pullRequest("next", "feat/x"), windowsPullRequests: true, expected: { tier: "fast", lint: "true", checks: "true", tests: "true", os: both, fast: true } },
  { name: "PR into main from a person's branch", github: pullRequest("main", "feat/x"), expected: { tier: "full", lint: "true", checks: "true", tests: "true", os: linux } },
  { name: "PR next to main", github: pullRequest("main", "next"), expected: { tier: "none", lint: "false", checks: "false", tests: "false", os: linux } },
  { name: "PR develop to main (cloud)", github: pullRequest("main", "develop"), expected: { tier: "none", lint: "false", checks: "false", tests: "false", os: linux } },
  { name: "PR from a fork's next to main", github: pullRequest("main", "next", { headRepository: "someone/example" }), expected: { tier: "full", lint: "true", checks: "true", tests: "true", os: linux } },
  { name: "push to next", github: event("push", "next"), expected: { tier: "full", lint: "true", checks: "true", tests: "true", os: linux } },
  { name: "push to main", github: event("push", "main"), expected: { tier: "none", lint: "false", checks: "false", tests: "false", os: linux } },
  { name: "schedule", github: event("schedule", "main"), expected: { tier: "nightly", lint: "true", checks: "true", tests: "true", os: both } },
  { name: "workflow_dispatch", github: event("workflow_dispatch", "next"), expected: { tier: "full", lint: "true", checks: "true", tests: "true", os: linux } },
  { name: "push to next, windows-pull-requests", github: event("push", "next"), windowsPullRequests: true, expected: { tier: "full", lint: "true", checks: "true", tests: "true", os: linux } },
];

for (const contractEvent of contract) {
  test(`${contractEvent.name} runs the ${contractEvent.expected.tier} tier`, () => {
    const { cwd, base } = contractEvent.checkout ?? code;
    const inputs = { windows: true, "windows-pull-requests": contractEvent.windowsPullRequests ?? false };
    const { fast, ...expected } = contractEvent.expected;
    assert.deepEqual(tierJobOutputs(contractEvent.github, inputs, cwd), { ...expected, "test-base": fast ? base : "" });
  });
}
