import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parse } from "yaml";
import { listDirectory } from "./helpers/read.ts";
import { isJsonObject, isString, readJson } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { evaluate, workflowText } from "./workflows-helpers.ts";

const blacksmith = { linux: "blacksmith-4vcpu-ubuntu-2404", windows: "blacksmith-4vcpu-windows-2025" };
const hosted = { linux: "ubuntu-latest", windows: "windows-latest" };
const isPublic = "github.event.repository.visibility == 'public'";
const linux = `vars.RUNNER_CI || (${isPublic} && '${hosted.linux}' || '${blacksmith.linux}')`;
const windows = `vars.RUNNER_CI_WINDOWS || (${isPublic} && '${hosted.windows}' || '${blacksmith.windows}')`;

/** The one `runs-on` every job carries. */
const pinned = `\${{ ${linux} }}`;

/** The two jobs that carry another. */
const exceptions = new Map([
  ["ci-node.yml node", `\${{ matrix.os == '${hosted.windows}' && (${windows}) || (${linux}) }}`],
  ["release-npm.yml release", `\${{ github.event.repository.visibility != 'public' && (vars.RUNNER_CI || '${blacksmith.linux}') || '${hosted.linux}' }}`],
]);

const visibilities = ["public", "private", "internal", undefined] as const;
const systems = [hosted.linux, hosted.windows] as const;

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
        const label = evaluate(expression, { vars, matrix: { os }, github: { event: { repository: { visibility } } } });
        assert.ok(isString(label) && label !== "", `${file} ${job}: runs-on resolves to ${JSON.stringify(label)}`);
        return { job, visibility, os, label };
      }),
    ),
  );
}

const isRelease = (file: string, job: string): boolean => file === "release-npm.yml" && job === "release";
const isWindowsLeg = (file: string, { job, os }: Resolution): boolean => file === "ci-node.yml" && job === "node" && os === hosted.windows;

const unset: JsonObject[] = [{}, { RUNNER_CI: "", RUNNER_CI_WINDOWS: "" }];

describe("runners", () => {
  test("every runs-on of every workflow is the one pinned expression, but the Node legs' and the npm release's", () => {
    for (const file of workflows) {
      for (const [job, expression] of runsOn(file)) {
        const key = `${file} ${job}`;
        assert.equal(expression, exceptions.get(key) ?? pinned, key);
      }
    }
  });

  test("with no variable set, a public caller runs on GitHub's runners and any other caller, or one whose visibility the event does not carry, on Blacksmith", () => {
    for (const file of workflows) {
      for (const vars of unset) {
        for (const resolution of resolve(file, vars)) {
          const system = isWindowsLeg(file, resolution) ? "windows" : "linux";
          const expected = resolution.visibility === "public" ? hosted[system] : blacksmith[system];
          assert.equal(resolution.label, expected, `${file} ${resolution.job} (${resolution.visibility ?? "absent"}, ${resolution.os})`);
        }
      }
    }
  });

  test("a set RUNNER_CI moves every Linux job and RUNNER_CI_WINDOWS the Windows legs, whatever the visibility, but a public npm release", () => {
    const vars = { RUNNER_CI: "other", RUNNER_CI_WINDOWS: "other-windows" };
    for (const file of workflows) {
      for (const resolution of resolve(file, vars)) {
        const where = `${file} ${resolution.job} (${resolution.visibility ?? "absent"}, ${resolution.os})`;
        if (isRelease(file, resolution.job) && resolution.visibility === "public") assert.equal(resolution.label, hosted.linux, `${where}: npm trusted publishing refuses self-hosted runners`);
        else assert.equal(resolution.label, isWindowsLeg(file, resolution) ? vars.RUNNER_CI_WINDOWS : vars.RUNNER_CI, where);
      }
    }
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
