import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readText } from "./helpers/read.ts";
import type { JsonObject } from "./json.ts";
import { evaluate, evaluateRules, evaluateStrings, interpolate, root, runStep, stepOf, workflowText } from "./workflows-helpers.ts";
import type { Evaluated } from "./workflows-helpers.ts";

describe("next-sync.yml", () => {
  const sync = workflowText("next-sync.yml");

  test("pushes with the app token when both app secrets are set, and fails otherwise", () => {
    const mint = /^ {8}if: (.*)$/m.exec(stepOf(sync, "Create the push token"))?.[1] ?? "";
    const pusher = /^ {10}TOKEN: (.*)$/m.exec(stepOf(sync, "Merge"))?.[1] ?? "";
    const run = (secrets: Record<string, string>) => {
      const result = runStep(sync, "Pick the push credentials", root, { RELEASE_APP_ID: "", RELEASE_APP_PRIVATE_KEY: "", ...secrets });
      const app = /^app=(.*)$/m.exec(result.outputs)?.[1] ?? "";
      const minted = evaluate(mint, { steps: { credentials: { outputs: { app } } } }) === true;
      return [result.status, interpolate(pusher, { steps: { token: { outputs: { token: minted ? "app-token" : "" } } } }), result.stdout.split(" ")[0]];
    };
    assert.deepEqual(run({ RELEASE_APP_ID: "1", RELEASE_APP_PRIVATE_KEY: "key" }), [0, "app-token", ""]);
    assert.deepEqual(run({ RELEASE_APP_ID: "1" }), [1, "", "::error::RELEASE_APP_ID"]);
    assert.deepEqual(run({ RELEASE_APP_PRIVATE_KEY: "key" }), [1, "", "::error::RELEASE_APP_ID"]);
    assert.deepEqual(run({}), [1, "", "::error::RELEASE_APP_ID"]);
  });
});

const ciNode = workflowText("ci-node.yml");
const jobText = (name: string): string => {
  const start = ciNode.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `no job ${name}`);
  const next = /\n {2}[\w-]+:\n/g;
  next.lastIndex = start + 1;
  return ciNode.slice(start, next.exec(ciNode)?.index);
};

describe("ci-node.yml runners", () => {
  test("the small jobs take the caller's RUNNER_CI_SMALL lane before RUNNER_CI, and the legs and Stress keep RUNNER_CI", () => {
    const runsOn = (job: string): string => /^ {4}runs-on: (.*)$/m.exec(jobText(job))?.[1] ?? "";
    const on = (job: string, vars: JsonObject): Evaluated => evaluate(runsOn(job), { vars, matrix: { os: "ubuntu-latest" } });
    for (const job of ["windows", "shards", "checks"]) {
      assert.equal(on(job, { RUNNER_CI_SMALL: "antelope-ci-small", RUNNER_CI: "antelope-ci" }), "antelope-ci-small", job);
      assert.equal(on(job, { RUNNER_CI: "antelope-ci" }), "antelope-ci", `${job}: without a small lane, the pool as before`);
      assert.equal(on(job, { RUNNER_CI_SMALL: "", RUNNER_CI: "antelope-ci" }), "antelope-ci", `${job}: an empty variable is unset`);
      assert.equal(on(job, {}), "blacksmith-4vcpu-ubuntu-2404", `${job}: a repository that sets nothing`);
    }
    for (const job of ["node", "stress"]) {
      assert.equal(on(job, { RUNNER_CI_SMALL: "antelope-ci-small", RUNNER_CI: "antelope-ci" }), "antelope-ci", `${job} runs a full install: never the small lane`);
    }
  });
});

