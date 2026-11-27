import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readText } from "./helpers/read.ts";
import type { JsonObject } from "./json.ts";
import { commitFiles, evaluate, evaluateRules, evaluateStrings, interpolate, repository, root, runStep, stepOf, workflowText } from "./workflows-helpers.ts";
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
    for (const job of ["windows", "shards", "gate"]) {
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
  const key = (job: string, name: string): string => new RegExp(`^ {4}${name}: (.*)$`, "m").exec(jobText(job))?.[1] ?? "";
  const matrixKey = (name: string): string => new RegExp(`^ {8}${name}: (.*)$`, "m").exec(jobText("node"))?.[1] ?? "";
  const notCancelled = (expression: string): string => expression.replace(/\bcancelled\(\)/g, "false");

  test("the gate needs every other job, runs unless the run was cancelled, and there is no verdict job after it", () => {
    assert.doesNotMatch(ciNode, /^ {2}verdict:$/m, "a second reporting job is a second queue hop on the pool for a run that is already decided");
    assert.doesNotMatch(ciNode, /^ {2}checks:$/m, "a skipped job whose id is checks would report a passing ci / checks");
    assert.match(jobText("gate"), /^ {4}needs: \[windows, shards, node, stress, formal\]$/m, "the gate waits for every other job");
    assert.match(key("gate", "if"), /^\$\{\{ !cancelled\(\) && /, "not always(): a job that runs after a cancel waits for a runner of the pool");
    const scope = { github: { event_name: "pull_request" }, inputs: { "single-job": false, "node-versions": "" }, needs: { windows: { result: "skipped" } } };
    assert.equal(evaluate(key("gate", "if").replace(/\bcancelled\(\)/g, "true"), scope), false, "a cancelled run's checks end cancelled, a conclusion that blocks a merge");
    const fail = stepOf(ciNode, "Fail when a job failed, was cancelled or did not run");
    assert.match(fail, /NEEDS: \$\{\{ toJSON\(needs\) \}\}/, "the step reads every need's result and names the failed ones");
  });

  test("exactly one job that runs is named checks: the gate, or the run's only leg when nothing else runs beside it", () => {
    const axes: JsonObject[][] = [
      ["pull_request", "merge_group", "push", "schedule", "workflow_dispatch"].map((event) => ({ event })),
      [["skipped", ""], ["success", "public"], ["success", "private"], ["failure", ""]].map(([windows, visibility]) => ({ windows, visibility })),
      ["skipped", "success"].map((shards) => ({ shards })),
      [true, false].map((singleJob) => ({ "single-job": singleJob })),
      ["", "compose.yml"].map((services) => ({ "services-compose-file": services })),
      [[false, ""], [false, "x"], [true, ""], [true, "x"]].map(([extraJob, extra]) => ({ "extra-commands-job": extraJob, "extra-commands": extra })),
      ["", "[24]", "[22, 24]"].map((versions) => ({ "node-versions": versions })),
      [false, true].map((nightly) => ({ nightly })),
      ["", "[]", '[{"skill": "formal-a"}]'].map((formal) => ({ "formal-checks": formal })),
    ];
    const scenarios = axes.reduce<JsonObject[]>((partial, axis) => partial.flatMap((scenario) => axis.map((value) => ({ ...scenario, ...value }))), [{}]);
    let folded = 0;
    for (const { event, windows, visibility, shards, ...inputs } of scenarios) {
      const scope = { github: { event_name: event }, inputs, needs: { windows: { result: windows, outputs: { visibility } }, shards: { result: shards, outputs: {} } } };
      const versions = evaluate(matrixKey("node-version"), scope);
      assert.ok(Array.isArray(versions));
      const legsRun = evaluate(notCancelled(key("node", "if")), scope) === true;
      const legs = !legsRun ? [] : evaluateStrings(matrixKey("os"), scope).flatMap((os) =>
        versions.flatMap((version) => evaluateStrings(matrixKey("part"), scope).map((part) => evaluate(key("node", "name"), { ...scope, matrix: { os, "node-version": version, part, shard: "" } }))));
      const gateRuns = evaluate(notCancelled(key("gate", "if")), scope) === true;
      const gateName = evaluate(key("gate", "name"), scope);
      const reporting = [...legs.filter((name) => name === "checks"), ...(gateRuns && gateName === "checks" ? ["gate"] : [])];
      const label = JSON.stringify({ event, windows, visibility, ...inputs });
      assert.equal(reporting.length, 1, `${label}: ${JSON.stringify({ legs, gateRuns, gateName })}`);
      if (gateRuns) continue;
      folded += 1;
      assert.notEqual(gateName, "checks", `${label}: a skipped check named checks passes`);
      assert.deepEqual(legs, ["checks"], `${label}: the fold needs one leg`);
      assert.ok(event !== "schedule" && !(event === "workflow_dispatch" && inputs.nightly === true), `${label}: the nightly tier has a Stress job for the gate to judge`);
      assert.equal(evaluate(key("formal", "if"), scope), false, `${label}: the gate judges the Formal jobs`);
    }
    assert.ok(folded > 0, "a small module's run folds the gate into its leg");
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
    assert.match(jobText("gate"), /^ {4}needs: \[windows, shards, node, stress, formal\]$/m);
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
    const twoParts = { "single-job": false, "services-compose-file": "", "extra-commands-job": false, "extra-commands": "", "node-versions": "", nightly: false };
    const checks = (event: string, runCancelled: boolean, node: string): string => {
      const results = { windows: "skipped", shards: "skipped", node, stress: "skipped", formal: "skipped" };
      const status = (expression: string): string => expression.replace(/\bcancelled\(\)/g, String(runCancelled)).replaceAll("needs.*.result", JSON.stringify(Object.values(results)));
      const needs = Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: { tier: "fast" } }]));
      if (evaluate(status(gate), { github: { event_name: event }, inputs: twoParts, needs }) !== true) return "cancelled";
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
        const name = interpolate(line("name"), { matrix, inputs, github: { event_name: "pull_request" }, needs: { windows: { result: "skipped" } } });
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
    assert.deepEqual(legs({ "extra-commands-shards": 3, "extra-commands-job": false }), ["checks: shard unset"], "one leg alone reports ci / checks");
    assert.notEqual(runStep(ciNode, "List the extra-commands shards", root, { SHARDS: "2.5" }).status, 0);
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
    const name = /^ {4}name: (.*)$/m.exec(formal)?.[1] ?? "";
    assert.deepEqual(
      evaluateRules(include, { inputs }).map((matrix) => interpolate(name, { matrix })),
      ["Formal formal-a", "Formal formal-b"],
    );
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
      const results = { windows: "skipped", shards: "skipped", node: "success", stress: "skipped", formal: result };
      const needs = Object.fromEntries(Object.entries(results).map(([job, value]) => [job, { result: value, outputs: { tier: "queue" } }]));
      return evaluate(fail.replaceAll("needs.*.result", JSON.stringify(Object.values(results))), { needs }) === true;
    };
    assert.equal(fails("failure"), true);
    assert.equal(fails("cancelled"), true, "a check that hung past its timeout");
    assert.equal(fails("success"), false);
    assert.equal(fails("skipped"), false, "a caller that passes no formal-checks");
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