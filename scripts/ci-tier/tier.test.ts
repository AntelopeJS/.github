import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repoFile = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const action = repoFile(".github/actions/ci-tier/action.yml");
const ciNode = repoFile(".github/workflows/ci-node.yml");
const root = mkdtempSync(join(tmpdir(), "ci-tier-"));
after(() => rmSync(root, { recursive: true, force: true }));

function runBlock(text: string, step: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${step}`);
  assert.notEqual(start, -1, `no step ${step}`);
  const stepIndent = lines[start].indexOf("-");
  const end = lines.findIndex((line, index) => index > start && line.indexOf("- ") === stepIndent && line.trim().startsWith("- "));
  const runLine = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  assert.ok(runLine !== -1 && (end === -1 || runLine < end), `step ${step} has no run block`);
  const bodyIndent = " ".repeat(lines[runLine].indexOf("run") + 2);
  const body: string[] = [];
  for (const line of lines.slice(runLine + 1)) {
    if (line !== "" && !line.startsWith(bodyIndent)) break;
    body.push(line.slice(bodyIndent.length));
  }
  return body.join("\n");
}

let runs = 0;
function runStep(script: string, cwd: string, env: Record<string, string>): Record<string, string> {
  runs += 1;
  const file = join(root, `step-${runs}.sh`);
  const output = join(root, `output-${runs}`);
  writeFileSync(file, script);
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
const pullRequest = (base: string, head: string, extra: Record<string, string> = {}): Record<string, string> => ({
  EVENT: "pull_request",
  REF_NAME: "1/merge",
  BASE_REF: base,
  HEAD_REF: head,
  HEAD_REPOSITORY: repository,
  DRAFT: "false",
  ...extra,
});

interface ContractEvent {
  name: string;
  context: Record<string, string>;
  checkout?: typeof code;
  windowsPullRequests?: boolean;
  expected: { tier: string; lint: string; checks: string; tests: string; os: string; fast?: true };
}

const linux = '["ubuntu-latest"]';
const both = '["ubuntu-latest","windows-latest"]';

const contract: ContractEvent[] = [
  { name: "draft PR into next", context: pullRequest("next", "feat/x", { DRAFT: "true" }), expected: { tier: "draft", lint: "true", checks: "false", tests: "false", os: linux } },
  { name: "ready PR into next", context: pullRequest("next", "feat/x"), expected: { tier: "fast", lint: "true", checks: "true", tests: "true", os: linux, fast: true } },
  { name: "ready PR into next, docs only", context: pullRequest("next", "docs/x"), checkout: docs, expected: { tier: "fast", lint: "true", checks: "true", tests: "false", os: linux, fast: true } },
  { name: "ready PR into next, windows-pull-requests", context: pullRequest("next", "feat/x"), windowsPullRequests: true, expected: { tier: "fast", lint: "true", checks: "true", tests: "true", os: both, fast: true } },
  { name: "PR into main from a person's branch", context: pullRequest("main", "feat/x"), expected: { tier: "full", lint: "true", checks: "true", tests: "true", os: linux } },
  { name: "PR next to main", context: pullRequest("main", "next"), expected: { tier: "none", lint: "false", checks: "false", tests: "false", os: linux } },
  { name: "PR develop to main (cloud)", context: pullRequest("main", "develop"), expected: { tier: "none", lint: "false", checks: "false", tests: "false", os: linux } },
  { name: "PR from a fork's next to main", context: pullRequest("main", "next", { HEAD_REPOSITORY: "someone/example" }), expected: { tier: "full", lint: "true", checks: "true", tests: "true", os: linux } },
  { name: "push to next", context: { EVENT: "push", REF_NAME: "next" }, expected: { tier: "full", lint: "true", checks: "true", tests: "true", os: linux } },
  { name: "push to main", context: { EVENT: "push", REF_NAME: "main" }, expected: { tier: "none", lint: "false", checks: "false", tests: "false", os: linux } },
  { name: "schedule", context: { EVENT: "schedule", REF_NAME: "main" }, expected: { tier: "nightly", lint: "true", checks: "true", tests: "true", os: both } },
  { name: "workflow_dispatch", context: { EVENT: "workflow_dispatch", REF_NAME: "next" }, expected: { tier: "full", lint: "true", checks: "true", tests: "true", os: linux } },
];

for (const event of contract) {
  test(`${event.name} runs the ${event.expected.tier} tier`, () => {
    const { cwd, base } = event.checkout ?? code;
    const context: Record<string, string> = { DEFAULT_BRANCH: "main", REPOSITORY: repository, ...event.context };
    const { tier } = runStep(runBlock(action, "Pick the tier from the event, the target branch and the draft flag"), cwd, context);
    const outputs = runStep(runBlock(ciNode, "Pick the jobs and runners from the tier"), cwd, {
      TIER: tier,
      EVENT: context.EVENT,
      WINDOWS: "true",
      WINDOWS_PULL_REQUESTS: String(event.windowsPullRequests ?? false),
    });
    const { fast, ...expected } = event.expected;
    assert.deepEqual(outputs, { ...expected, "test-base": fast ? base : "" });
  });
}

test("ci-node.yml reads its tier from the shared action at v2", () => {
  assert.match(ciNode, /id: pick\n {8}uses: AntelopeJS\/\.github\/\.github\/actions\/ci-tier@v2\n/);
  assert.match(ciNode, /TIER: \$\{\{ steps\.pick\.outputs\.tier \}\}/);
});