describe("ci-node.yml verdict", () => {
  test("checks is the one reporting job: it needs every other job, runs unless the run was cancelled, and there is no verdict job after it", () => {
    assert.doesNotMatch(ciNode, /^ {2}verdict:$/m, "a second reporting job is a second queue hop on the pool for a run that is already decided");
    assert.match(jobText("checks"), /^ {4}needs: \[windows, shards, node, stress\]$/m, "checks waits for every other job");
    const gate = /^ {4}if: (.*)$/m.exec(jobText("checks"))?.[1] ?? "";
    assert.equal(gate, "${{ !cancelled() }}", "not always(): a job that runs after a cancel waits for a runner of the pool");
    const runs = (runCancelled: boolean): boolean => evaluate(gate.replace(/\bcancelled\(\)/g, String(runCancelled)), {}) === true;
    assert.equal(runs(false), true, "a run that was not cancelled always gets its checks, whatever its jobs ended with");
    assert.equal(runs(true), false, "a cancelled run's checks end cancelled, a conclusion that blocks a merge");
    const fail = stepOf(ciNode, "Fail when a job failed, was cancelled or did not run");
    assert.match(fail, /NEEDS: \$\{\{ toJSON\(needs\) \}\}/, "the step reads every need's result and names the failed ones");
  });
});

