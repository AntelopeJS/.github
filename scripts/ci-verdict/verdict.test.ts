import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { isList, isObject, isText } from "../ci-metrics/json.ts";
import { pageOf } from "./github.ts";
import { read } from "./helpers/read.ts";
import { jobsOf, parseYaml, problemsOf, verdictOf, type RequiredCheck } from "./verdict.ts";

const ciNode = read(".github/workflows/ci-node.yml");

const CALL = "  ci:\n    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n";
const RENOVATE = "  renovate-sync:\n    uses: AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v2\n";
const workflow = (...jobs: string[]): string => `on: pull_request\njobs:\n${jobs.join("")}`;
const verdictJob = (needs: string, condition = "${{ always() }}"): string => `  verdict:\n    needs: ${needs}\n    if: ${condition}\n    runs-on: ubuntu-latest\n`;
const required = (...contexts: string[]): RequiredCheck[] => contexts.map((context) => ({ context, ruleset: `the ruleset "R" (1)` }));

function verdictRun(workflow: string): string {
  const parsed = parseYaml(workflow);
  const jobs = isObject(parsed) ? parsed.jobs : undefined;
  const verdict = isObject(jobs) ? jobs.verdict : undefined;
  const steps = isObject(verdict) && isList(verdict.steps) ? verdict.steps : [];
  const [step] = steps;
  const run = isObject(step) ? step.run : undefined;
  assert.ok(isText(run), "the verdict job runs one script");
  return run;
}

describe("the verdict of ci-node.yml", () => {
  test("needs every job of the workflow and runs even when one of them failed", () => {
    assert.deepEqual(verdictOf(jobsOf(ciNode)), { check: "verdict", problems: [] });
  });

  const run = verdictRun(ciNode);
  const verdict = (results: Record<string, string>) => {
    const needs = Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }]));
    const { status, stdout } = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, NEEDS: JSON.stringify(needs) },
    });
    return { status, stdout };
  };

  test("passes when every job succeeded or was skipped", () => {
    assert.deepEqual(verdict({ windows: "skipped", shards: "skipped", node: "success", stress: "skipped", checks: "success" }), { status: 0, stdout: "" });
  });

  test("fails naming each job that failed or was cancelled", () => {
    assert.deepEqual(verdict({ windows: "skipped", shards: "skipped", node: "failure", stress: "skipped", checks: "failure" }), { status: 1, stdout: "node: failure\nchecks: failure\n" });
    assert.deepEqual(verdict({ windows: "success", shards: "skipped", node: "success", stress: "cancelled", checks: "success" }), { status: 1, stdout: "stress: cancelled\n" });
  });
});

describe("a repository's conformance", () => {
  test("a ci.yml that is one ci-node.yml call conforms when its rulesets require ci / verdict alone", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL), required: required("ci / verdict") }), []);
  });

  test("a job beside the ci-node.yml call needs a verdict job of the repository", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE), required: required("verdict") }), [
      "ci.yml is not a single ci-node.yml call (jobs ci, renovate-sync) and has no verdict job",
    ]);
  });

  test("a verdict job conforms when it needs every other job and runs with if: always()", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE, verdictJob("[ci, renovate-sync]")), required: required("verdict") }), []);
  });

  test("a verdict job names each job it does not need", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE, verdictJob("ci")), required: required("verdict") }), ["its verdict job does not need renovate-sync"]);
  });

  test("a verdict job that a failed job would skip is reported", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE, verdictJob("[ci, renovate-sync]", "${{ !cancelled() }}")), required: required("verdict") }), [
      "its verdict job does not run with if: always(), so a failed job skips it and the skipped check passes",
    ]);
  });

  test("each required check other than the verdict is named, and a verdict no ruleset requires is reported", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL), required: required("ci / checks", "hub-build") }), [
      `the ruleset "R" (1) requires ci / checks, not ci / verdict`,
      `the ruleset "R" (1) requires hub-build, not ci / verdict`,
      "no ruleset requires ci / verdict",
    ]);
  });

  test("the caller example of the README conforms, with the verdict script of ci-node.yml", () => {
    const readme = read("README.md");
    const example = /```yaml\n([\s\S]*?)```/.exec(readme.slice(readme.indexOf("### The verdict of a caller")))?.[1] ?? "";
    assert.deepEqual(verdictOf(jobsOf(example)), { check: "verdict", problems: [] });
    assert.equal(verdictRun(example), verdictRun(ciNode));
  });
});

describe("the GraphQL answer", () => {
  const rule = (type: string, contexts: string[]) => ({
    type,
    repositoryRuleset: { name: "Required CI", databaseId: 7 },
    parameters: type === "REQUIRED_STATUS_CHECKS" ? { requiredStatusChecks: contexts.map((context) => ({ context })) } : {},
  });
  const answer = (hasNextPage: boolean) => ({
    data: {
      organization: {
        repositories: {
          pageInfo: { hasNextPage, endCursor: "cursor" },
          nodes: [
            { name: "api", workflow: { text: "jobs: {}" }, defaultBranchRef: { rules: { nodes: [rule("MERGE_QUEUE", []), rule("REQUIRED_STATUS_CHECKS", ["ci / checks", "hub-build"])] } } },
            { name: "infra", workflow: null, defaultBranchRef: { rules: { nodes: [rule("REQUIRED_STATUS_CHECKS", ["schema"])] } } },
          ],
        },
      },
    },
  });

  test("keeps the repositories with a ci.yml and the checks their default branch requires", () => {
    assert.deepEqual(pageOf(answer(false)), {
      repositories: [
        {
          name: "api",
          workflow: "jobs: {}",
          required: [
            { context: "ci / checks", ruleset: `the ruleset "Required CI" (7)` },
            { context: "hub-build", ruleset: `the ruleset "Required CI" (7)` },
          ],
        },
      ],
      next: undefined,
    });
    assert.equal(pageOf(answer(true)).next, "cursor");
  });

  test("fails on an answer with errors", () => {
    assert.throws(() => pageOf({ errors: [{ message: "denied" }] }), /denied/);
  });
});
