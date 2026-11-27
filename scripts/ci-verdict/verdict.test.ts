import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { isList, isObject, isText } from "../ci-metrics/json.ts";
import { pageOf } from "./github.ts";
import { read } from "./helpers/read.ts";
import { SHARED_CI_VERDICT_JOB, jobsOf, parseYaml, problemsOf, verdictOf, type RequiredCheck } from "./verdict.ts";

const ciNode = read(".github/workflows/ci-node.yml");

const CALL = "  ci:\n    uses: AntelopeJS/.github/.github/workflows/ci-node.yml@v2\n";
const RENOVATE = "  renovate-sync:\n    uses: AntelopeJS/.github/.github/workflows/ci-renovate-sync.yml@v2\n";
const workflow = (...jobs: string[]): string => `on: pull_request\njobs:\n${jobs.join("")}`;
const verdictJob = (needs: string, condition = "${{ !cancelled() }}"): string => `  verdict:\n    needs: ${needs}\n    if: ${condition}\n    runs-on: ubuntu-latest\n`;
const required = (...contexts: string[]): RequiredCheck[] => contexts.map((context) => ({ context, ruleset: `the ruleset "R" (1)` }));

/** The script of the step named `name` of the job `id` of `workflow`. */
function stepRun(workflow: string, id: string, name: string): string {
  const parsed = parseYaml(workflow);
  const jobs = isObject(parsed) ? parsed.jobs : undefined;
  const job = isObject(jobs) ? jobs[id] : undefined;
  const steps = isObject(job) && isList(job.steps) ? job.steps : [];
  const step = steps.find((candidate) => isObject(candidate) && candidate.name === name);
  const run = isObject(step) ? step.run : undefined;
  assert.ok(isText(run), `the ${id} job has a step ${name} that runs a script`);
  return run;
}

const runScript = (run: string, needs: Record<string, { result: string; outputs: Record<string, string> }>) => {
  const { status, stdout } = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, NEEDS: JSON.stringify(needs) },
  });
  return { status, stdout };
};
const results = (entries: Record<string, string>, tier = "fast"): Record<string, { result: string; outputs: Record<string, string> }> =>
  Object.fromEntries(
    Object.entries(entries).map(([job, result]) => {
      const outputs: Record<string, string> = job === "node" ? { tier } : {};
      return [job, { result, outputs }];
    }),
  );

/** The caller example of the README's "The verdict of a caller". */
function readmeExample(): string {
  const readme = read("README.md");
  return /```yaml\n([\s\S]*?)```/.exec(readme.slice(readme.indexOf("### The verdict of a caller")))?.[1] ?? "";
}

describe("the verdict of ci-node.yml", () => {
  test("is the check checks, which its gate job or its only leg reports, and it has no second reporting job", () => {
    assert.equal(SHARED_CI_VERDICT_JOB, "checks", "the check every ruleset requires is ci / checks");
    assert.ok(!jobsOf(ciNode).some((job) => job.id === "verdict"), "no second reporting job: each is a queue hop on the pool");
  });

  const run = stepRun(ciNode, "gate", "Fail when a job failed, was cancelled or did not run");
  test("its failing step names each job that failed or was cancelled, then the tier and the node and Stress results", () => {
    assert.deepEqual(runScript(run, results({ windows: "skipped", shards: "skipped", node: "failure", stress: "skipped" })), {
      status: 1,
      stdout: "node: failure\n::error::Tier fast: node failure, stress skipped.\n",
    });
    assert.deepEqual(runScript(run, results({ windows: "success", shards: "skipped", node: "success", stress: "cancelled" }, "nightly")), {
      status: 1,
      stdout: "stress: cancelled\n::error::Tier nightly: node success, stress cancelled.\n",
    });
    assert.deepEqual(runScript(run, results({ windows: "skipped", shards: "skipped", node: "skipped", stress: "skipped" })), {
      status: 1,
      stdout: "::error::Tier fast: node skipped, stress skipped.\n",
    });
  });
});

describe("the verdict of a caller", () => {
  const run = stepRun(readmeExample(), "verdict", "Fail when a job failed or was cancelled");
  const verdict = (entries: Record<string, string>) => runScript(run, results(entries));

  test("passes when every job succeeded or was skipped", () => {
    assert.deepEqual(verdict({ ci: "success", "renovate-sync": "skipped" }), { status: 0, stdout: "" });
  });

  test("fails naming each job that failed or was cancelled", () => {
    assert.deepEqual(verdict({ ci: "failure", "renovate-sync": "failure" }), { status: 1, stdout: "ci: failure\nrenovate-sync: failure\n" });
    assert.deepEqual(verdict({ ci: "success", "renovate-sync": "cancelled" }), { status: 1, stdout: "renovate-sync: cancelled\n" });
  });
});

describe("a repository's conformance", () => {
  test("a ci.yml that is one ci-node.yml call conforms when its rulesets require ci / checks alone", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL), required: required("ci / checks") }), []);
  });

  test("a job beside the ci-node.yml call needs a verdict job of the repository", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE), required: required("verdict") }), [
      "ci.yml is not a single ci-node.yml call (jobs ci, renovate-sync) and has no verdict job",
    ]);
  });

  test("a verdict job conforms when it needs every other job and runs with if: ${{ !cancelled() }}", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE, verdictJob("[ci, renovate-sync]")), required: required("verdict") }), []);
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE, verdictJob("[ci, renovate-sync]", "'!cancelled()'")), required: required("verdict") }), []);
  });

  test("a verdict job names each job it does not need", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE, verdictJob("ci")), required: required("verdict") }), ["its verdict job does not need renovate-sync"]);
  });

  test("a verdict job that a failed job would skip is reported", () => {
    for (const condition of ["${{ success() }}", "${{ !cancelled() && github.event_name == 'merge_group' }}", "github.event_name != 'push'"]) {
      assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE, verdictJob("[ci, renovate-sync]", condition)), required: required("verdict") }), [
        "its verdict job does not run with if: ${{ !cancelled() }}, so a failed job skips it and the skipped check passes",
      ], condition);
    }
  });

  test("a verdict job that runs in a cancelled run is reported, since it waits for a runner only to fail", () => {
    for (const condition of ["${{ always() }}", "always()"]) {
      assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL, RENOVATE, verdictJob("[ci, renovate-sync]", condition)), required: required("verdict") }), [
        "its verdict job runs with if: always(), so a cancelled run still waits for a runner to fail it; use if: ${{ !cancelled() }}",
      ], condition);
    }
  });

  test("each required check other than the verdict is named, and a verdict no ruleset requires is reported", () => {
    assert.deepEqual(problemsOf({ name: "x", workflow: workflow(CALL), required: required("ci / verdict", "hub-build") }), [
      `the ruleset "R" (1) requires ci / verdict, not ci / checks`,
      `the ruleset "R" (1) requires hub-build, not ci / checks`,
      "no ruleset requires ci / checks",
    ]);
  });

  test("the caller example of the README conforms", () => {
    assert.deepEqual(verdictOf(jobsOf(readmeExample())), { check: "verdict", problems: [] });
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
