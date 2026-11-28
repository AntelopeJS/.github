import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readText } from "./helpers/read.ts";
import type { Json, JsonObject } from "./json.ts";
import { commitFiles, evaluate, evaluateRules, interpolate, repository, root, runStep, stepOf, workflowText } from "./workflows-helpers.ts";
import type { Evaluated } from "./workflows-helpers.ts";
import { ciNode, declaredTestShards, inputsOf, jobText, legs, listed, names, outputsOf, runs } from "./workflows-ci-node-legs.ts";
import type { Overrides, Picked } from "./workflows-ci-node-legs.ts";

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

describe("ci-node.yml verdict", () => {
  const key = (job: string, name: string): string => new RegExp(`^ {4}${name}: (.*)$`, "m").exec(jobText(job))?.[1] ?? "";

  test("the gate is the job named checks: it needs every other job, runs unless the run was cancelled, and there is no verdict job after it", () => {
    assert.doesNotMatch(ciNode, /^ {2}verdict:$/m, "a second reporting job is a second queue hop on the pool for a run that is already decided");
    assert.equal(key("gate", "name"), "checks", "every ruleset requires ci / checks");
    assert.match(jobText("gate"), /^ {4}needs: \[eligibility, shards, node, stress, formal\]$/m, "the gate waits for every other job");
    assert.equal(key("gate", "if"), "${{ !cancelled() }}", "not always(): a job that runs after a cancel waits for a runner of the pool");
    const fail = stepOf(ciNode, "Fail when a job failed, was cancelled or did not run");
    assert.match(fail, /NEEDS: \$\{\{ toJSON\(needs\) \}\}/, "the step reads every need's result and names the failed ones");
  });

  test("a job that a run can skip has a constant name, which GitHub shows as is, and only the gate is named checks", () => {
    const jobs = [...ciNode.slice(ciNode.indexOf("\njobs:\n")).matchAll(/^ {2}([\w-]+):$/gm)].map(([, id]) => id ?? "");
    assert.deepEqual(jobs, ["eligibility", "shards", "node", "stress", "formal", "gate"]);
    for (const job of jobs.filter((id) => id !== "node")) {
      assert.doesNotMatch(key(job, "name"), /\$\{\{/, `${job}: GitHub never evaluates the name of a skipped job, and shows its expression`);
      assert.ok(job === "gate" || key(job, "name") !== "checks", `${job} would report a second ci / checks`);
    }
    assert.equal(key("node", "if"), "${{ !cancelled() && needs.eligibility.result != 'failure' && needs.shards.result != 'failure' }}", "a leg skips only in a run that a failed need already fails, or in a cancelled run");
    const names = ["ubuntu-latest", "windows-latest"].flatMap((os) => ["", "24"].flatMap((version) => ["all", "checks", "test", "extra"].flatMap((part) => ["", "1/2"].map((shard) =>
      evaluate(key("node", "name"), { matrix: { os, "node-version": version, part, shard } })))));
    assert.ok(names.includes("Node .nvmrc") && names.includes("Test 24 on Windows") && names.includes("Extra .nvmrc 1/2"), JSON.stringify(names));
    assert.ok(!names.includes("checks"), "a leg never reports ci / checks");
  });
});

describe("ci-node.yml", () => {
  const pickStep = "Pick the Windows legs and Stress from the event, the day and the repository visibility";
  const fakes = (weekday: number) => {
    const bin = join(root, `eligibility-bin-${weekday}`);
    mkdirSync(bin, { recursive: true });
    const log = join(bin, "gh.log");
    writeFileSync(join(bin, "gh"), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\n[ -n "$FAKE_VISIBILITY" ] || exit 1\necho "$FAKE_VISIBILITY"\n');
    writeFileSync(join(bin, "date"), `#!/usr/bin/env bash\n[ "$*" = "-u +%u" ] || exit 1\necho ${weekday}\n`);
    chmodSync(join(bin, "gh"), 0o755);
    chmodSync(join(bin, "date"), 0o755);
    return { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, GH_LOG: log, GITHUB_REPOSITORY: "AntelopeJS/x" }, log };
  };
  const monday = 1;
  const sunday = 7;

  type Caller = { windows: boolean; "windows-merge-queue": boolean; "windows-pull-requests": boolean; nightly: boolean };
  interface Case {
    visibility: string;
    event: string;
    weekday: number;
    inputs: Caller;
  }
  interface Plan {
    os: Evaluated;
    stress: boolean;
    checks: boolean;
  }
  const callers: Caller[] = [[true, false, false, false], [true, true, false, false], [true, false, true, false], [true, true, true, false], [true, false, false, true], [false, true, false, false], [false, false, false, true], [false, false, false, false]]
    .map(([windows = false, queue = false, pullRequests = false, nightly = false]) => ({ windows, "windows-merge-queue": queue, "windows-pull-requests": pullRequests, nightly }));
  const cases: Case[] = ["public", "private", "internal"].flatMap((visibility) =>
    ["schedule", "merge_group", "workflow_dispatch", "pull_request", "push"].flatMap((event) =>
      [monday, sunday].flatMap((weekday) => callers.map((inputs) => ({ visibility, event, weekday, inputs })))));

  const expectedPlan = ({ visibility, event, weekday, inputs }: Case): Plan => {
    const manual = event === "merge_group" || event === "workflow_dispatch";
    const weekly = (event === "schedule" && weekday === sunday) || (event === "workflow_dispatch" && inputs.nightly);
    const windowsLegs = inputs.windows && (weekly || (manual && (inputs["windows-merge-queue"] || inputs["windows-pull-requests"])));
    return { os: visibility === "public" && windowsLegs ? ["ubuntu-latest", "windows-latest"] : ["ubuntu-latest"], stress: weekly, checks: true };
  };

  const workflowPlan = ({ visibility, event, weekday, inputs }: Case): Plan => {
    const gate = /^ {4}if: (.*)$/m.exec(jobText("eligibility"))?.[1] ?? "";
    const matrix = /^ {8}os: (.*)$/m.exec(jobText("node"))?.[1] ?? "";
    const stress = /^ {4}if: (.*)$/m.exec(jobText("stress"))?.[1] ?? "";
    const fail = /^ {8}if: (.*)$/m.exec(stepOf(ciNode, "Fail when a job failed, was cancelled or did not run"))?.[1] ?? "";
    const github = { event_name: event, event: {} };
    const ran = evaluate(gate, { github, inputs }) === true;
    const picked = ran ? runStep(ciNode, pickStep, root, { ...fakes(weekday).env, FAKE_VISIBILITY: visibility, EVENT: event, WINDOWS: String(inputs.windows) }) : undefined;
    assert.equal(picked?.status ?? 0, 0, picked?.stderr);
    const outputs = Object.fromEntries((picked?.outputs ?? "").split("\n").filter((line) => line !== "").map((line): [string, string] => {
      const [name = "", value = ""] = line.split("=");
      return [name, value];
    }));
    const tier = event === "schedule" || (event === "workflow_dispatch" && inputs.nightly) ? "nightly" : "full";
    const needs = { eligibility: { result: ran ? "success" : "skipped", outputs }, node: { result: "success", outputs: { tier } } };
    const stressRuns = evaluate(stress.replace(/!cancelled\(\)/g, "true"), { needs }) === true;
    const stressResult = stressRuns ? "success" : "skipped";
    const results = ["skipped", "skipped", "success", stressResult, "skipped"];
    const checks = evaluate(fail.replaceAll("needs.*.result", JSON.stringify(results)), { needs: { ...needs, stress: { result: stressResult } } }) !== true;
    return { os: evaluate(matrix, { github, inputs, needs }), stress: stressRuns, checks };
  };

  test("Windows legs join the matrix only for a repository the API reports public, in the Sunday and dispatched nightly tier and, with windows-merge-queue, in the merge queue and manual runs; Stress runs in the Sunday and dispatched nightly tier", () => {
    assert.doesNotMatch(/^ {8}os: (.*)$/m.exec(jobText("node"))?.[1] ?? "", /github\.event\.repository/, "a schedule payload carries no repository");
    for (const run of cases) {
      assert.deepEqual(workflowPlan(run), expectedPlan(run), `${run.visibility} ${run.event} day ${run.weekday} ${JSON.stringify(run.inputs)}`);
    }
  });

  test("the eligibility job reads the visibility with one API call only when Windows may run, and fails when the call fails", () => {
    const run = (weekday: number, event: string, visibility: string) => {
      const { env, log } = fakes(weekday);
      writeFileSync(log, "");
      return { ...runStep(ciNode, pickStep, root, { ...env, FAKE_VISIBILITY: visibility, EVENT: event, WINDOWS: "true" }), calls: readText(log) };
    };
    for (const visibility of ["public", "private"]) {
      const result = run(sunday, "schedule", visibility);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.outputs, `windows=${visibility === "public"}\nstress=true\n`);
      assert.equal(result.calls, "api repos/AntelopeJS/x --jq .visibility\n");
    }
    const weeknight = run(monday, "schedule", "public");
    assert.equal(weeknight.outputs, "windows=false\nstress=false\n");
    assert.equal(weeknight.calls, "", "a weeknight runs no Windows leg, so it reads nothing");
    const failed = run(sunday, "schedule", "");
    assert.notEqual(failed.status, 0);
    assert.equal(failed.outputs, "");
  });

  test("a failed eligibility job fails the run instead of dropping the Windows legs", () => {
    assert.match(jobText("node"), /^ {4}needs: \[eligibility, shards\]\n {4}if: \$\{\{ !cancelled\(\) && needs\.eligibility\.result != 'failure' && needs\.shards\.result != 'failure' \}\}$/m);
    assert.match(jobText("gate"), /^ {4}needs: \[eligibility, shards, node, stress, formal\]$/m);
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

    const gate = /^ {4}if: (.*)$/m.exec(jobText("gate"))?.[1] ?? "";
    const fail = /^ {8}if: (.*)$/m.exec(stepOf(ciNode, "Fail when a job failed, was cancelled or did not run"))?.[1] ?? "";
    const checks = (event: string, runCancelled: boolean, node: string): string => {
      const results = { eligibility: "skipped", shards: "skipped", node, stress: "skipped", formal: "skipped" };
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
});

describe("ci-node.yml shards", () => {
  const allCallers = (axes: Record<string, Json[]>): Overrides[] =>
    Object.entries(axes).reduce<Overrides[]>((callers, [input, choices]) => callers.flatMap((caller) => choices.map((choice) => ({ ...caller, [input]: choice }))), [{}]);
  const noExtra = { "extra-commands-job": false, "extra-commands": "" };

  test("extra-commands-shards splits the extra-commands job into one job per shard, and the default keeps one", () => {
    assert.deepEqual(legs({}), ["Node .nvmrc", "Extra .nvmrc: shard unset"]);
    assert.deepEqual(legs({ "extra-commands-shards": 3 }), ["Node .nvmrc", "Extra .nvmrc 1/3: shard 1/3", "Extra .nvmrc 2/3: shard 2/3", "Extra .nvmrc 3/3: shard 3/3"]);
    assert.deepEqual(legs({ "extra-commands-shards": 2, "single-job": false }), ["Node .nvmrc", "Test .nvmrc", "Extra .nvmrc 1/2: shard 1/2", "Extra .nvmrc 2/2: shard 2/2"]);
    assert.deepEqual(legs({ "extra-commands-shards": 3, "extra-commands-job": false }), ["Node .nvmrc: shard unset"]);
    assert.notEqual(runStep(ciNode, "List the shards", root, { EXTRA_SHARDS: "2.5", TEST_SHARDS: "1" }).status, 0);
  });

  test("a caller that passes no test-shards, or 1, gets the jobs it always had", () => {
    assert.equal(declaredTestShards, 1);
    const callers = allCallers({
      "single-job": [true, false],
      "services-compose-file": ["", "docker-compose.yml"],
      "extra-commands-job": [true, false],
      "extra-commands": ["pnpm run e2e", ""],
      "extra-commands-shards": [1, 3],
      "node-versions": ["", "[22, 24]"],
    });
    assert.equal(callers.length, 64);
    for (const caller of callers) {
      assert.deepEqual(runs({ ...caller, "test-shards": 1 }), runs({ ...caller, "test-shards": undefined }), JSON.stringify(caller));
    }

    assert.deepEqual(names(noExtra), ["Node .nvmrc"]);
    assert.deepEqual(runs(noExtra), ["Node .nvmrc: tests shard unset"]);
    assert.deepEqual(runs({ ...noExtra, "single-job": false }), ["Node .nvmrc", "Test .nvmrc: tests shard unset"]);
    assert.deepEqual(runs({ ...noExtra, "services-compose-file": "docker-compose.yml", "node-versions": "[22, 24]" }), ["Node 22", "Test 22: tests shard unset", "Node 24", "Test 24: tests shard unset"]);
    assert.deepEqual(runs({}), ["Node .nvmrc: tests shard unset", "Extra .nvmrc: extra shard unset"]);
    assert.deepEqual(runs({ "extra-commands-shards": 3 }), ["Node .nvmrc: tests shard unset", "Extra .nvmrc 1/3: extra shard 1/3", "Extra .nvmrc 2/3: extra shard 2/3", "Extra .nvmrc 3/3: extra shard 3/3"]);
    for (const caller of [{}, { "extra-commands-shards": 3, "extra-commands-job": false }, { "test-shards": 1 }]) {
      assert.equal(listed(inputsOf(caller)), undefined, "no Extra shards job when nothing splits");
    }

    const outputs = listed(inputsOf({ "extra-commands-shards": 3 }));
    assert.equal(outputs?.shards, '["","1/3","2/3","3/3"]');
    const rules = evaluateRules(outputs?.exclude ?? "[]", {}).map((rule) => `${rule.part} ${rule.shard}`);
    assert.deepEqual(rules.sort(), ["all 1/3", "all 2/3", "all 3/3", "checks 1/3", "checks 2/3", "checks 3/3", "extra ", "test 1/3", "test 2/3", "test 3/3"]);
  });

  test("test-shards splits the tests of each Node version into one job per shard, and the checks run once in their own Node leg", () => {
    const four = { ...noExtra, "node-versions": "[22, 24]", "test-shards": 4 };
    const versions = ["22", "24"];
    assert.deepEqual(names(four), versions.flatMap((version) => [`Node ${version}`, ...[1, 2, 3, 4].map((shard) => `Test ${version} ${shard}/4`)]));
    assert.deepEqual(runs(four), versions.flatMap((version) => [`Node ${version}`, ...[1, 2, 3, 4].map((shard) => `Test ${version} ${shard}/4: tests shard ${shard}/4`)]));
    assert.deepEqual(runs({ ...four, "single-job": false }), runs(four), "single-job false changes nothing once the tests are split");
    assert.deepEqual(runs({ ...four, "services-compose-file": "docker-compose.yml" }), runs(four));
    assert.deepEqual(runs({ ...noExtra, "test-shards": 2 }), ["Node .nvmrc", "Test .nvmrc 1/2: tests shard 1/2", "Test .nvmrc 2/2: tests shard 2/2"]);
  });

  test("test-shards and extra-commands-shards of different counts split their own part only", () => {
    const tests = (count: number): string[] => Array.from({ length: count }, (_, index) => `Test .nvmrc ${index + 1}/${count}: tests shard ${index + 1}/${count}`);
    const extras = (count: number): string[] => Array.from({ length: count }, (_, index) => `Extra .nvmrc ${index + 1}/${count}: extra shard ${index + 1}/${count}`);
    assert.deepEqual(runs({ "test-shards": 4, "extra-commands-shards": 2 }), ["Node .nvmrc", ...tests(4), ...extras(2)]);
    assert.deepEqual(runs({ "test-shards": 2, "extra-commands-shards": 3 }), ["Node .nvmrc", ...tests(2), ...extras(3)]);
    assert.deepEqual(runs({ "test-shards": 3, "extra-commands-shards": 1 }), ["Node .nvmrc", ...tests(3), "Extra .nvmrc: extra shard unset"]);
    assert.deepEqual(runs({ "test-shards": 4, "extra-commands-shards": 3, "extra-commands-job": false }), ["Node .nvmrc: extra shard unset", ...tests(4)]);
  });

  test("test-shards that is not a whole number fails the shards step and names the input", () => {
    for (const value of ["2.5", "0", "-1", "", "abc"]) {
      const result = runStep(ciNode, "List the shards", root, { EXTRA_SHARDS: "1", TEST_SHARDS: value });
      assert.notEqual(result.status, 0, value);
      assert.match(result.stdout, /^::error::test-shards must be a whole number/, value);
    }
    const extra = runStep(ciNode, "List the shards", root, { EXTRA_SHARDS: "2.5", TEST_SHARDS: "2" });
    assert.notEqual(extra.status, 0);
    assert.match(extra.stdout, /^::error::extra-commands-shards must be a whole number/);
    assert.equal(runStep(ciNode, "List the shards", root, { EXTRA_SHARDS: "1", TEST_SHARDS: "3" }).status, 0);
  });

  test("a pull request that changes only documentation runs no test shard, and one that changes source runs all of them", () => {
    const summary = join(root, "shards-summary");
    const environment = join(root, "shards-env");
    const checkout = repository("shards-checkout", { "README.md": "a\n", "docs/guide.md": "a\n", "src/a.ts": "a\n" });
    const pick = (part: string): Picked => {
      writeFileSync(summary, "");
      writeFileSync(environment, "");
      const result = runStep(ciNode, "Pick the work of this leg from the tier", checkout.directory, { TIER: "fast", BASE: checkout.sha, PART: part, EVENT: "pull_request", NIGHTLY: "false", PRIMARY_LEG: "true", GITHUB_ENV: environment, GITHUB_STEP_SUMMARY: summary });
      assert.equal(result.status, 0, result.stderr);
      const outputs = outputsOf(result.outputs);
      return { work: outputs.work, tests: outputs.tests };
    };
    const split = { ...noExtra, "test-shards": 4 };

    commitFiles(checkout.directory, "docs: readme", { "README.md": "b\n", "docs/guide.md": "b\n", "docs/new.md": "c\n" });
    assert.equal(pick("test").work, "false");
    assert.deepEqual(runs(split, pick), ["Node .nvmrc", "Test .nvmrc 1/4", "Test .nvmrc 2/4", "Test .nvmrc 3/4", "Test .nvmrc 4/4"]);

    commitFiles(checkout.directory, "fix: a", { "src/a.ts": "b\n" });
    assert.equal(pick("test").work, "true");
    assert.deepEqual(runs(split, pick), ["Node .nvmrc", ...[1, 2, 3, 4].map((shard) => `Test .nvmrc ${shard}/4: tests shard ${shard}/4`)]);
  });
});

describe("ci-node.yml formal checks", () => {
  const formal = jobText("formal");
  const pick = "Pick the work of this check from the tier and the files it models";
  const summary = join(root, "formal-summary.md");
  const checkout = repository("formal-checkout", { ".agents/skills/formal-a/check.mjs": "a\n", "src/a.ts": "a\n", "src/b.ts": "b\n" });

  const work = (tier: string, base: string, paths?: string[]): string => {
    writeFileSync(summary, "");
    const result = runStep(ciNode, pick, checkout.directory, { TIER: tier, BASE: base, SKILL: "formal-a", PATHS: JSON.stringify(paths ?? null), GITHUB_STEP_SUMMARY: summary });
    assert.equal(result.status, 0, result.stderr);
    return result.outputs;
  };

  test("a caller that passes no formal-checks gets no Formal job, and each entry is one Formal leg", () => {
    const gate = /^ {4}if: (.*)$/m.exec(formal)?.[1] ?? "";
    assert.equal(evaluate(gate, { inputs: { "formal-checks": "" } }), false, "the frozen callers pass nothing and run as before");
    assert.equal(evaluate(gate, { inputs: { "formal-checks": "[]" } }), false, "an empty matrix would fail the run");
    const inputs = { "formal-checks": '[{"skill": "formal-a"}, {"skill": "formal-b", "paths": ["src/b.ts"], "run": "node b.mjs"}]' };
    assert.equal(evaluate(gate, { inputs }), true);
    const include = /^ {8}include: (.*)$/m.exec(formal)?.[1] ?? "";
    assert.equal(/^ {4}name: (.*)$/m.exec(formal)?.[1], "Formal", "GitHub appends each leg's matrix values, as in Formal (formal-a), and shows a skipped Formal as is");
    assert.deepEqual(evaluateRules(include, { inputs }).map((matrix) => matrix.skill), ["formal-a", "formal-b"]);
  });

  test("a fast-tier pull request runs a check only when its skill folder or a file it models changed, and every other tier runs it", () => {
    const base = checkout.sha;
    commitFiles(checkout.directory, "fix: b", { "src/b.ts": "b2\n" });
    assert.equal(work("fast", base, ["src/a.ts"]), "work=false\n");
    assert.equal(readText(summary), "`formal-a`: skipped, the pull request changes no file it models\n");
    assert.equal(work("fast", base, ["src/a.ts", "src/b.ts"]), "work=true\n");
    assert.equal(work("fast", base, [":(glob)src/**/*.ts"]), "work=true\n", "paths are git pathspecs");
    assert.equal(work("fast", base), "work=true\n", "a check that names no paths runs on every pull request");
    for (const tier of ["full", "queue", "nightly"]) assert.equal(work(tier, base, ["src/a.ts"]), "work=true\n", tier);
    assert.equal(work("none", "", ["src/a.ts"]), "work=false\n");

    const skillBase = commitFiles(checkout.directory, "docs: readme", { "README.md": "x\n" });
    commitFiles(checkout.directory, "fix: model", { ".agents/skills/formal-a/check.mjs": "a2\n" });
    assert.equal(work("fast", skillBase, ["src/a.ts"]), "work=true\n", "a change to the model runs its check");
  });

  test("an entry without a valid skill, or whose paths are not a non-empty list of strings, fails its leg", () => {
    const status = (skill: string, paths: string): number => runStep(ciNode, pick, checkout.directory, { TIER: "full", BASE: "", SKILL: skill, PATHS: paths, GITHUB_STEP_SUMMARY: summary }).status;
    assert.equal(status("formal-a", '["src/a.ts"]'), 0);
    for (const skill of ["", "../formal-a", "formal a", "-x"]) assert.notEqual(status(skill, "null"), 0, skill);
    for (const paths of ['"src/a.ts"', "[]", "[1]", '[""]', '["src/a.ts\\nsrc/b.ts"]', '{"src": "a.ts"}']) assert.notEqual(status("formal-a", paths), 0, paths);
  });

  test("a check runs the skill's check.mjs unless run gives the commands, fails on the first failing command, and reports its exit and time", () => {
    const step = stepOf(ciNode, "Run the formal check");
    const commands = /^ {10}COMMANDS: (.*)$/m.exec(step)?.[1] ?? "";
    assert.equal(interpolate(commands, { matrix: { skill: "formal-a" } }), "node .agents/skills/formal-a/check.mjs");
    assert.equal(interpolate(commands, { matrix: { skill: "formal-a", run: "node --test a.test.mjs\nnode a.mjs" } }), "node --test a.test.mjs\nnode a.mjs");
    const run = (lines: string): [number, string] => {
      writeFileSync(summary, "");
      const result = runStep(ciNode, "Run the formal check", root, { SKILL: "formal-a", COMMANDS: lines, GITHUB_STEP_SUMMARY: summary });
      return [result.status, readText(summary)];
    };
    assert.deepEqual(run("true"), [0, "`formal-a`: exit 0 in 0 s\n"]);
    assert.deepEqual(run("echo BROKEN OneChargePerPeriod\nexit 1"), [1, "`formal-a`: exit 1 in 0 s\n"]);
    assert.deepEqual(run("false\ntrue"), [1, "`formal-a`: exit 1 in 0 s\n"]);
  });

  test("checks needs every Formal leg, so a failing formal check blocks the merge", () => {
    const fail = /^ {8}if: (.*)$/m.exec(stepOf(ciNode, "Fail when a job failed, was cancelled or did not run"))?.[1] ?? "";
    const fails = (result: string): boolean => {
      const results = { eligibility: "skipped", shards: "skipped", node: "success", stress: "skipped", formal: result };
      const needs = Object.fromEntries(Object.entries(results).map(([job, value]) => [job, { result: value, outputs: { tier: "queue" } }]));
      return evaluate(fail.replaceAll("needs.*.result", JSON.stringify(Object.values(results))), { needs }) === true;
    };
    assert.equal(fails("failure"), true);
    assert.equal(fails("cancelled"), true, "a check that hung past its timeout");
    assert.equal(fails("success"), false);
    assert.equal(fails("skipped"), false, "a caller that passes no formal-checks");
  });
});

describe("ci-node.yml pnpm store", () => {
  const leg = (tier: string, event: string, part: string, primary: boolean) => {
    const env = join(root, "store-env");
    const summary = join(root, "store-summary");
    writeFileSync(env, "");
    writeFileSync(summary, "");
    const result = runStep(ciNode, "Pick the work of this leg from the tier", root, { TIER: tier, BASE: "", PART: part, EVENT: event, NIGHTLY: "false", PRIMARY_LEG: String(primary), GITHUB_ENV: env, GITHUB_STEP_SUMMARY: summary });
    assert.equal(result.status, 0, result.stderr);
    const output = (name: string): string | undefined => new RegExp(`^${name}=(.*)$`, "m").exec(result.outputs)?.[1];
    return { work: output("work"), install: output("install") };
  };
  const condition = (step: string): string => /^ {8}if: (.*)$/m.exec(stepOf(ciNode, step))?.[1] ?? "";
  const restore = stepOf(ciNode, "Restore the pnpm store of this lockfile, else the newest one");
  const save = stepOf(ciNode, "Save the pnpm store from the default branch");

  test("a push to the default branch installs on one leg, which seeds the store, and runs no check", () => {
    assert.deepEqual([leg("none", "push", "all", true).work, leg("none", "push", "all", true).install], ["false", "true"]);
    assert.equal(leg("none", "push", "checks", true).install, "true");
    assert.equal(leg("none", "push", "test", true).install, "false", "one leg per run seeds it");
    assert.equal(leg("none", "push", "all", false).install, "false", "the second Node version saves nothing new");
    for (const [tier, event] of [["full", "workflow_dispatch"], ["queue", "merge_group"], ["nightly", "schedule"]]) {
      assert.deepEqual([leg(tier, event, "all", false).work, leg(tier, event, "all", false).install], ["true", "true"], tier);
    }
  });

  test("the seeding leg installs only when the store lacks its lockfile, and a leg with work always installs", () => {
    const install = condition("Install dependencies");
    const run = (work: string, hit: string): Evaluated => evaluate(install, { steps: { leg: { outputs: { work, install: "true" } }, store: { outputs: { "cache-hit": hit } } } });
    assert.deepEqual([run("false", "true"), run("false", ""), run("true", "true"), run("true", "")], [false, true, true, true]);
  });

  test("only the default branch and the nightly schedule save the store, and they never start it from another lockfile's", () => {
    const key = (step: string, name: string): string => new RegExp(`^ {10}${name}: (.*)$`, "m").exec(step)?.[1] ?? "";
    assert.equal(key(save, "key"), key(restore, "key"));
    assert.equal(key(restore, "path"), key(save, "path"));
    const prefix = key(restore, "key").replace(/\$\{\{ hashFiles\('pnpm-lock\.yaml'\) \}\}$/, "");
    assert.notEqual(prefix, key(restore, "key"), "the key ends with the lockfile hash");
    const savesStore = /^ {6}SAVES_STORE: (.*)$/m.exec(ciNode)?.[1] ?? "";
    const runner = { os: "Linux", arch: "X64" };
    const store = (event_name: string, ref: string, hit = "") => {
      const github = { event_name, ref, event: event_name === "schedule" ? {} : { repository: { default_branch: "main" } } };
      const scope = { github, runner, env: { SAVES_STORE: evaluate(savesStore, { github }) === true ? "true" : "false" }, steps: { leg: { outputs: { install: "true" } }, store: { outputs: { "cache-hit": hit } } } };
      return { saves: evaluate(condition("Save the pnpm store from the default branch"), scope), fallback: evaluate(key(restore, "restore-keys"), scope) };
    };
    const fresh = { saves: true, fallback: "" };
    const borrowed = { saves: false, fallback: interpolate(prefix, { runner }) };
    assert.equal(borrowed.fallback, "node-cache-Linux-x64-pnpm-", "setup-node's key, so the stores it saved keep serving");
    assert.deepEqual(store("push", "refs/heads/main"), fresh, "a saved store holds one lockfile's packages, so it never grows");
    assert.deepEqual(store("schedule", "refs/heads/main"), fresh, "a schedule payload names no repository, and it runs on the default branch");
    assert.deepEqual(store("workflow_dispatch", "refs/heads/main"), fresh);
    assert.equal(store("push", "refs/heads/main", "true").saves, false, "the store of this lockfile is already saved");
    assert.deepEqual(store("pull_request", "refs/pull/7/merge"), borrowed, "a pull request's store would serve that pull request alone");
    assert.deepEqual(store("merge_group", "refs/heads/gh-readonly-queue/main/pr-7-abc"), borrowed);
    assert.deepEqual(store("workflow_dispatch", "refs/heads/feature"), borrowed);
  });

  test("the seeding leg only looks the store up, and a leg with work downloads it", () => {
    const lookup = /^ {10}lookup-only: (.*)$/m.exec(restore)?.[1] ?? "";
    assert.equal(evaluate(lookup, { steps: { leg: { outputs: { work: "false" } } } }), true, "a push that leaves the lockfile alone downloads nothing");
    assert.equal(evaluate(lookup, { steps: { leg: { outputs: { work: "true" } } } }), false);
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