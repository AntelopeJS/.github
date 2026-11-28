import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parse } from "yaml";
import { listDirectory } from "./helpers/read.ts";
import { isJsonObject, isString, readJson } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { evaluate, workflowText } from "./workflows-helpers.ts";

const blacksmith = { linux: "blacksmith-4vcpu-ubuntu-2404", windows: "blacksmith-4vcpu-windows-2025" };
const hosted = { linux: "ubuntu-latest", windows: "windows-latest" };
const payload = "github.event.repository.visibility";
/** A schedule payload carries no repository, so a ci-node job that waits for eligibility also reads the visibility that job read through the API. */
const payloadOrApi = `(${payload} || needs.eligibility.outputs.visibility)`;
const linux = (visibility: string): string => `vars.RUNNER_CI || (${visibility} == 'public' && '${hosted.linux}' || '${blacksmith.linux}')`;
const windows = (visibility: string): string => `vars.RUNNER_CI_WINDOWS || (${visibility} == 'public' && '${hosted.windows}' || '${blacksmith.windows}')`;

/** One job of one workflow. */
interface Job {
  file: string;
  job: string;
  runsOn: string;
  readsEligibility: boolean;
}

/** The `runs-on` a job must carry: one expression, its visibility source picked by whether the job waits for ci-node's eligibility job. */
function pinned({ file, job, readsEligibility }: Job): string {
  const visibility = readsEligibility ? payloadOrApi : payload;
  if (file === "ci-node.yml" && job === "node") return `\${{ matrix.os == '${hosted.windows}' && (${windows(visibility)}) || (${linux(visibility)}) }}`;
  if (file === "release-npm.yml" && job === "release") return `\${{ ${payload} != 'public' && (vars.RUNNER_CI || '${blacksmith.linux}') || '${hosted.linux}' }}`;
  return `\${{ ${linux(visibility)} }}`;
}

const workflows = listDirectory(new URL("../../.github/workflows/", import.meta.url)).filter((file) => /\.ya?ml$/.test(file));

const jobs: Job[] = workflows.flatMap((file) => {
  const workflow = readJson(JSON.stringify(parse(workflowText(file))));
  assert.ok(isJsonObject(workflow) && isJsonObject(workflow.jobs), `${file} has no jobs`);
  return Object.entries(workflow.jobs).flatMap(([job, body]): Job[] => {
    if (!isJsonObject(body) || body["runs-on"] === undefined) return [];
    const runsOn = body["runs-on"];
    assert.ok(isString(runsOn), `${file} ${job}: runs-on is not one label`);
    const needs = body.needs;
    const readsEligibility = file === "ci-node.yml" && (needs === "eligibility" || (Array.isArray(needs) && needs.includes("eligibility")));
    return [{ file, job, runsOn, readsEligibility }];
  });
});

const visibilities = ["public", "private", "internal", undefined] as const;
const systems = [hosted.linux, hosted.windows] as const;

/** One job's `runs-on` evaluated in one context. */
interface Resolution {
  job: Job;
  visibility: (typeof visibilities)[number];
  api: (typeof visibilities)[number];
  os: (typeof systems)[number];
  label: string;
}

function resolve(vars: JsonObject): Resolution[] {
  return jobs.flatMap((job) =>
    visibilities.flatMap((visibility) =>
      visibilities.flatMap((api) =>
        systems.map((os) => {
          const scope = { vars, matrix: { os }, github: { event: { repository: { visibility } } }, needs: { eligibility: { outputs: { visibility: api ?? "" } } } };
          const label = evaluate(job.runsOn, scope);
          assert.ok(isString(label) && label !== "", `${job.file} ${job.job}: runs-on resolves to ${JSON.stringify(label)}`);
          return { job, visibility, api, os, label };
        }),
      ),
    ),
  );
}

const where = ({ job, visibility, api, os }: Resolution): string => `${job.file} ${job.job} (payload ${visibility ?? "absent"}, API ${api ?? "absent"}, ${os})`;
const isWindowsLeg = ({ job, os }: Resolution): boolean => job.file === "ci-node.yml" && job.job === "node" && os === hosted.windows;
const isRelease = ({ job }: Resolution): boolean => job.file === "release-npm.yml" && job.job === "release";

const unset: JsonObject[] = [{}, { RUNNER_CI: "", RUNNER_CI_WINDOWS: "" }];

describe("runners", () => {
  test("every runs-on of every workflow is the one pinned expression", () => {
    for (const job of jobs) assert.equal(job.runsOn, pinned(job), `${job.file} ${job.job}`);
  });

  test("with no variable set, a public caller runs on GitHub's runners and any other caller, or one whose visibility no source carries, on Blacksmith", () => {
    for (const vars of unset) {
      for (const resolution of resolve(vars)) {
        const visibility = resolution.visibility ?? (resolution.job.readsEligibility && !isRelease(resolution) ? resolution.api : undefined);
        const system = isWindowsLeg(resolution) ? "windows" : "linux";
        assert.equal(resolution.label, visibility === "public" ? hosted[system] : blacksmith[system], where(resolution));
      }
    }
  });

  test("a schedule run of a public caller, whose payload carries no repository, runs the ci-node jobs that wait for eligibility on GitHub's runners", () => {
    const waiting = jobs.filter((job) => job.readsEligibility).map((job) => job.job);
    assert.deepEqual(waiting, ["node", "stress", "formal", "gate"]);
    for (const resolution of resolve({})) {
      if (!resolution.job.readsEligibility || resolution.visibility !== undefined || resolution.api !== "public") continue;
      assert.equal(resolution.label, isWindowsLeg(resolution) ? hosted.windows : hosted.linux, where(resolution));
    }
  });

  test("a set RUNNER_CI moves every Linux job and RUNNER_CI_WINDOWS the Windows legs, whatever the visibility, but a public npm release", () => {
    const vars = { RUNNER_CI: "other", RUNNER_CI_WINDOWS: "other-windows" };
    for (const resolution of resolve(vars)) {
      if (isRelease(resolution) && resolution.visibility === "public") assert.equal(resolution.label, hosted.linux, `${where(resolution)}: npm trusted publishing refuses self-hosted runners`);
      else assert.equal(resolution.label, isWindowsLeg(resolution) ? vars.RUNNER_CI_WINDOWS : vars.RUNNER_CI, where(resolution));
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
