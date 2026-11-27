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

const workflows = listDirectory(new URL("../../.github/workflows/", import.meta.url)).filter((file) => file.endsWith(".yml"));

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

  test("a repository variable moves every Blacksmith job to another runner", () => {
    const vars = { RUNNER_CI: "other", RUNNER_CI_SMALL: "other-small", RUNNER_CI_WINDOWS: "other-windows" };
    for (const file of workflows) {
      for (const resolution of resolve(file, vars)) {
        if (publishesPublicly(file, resolution)) continue;
        assert.ok(Object.values(vars).includes(resolution.label), `${file} ${resolution.job} (${resolution.visibility}, ${resolution.os}) ignores the variables`);
      }
    }
  });

  test("the Node legs run Windows on the Windows runner and Linux on the Linux one", () => {
    const node = runsOn("ci-node.yml").find(([job]) => job === "node")?.[1] ?? "";
    assert.equal(evaluate(node, { vars: {}, matrix: { os: "windows-latest" } }), windows);
    assert.equal(evaluate(node, { vars: {}, matrix: { os: "ubuntu-latest" } }), linux);
    assert.equal(evaluate(node, { vars: { RUNNER_CI: "other" }, matrix: { os: "windows-latest" } }), windows, "RUNNER_CI names a Linux label");
  });
});
