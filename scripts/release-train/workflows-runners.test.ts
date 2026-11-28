import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parse } from "yaml";
import { listDirectory } from "./helpers/read.ts";
import { isJsonObject, isString, readJson } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { evaluate, workflowText } from "./workflows-helpers.ts";

const linux = "blacksmith-4vcpu-ubuntu-2404";
const windows = "blacksmith-4vcpu-windows-2025";
const visibilities = ["public", "private", "internal"] as const;
const systems = ["ubuntu-latest", "windows-latest"] as const;

/** One job's `runs-on` evaluated in one context. */
interface Resolution {
  job: string;
  visibility: (typeof visibilities)[number];
  os: (typeof systems)[number];
  label: string;
}

const workflows = listDirectory(new URL("../../.github/workflows/", import.meta.url)).filter((file) => /\.ya?ml$/.test(file));

function runsOn(file: string): [string, string][] {
  const workflow = readJson(JSON.stringify(parse(workflowText(file))));
  assert.ok(isJsonObject(workflow) && isJsonObject(workflow.jobs), `${file} has no jobs`);
  return Object.entries(workflow.jobs).flatMap(([job, body]): [string, string][] => {
    if (!isJsonObject(body) || body["runs-on"] === undefined) return [];
    const label = body["runs-on"];
    assert.ok(isString(label), `${file} ${job}: runs-on is not one label`);
    return [[job, label]];
  });
}

function resolve(file: string, vars: JsonObject): Resolution[] {
  return runsOn(file).flatMap(([job, expression]) =>
    visibilities.flatMap((visibility) =>
      systems.map((os) => {
        const label = expression.startsWith("${{") ? evaluate(expression, { vars, matrix: { os }, github: { event: { repository: { visibility } } } }) : expression;
        assert.ok(isString(label), `${file} ${job}: runs-on resolves to ${JSON.stringify(label)}`);
        return { job, visibility, os, label };
      }),
    ),
  );
}

/** npm trusted publishing and provenance refuse self-hosted runners, Blacksmith's included. */
const publishesPublicly = (file: string, { job, visibility }: Resolution): boolean => file === "release-npm.yml" && job === "release" && visibility === "public";

const unset: JsonObject[] = [{}, { RUNNER_CI: "", RUNNER_CI_SMALL: "", RUNNER_CI_WINDOWS: "" }];

describe("runners", () => {
  test("every job of every workflow runs on Blacksmith 4 vCPU when the caller sets no variable, but a public npm release", () => {
    for (const file of workflows) {
      for (const vars of unset) {
        for (const resolution of resolve(file, vars)) {
          const where = `${file} ${resolution.job} (${resolution.visibility}, ${resolution.os})`;
          if (publishesPublicly(file, resolution)) assert.equal(resolution.label, "ubuntu-latest", where);
          else assert.ok([linux, windows].includes(resolution.label), `${where} runs on ${resolution.label}`);
        }
      }
    }
  });

  test("no branch of a runs-on names a label but the Blacksmith ones, and ubuntu-latest only in the npm release", () => {
    for (const file of workflows) {
      for (const [job, expression] of runsOn(file)) {
        const labels = expression.startsWith("${{") ? [...expression.replace(/[!=]=\s*'[^']*'/g, "").matchAll(/'([^']*)'/g)].map((match) => match[1]) : [expression];
        const allowed = file === "release-npm.yml" && job === "release" ? [linux, "ubuntu-latest"] : [linux, windows];
        for (const label of labels) assert.ok(allowed.includes(label), `${file} ${job} can run on ${label}`);
      }
    }
  });

  test("each job moves with its own variable: RUNNER_CI_SMALL for the small ci-node jobs, RUNNER_CI_WINDOWS for the Windows legs, RUNNER_CI for the rest", () => {
    const vars = { RUNNER_CI: "other", RUNNER_CI_SMALL: "other-small", RUNNER_CI_WINDOWS: "other-windows" };
    const small = ["eligibility", "shards", "gate"];
    for (const file of workflows) {
      for (const resolution of resolve(file, vars)) {
        if (publishesPublicly(file, resolution)) continue;
        const ciNode = file === "ci-node.yml";
        const expected = ciNode && small.includes(resolution.job) ? vars.RUNNER_CI_SMALL : ciNode && resolution.job === "node" && resolution.os === "windows-latest" ? vars.RUNNER_CI_WINDOWS : vars.RUNNER_CI;
        assert.equal(resolution.label, expected, `${file} ${resolution.job} (${resolution.visibility}, ${resolution.os})`);
      }
    }
  });

  test("the Node legs run Windows on the Windows runner and Linux on the Linux one", () => {
    const node = runsOn("ci-node.yml").find(([job]) => job === "node")?.[1] ?? "";
    assert.equal(evaluate(node, { vars: {}, matrix: { os: "windows-latest" } }), windows);
    assert.equal(evaluate(node, { vars: {}, matrix: { os: "ubuntu-latest" } }), linux);
    assert.equal(evaluate(node, { vars: { RUNNER_CI: "other" }, matrix: { os: "windows-latest" } }), windows, "RUNNER_CI names a Linux label");
  });

  test("every job that runs repository code exports the UTF-8 locale and a TERM that is not dumb, as GitHub's hosted runners do, but on Windows", () => {
    const jobs: [string, string][] = [["ci-node.yml", "node"], ["ci-node.yml", "stress"], ["ci-node.yml", "formal"], ["release-npm.yml", "release"], ["module-locks-refresh.yml", "refresh"]];
    const expected = { LANG: "C.UTF-8", TERM: "xterm-256color" };
    for (const [file, job] of jobs) {
      const workflow = readJson(JSON.stringify(parse(workflowText(file))));
      assert.ok(isJsonObject(workflow) && isJsonObject(workflow.jobs) && isJsonObject(workflow.jobs[job]), `${file} has no job ${job}`);
      const env = workflow.jobs[job].env;
      if (file === "ci-node.yml" && job === "node") {
        assert.ok(!isJsonObject(env) || (!("LANG" in env) && !("TERM" in env)), "the node job env must not set LANG or TERM, which would blank them on Windows");
        const steps = workflow.jobs[job].steps;
        assert.ok(Array.isArray(steps));
        const step = steps.find((candidate) => isJsonObject(candidate) && isString(candidate.run) && candidate.run.includes("GITHUB_ENV") && candidate.run.includes("TERM="));
        assert.ok(isJsonObject(step) && step.if === "runner.os == 'Linux'", "the node job exports LANG and TERM to GITHUB_ENV on Linux only");
        const run = isString(step.run) ? step.run : "";
        for (const [name, value] of Object.entries(expected)) assert.ok(run.includes(`${name}=${value}`), `${name} on Linux`);
        continue;
      }
      assert.ok(isJsonObject(env), `${file} ${job} has no env`);
      for (const [name, value] of Object.entries(expected)) {
        const raw = env[name];
        assert.ok(isString(raw), `${file} ${job} sets no ${name}`);
        const at = (os: string): ReturnType<typeof evaluate> => (raw.startsWith("${{") ? evaluate(raw, { vars: {}, matrix: { os } }) : raw);
        assert.equal(at("ubuntu-latest"), value, `${file} ${job} ${name}`);
      }
    }
  });
});