describe("ci-node.yml", () => {
  test("Windows legs join the matrix only for a repository the API reports public, in the nightly tier and, with windows-merge-queue, in the merge queue and manual runs", () => {
    const gate = /^ {4}if: (.*)$/m.exec(jobText("windows"))?.[1] ?? "";
    const matrix = /^ {8}os: (.*)$/m.exec(jobText("node"))?.[1] ?? "";
    assert.doesNotMatch(matrix, /github\.event\.repository/, "a schedule payload carries no repository");
    const os = (visibility: string, event: string, inputs: JsonObject): Evaluated => {
      const github = { event_name: event, event: {} };
      const ran = evaluate(gate, { github, inputs }) === true;
      return evaluate(matrix, { github, inputs, needs: { windows: { outputs: { visibility: ran ? visibility : "" } } } });
    };
    const events = ["schedule", "merge_group", "workflow_dispatch", "pull_request", "push"];
    for (const visibility of ["public", "private", "internal"]) {
      for (const event of events) {
        for (const [windows, queue, pullRequests, nightly] of [[true, false, false, false], [true, true, false, false], [true, false, true, false], [true, true, true, false], [true, false, false, true], [false, true, false, false], [false, false, false, true], [false, false, false, false]]) {
          const inputs = { windows, "windows-merge-queue": queue, "windows-pull-requests": pullRequests, nightly };
          const manual = event === "merge_group" || event === "workflow_dispatch";
          const before = windows && (event === "schedule" || (event === "workflow_dispatch" && nightly) || (manual && (queue || pullRequests)));
          const expected = visibility === "public" && before ? ["ubuntu-latest", "windows-latest"] : ["ubuntu-latest"];
          assert.deepEqual(os(visibility, event, inputs), expected, `${visibility} ${event} ${JSON.stringify(inputs)}`);
        }
      }
    }
  });

  test("the Windows gate reads the visibility with one API call and fails when the call fails", () => {
    const bin = join(root, "windows-gate-bin");
    mkdirSync(bin, { recursive: true });
    const log = join(root, "windows-gate-gh.log");
    writeFileSync(join(bin, "gh"), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\n[ -n "$FAKE_VISIBILITY" ] || exit 1\necho "$FAKE_VISIBILITY"\n');
    chmodSync(join(bin, "gh"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, GH_LOG: log, GITHUB_REPOSITORY: "AntelopeJS/x" };
    for (const visibility of ["public", "private"]) {
      writeFileSync(log, "");
      const result = runStep(ciNode, "Read the repository visibility", root, { ...env, FAKE_VISIBILITY: visibility });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.outputs, `visibility=${visibility}\n`);
      assert.equal(readText(log), "api repos/AntelopeJS/x --jq .visibility\n");
    }
    const failed = runStep(ciNode, "Read the repository visibility", root, { ...env, FAKE_VISIBILITY: "" });
    assert.notEqual(failed.status, 0);
    assert.equal(failed.outputs, "");
  });

  test("a failed Windows gate fails the run instead of dropping the Windows legs", () => {
    assert.match(jobText("node"), /^ {4}needs: \[windows, shards\]\n {4}if: \$\{\{ !cancelled\(\) && needs\.windows\.result != 'failure' && needs\.shards\.result != 'failure' \}\}$/m);
    assert.match(jobText("checks"), /^ {4}needs: \[windows, shards, node, stress\]$/m);
  });

  test("a newer run of the same pull request cancels the older run whole, and any cancelled run's checks end cancelled instead of failing", () => {
    const [, group = "", cancel = ""] = /^concurrency:\n {2}group: (.*)\n {2}cancel-in-progress: (.*)$/m.exec(ciNode) ?? [];
    assert.doesNotMatch(jobText("node"), /concurrency:/, "a leg holds no group of its own, so a newer run cancels the older run whole");
    const pullRequest = (number: number | undefined): JsonObject => (number === undefined ? {} : { number });
    const github = (event_name: string, run_id: number, number?: number) => ({ event_name, run_id, workflow: "ci", event: { pull_request: pullRequest(number) } });
    const concurrency = (scope: JsonObject) => ({ group: interpolate(group, { github: scope }), cancel: evaluate(cancel, { github: scope }) });
    assert.deepEqual(concurrency(github("pull_request", 2, 45)), { group: concurrency(github("pull_request", 1, 45)).group, cancel: true });
    for (const event of ["push", "merge_group", "schedule", "workflow_dispatch"]) {
      assert.deepEqual(concurrency(github(event, 1)), { group: "ci-node-ci-1", cancel: false }, event);
      assert.notEqual(concurrency(github(event, 2)).group, concurrency(github(event, 1)).group, event);
    }

    const gate = /^ {4}if: (.*)$/m.exec(jobText("checks"))?.[1] ?? "";
    const fail = /^ {8}if: (.*)$/m.exec(stepOf(ciNode, "Fail when a job failed, was cancelled or did not run"))?.[1] ?? "";
    const checks = (event: string, runCancelled: boolean, node: string): string => {
      const results = { windows: "skipped", shards: "skipped", node, stress: "skipped" };
      const status = (expression: string): string => expression.replace(/\bcancelled\(\)/g, String(runCancelled)).replaceAll("needs.*.result", JSON.stringify(Object.values(results)));
      const needs = Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: { tier: "fast" } }]));
      if (evaluate(status(gate), { github: { event_name: event } }) !== true) return "cancelled";
      return evaluate(status(fail), { needs }) === true ? "failure" : "success";
    };
    assert.equal(checks("pull_request", true, "cancelled"), "cancelled", "a newer run superseded this one");
    assert.equal(checks("pull_request", false, "success"), "success");
    assert.equal(checks("pull_request", false, "failure"), "failure");
    assert.equal(checks("pull_request", false, "cancelled"), "failure", "a leg that timed out is cancelled in a run that was not");
    for (const event of ["push", "merge_group", "schedule", "workflow_dispatch"]) {
      assert.equal(checks(event, true, "cancelled"), "cancelled", `${event}: a cancelled run takes no runner for its checks`);
      assert.equal(checks(event, false, "failure"), "failure", event);
      assert.equal(checks(event, false, "cancelled"), "failure", `${event}: a leg that timed out is cancelled in a run that was not`);
    }
  });

  test("extra-commands-shards splits the extra-commands job into one job per shard, and the default keeps one", () => {
    const node = jobText("node");
    const line = (key: string): string => new RegExp(`^ {4,8}${key}: (.*)$`, "m").exec(node)?.[1] ?? "";
    const extra = stepOf(ciNode, "Run extra commands");
    const extraIf = /^ {8}if: (.*)$/m.exec(extra)?.[1] ?? "";
    const extraShard = /^ {10}ANTELOPEJS_CI_SHARD: (.*)$/m.exec(extra)?.[1] ?? "";
    const legs = (overrides: JsonObject): string[] => {
      const inputs = { "node-versions": "", "single-job": true, "services-compose-file": "", "extra-commands": "pnpm run e2e", "extra-commands-job": true, "extra-commands-shards": 1, ...overrides };
      const ran = evaluate(/^ {4}if: (.*)$/m.exec(jobText("shards"))?.[1] ?? "", { inputs }) === true;
      const listed = ran ? runStep(ciNode, "List the extra-commands shards", root, { SHARDS: String(inputs["extra-commands-shards"]) }) : undefined;
      assert.equal(listed?.status ?? 0, 0, listed?.stderr);
      const outputs: Record<string, string> = {};
      for (const entry of (listed?.outputs ?? "").split("\n").filter(Boolean)) {
        const [key = "", value = ""] = entry.split(/=(.*)/s);
        outputs[key] = value;
      }
      const scope = { inputs, needs: { windows: { outputs: { visibility: "" } }, shards: { outputs } } };
      const exclude = evaluateRules(line("exclude"), scope);
      const combinations = (["os", "node-version", "part", "shard"] as const)
        .reduce<Record<string, string>[]>((partial, key) => partial.flatMap((matrix) => evaluateStrings(line(key), scope).map((value) => ({ ...matrix, [key]: value }))), [{}])
        .filter((matrix) => !exclude.some((rule) => Object.entries(rule).every(([key, value]) => matrix[key] === value)));
      return combinations.map((matrix) => {
        const name = interpolate(line("name"), { matrix });
        if (evaluate(extraIf, { matrix, inputs, steps: { leg: { outputs: { work: "true" } } } }) !== true) return name;
        const shard = interpolate(extraShard, { matrix });
        const result = runStep(ciNode, "Run extra commands", root, { ANTELOPEJS_CI_TIER: "full", EXTRA_COMMANDS: 'echo "shard ${ANTELOPEJS_CI_SHARD-unset}"', ANTELOPEJS_CI_SHARD: shard });
        assert.equal(result.status, 0, result.stderr);
        return `${name}: ${result.stdout.trim()}`;
      });
    };

    assert.deepEqual(legs({}), ["Node .nvmrc", "Extra .nvmrc: shard unset"]);
    assert.deepEqual(legs({ "extra-commands-shards": 3 }), ["Node .nvmrc", "Extra .nvmrc 1/3: shard 1/3", "Extra .nvmrc 2/3: shard 2/3", "Extra .nvmrc 3/3: shard 3/3"]);
    assert.deepEqual(legs({ "extra-commands-shards": 2, "single-job": false }), ["Node .nvmrc", "Test .nvmrc", "Extra .nvmrc 1/2: shard 1/2", "Extra .nvmrc 2/2: shard 2/2"]);
    assert.deepEqual(legs({ "extra-commands-shards": 3, "extra-commands-job": false }), ["Node .nvmrc: shard unset"]);
    assert.notEqual(runStep(ciNode, "List the extra-commands shards", root, { SHARDS: "2.5" }).status, 0);
  });
});

test("the starter workflow is the frozen caller that antelopejs-sync writes", () => {
  const template = readText(new URL("../../workflow-templates/npm-release.yml", import.meta.url));
  assert.equal(template, readText(new URL("./frozen-caller.yml", import.meta.url)));
});

test("the README caller example is the starter workflow", () => {
  const readme = readText(new URL("../../README.md", import.meta.url));
  const section = readme.slice(readme.indexOf("### Caller workflow"));
  const example = /```yaml\n([\s\S]*?)```/.exec(section)?.[1];
  assert.equal(example, readText(new URL("../../workflow-templates/npm-release.yml", import.meta.url)));
});