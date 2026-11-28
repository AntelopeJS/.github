import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./json.ts";
import type { Json, JsonObject } from "./json.ts";
import { evaluate, evaluateRules, interpolate, root, runStep, stepOf, workflowText } from "./workflows-helpers.ts";
import type { Scope } from "./workflows-helpers.ts";

export const ciNode = workflowText("ci-node.yml");

export const jobText = (name: string): string => {
  const start = ciNode.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `no job ${name}`);
  const next = /\n {2}[\w-]+:\n/g;
  next.lastIndex = start + 1;
  return ciNode.slice(start, next.exec(ciNode)?.index);
};

/** The inputs a caller sets, where `undefined` leaves an input absent so that its declared default applies. */
export type Overrides = Record<string, Json | undefined>;

/** The outputs of the step that picks the work of a leg. */
export interface Picked {
  work: string;
  tests: string;
}

/** One job of the node matrix, with what its test and extra-commands steps print when they run. */
export interface Job {
  name: string;
  tests?: string;
  extra?: string;
}

const node = jobText("node");
const line = (key: string): string => new RegExp(`^ {4,8}${key}: (.*)$`, "m").exec(node)?.[1] ?? "";
const envOf = (step: string, key: string): string => new RegExp(`^ {10}${key}: (.*)$`, "m").exec(step)?.[1] ?? "";
const stepIf = (step: string): string => /^ {8}if: (.*)$/m.exec(step)?.[1] ?? "";
const listStep = stepOf(ciNode, "List the shards");
const testsStep = stepOf(ciNode, "Run tests");
const extraStep = stepOf(ciNode, "Run extra commands");

export const declaredTestShards = readJson(/^ {6}test-shards:\n(?: {8}.*\n)*? {8}default: (.*)$/m.exec(ciNode)?.[1] ?? "null");

/** The outputs of the node leg's work-picking step when every part has tests to run. */
export const everyPart = (): Picked => ({ work: "true", tests: "true" });

const bin = join(root, "shard-bin");
mkdirSync(bin);
writeFileSync(join(bin, "pnpm"), '#!/bin/sh\necho "shard ${ANTELOPEJS_CI_SHARD-unset}"\n');
chmodSync(join(bin, "pnpm"), 0o755);

export const outputsOf = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((entry) => {
        const [key = "", value = ""] = entry.split(/=(.*)/s);
        return [key, value];
      }),
  );

const values = (expression: string, scope: Scope): string[] => {
  const list = evaluate(expression, scope);
  assert.ok(Array.isArray(list), `${expression} is not a list`);
  return list.map(String);
};

/** The inputs of a caller, with the declared default for each one it leaves undefined. */
export const inputsOf = (overrides: Overrides): JsonObject => {
  const caller = { "node-versions": "", "single-job": true, "services-compose-file": "", "extra-commands": "pnpm run e2e", "extra-commands-job": true, "extra-commands-shards": 1, "formal-checks": "", ...overrides };
  const inputs: JsonObject = { "test-shards": declaredTestShards };
  for (const [key, value] of Object.entries(caller)) if (value !== undefined) inputs[key] = value;
  return inputs;
};

/** The outputs of the shards job for a caller, or undefined when the job does not run. */
export const listed = (inputs: JsonObject) => {
  if (evaluate(/^ {4}if: (.*)$/m.exec(jobText("shards"))?.[1] ?? "", { inputs }) !== true) return undefined;
  const result = runStep(ciNode, "List the shards", root, { EXTRA_SHARDS: interpolate(envOf(listStep, "EXTRA_SHARDS"), { inputs }), TEST_SHARDS: interpolate(envOf(listStep, "TEST_SHARDS"), { inputs }) });
  assert.equal(result.status, 0, result.stderr);
  return outputsOf(result.outputs);
};

const runLeg = (step: string, name: string, matrix: Record<string, string>, env: Record<string, string>): string => {
  const result = runStep(ciNode, name, root, { ANTELOPEJS_CI_TIER: "full", ANTELOPEJS_CI_SHARD: interpolate(envOf(step, "ANTELOPEJS_CI_SHARD"), { matrix }), ...env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** Every job the node matrix expands to for a caller, with the shard each running step sees. */
export const jobs = (overrides: Overrides, pick: (part: string) => Picked = everyPart): Job[] => {
  const inputs = inputsOf(overrides);
  const scope = { inputs, needs: { eligibility: { outputs: { windows: "" } }, shards: { outputs: listed(inputs) ?? {} } } };
  const exclude = evaluateRules(line("exclude"), scope);
  const combinations = (["os", "node-version", "part", "shard"] as const)
    .reduce<Record<string, string>[]>((partial, key) => partial.flatMap((matrix) => values(line(key), scope).map((value) => ({ ...matrix, [key]: value }))), [{}])
    .filter((matrix) => !exclude.some((rule) => Object.entries(rule).every(([key, value]) => matrix[key] === value)));
  return combinations.map((matrix) => {
    const steps = { leg: { outputs: pick(matrix.part ?? "") } };
    const job: Job = { name: interpolate(line("name"), { matrix }) };
    if (evaluate(stepIf(testsStep), { matrix, inputs, steps }) === true) {
      job.tests = runLeg(testsStep, "Run tests", matrix, { PATH: `${bin}:${process.env.PATH ?? ""}`, AFFECTED_TESTS: "false" });
    }
    if (evaluate(stepIf(extraStep), { matrix, inputs, steps }) === true) {
      job.extra = runLeg(extraStep, "Run extra commands", matrix, { EXTRA_COMMANDS: 'echo "shard ${ANTELOPEJS_CI_SHARD-unset}"' });
    }
    return job;
  });
};

export const names = (overrides: Overrides): string[] => jobs(overrides).map((job) => job.name);

/** The jobs of a caller, each followed by what its extra-commands step prints. */
export const legs = (overrides: Overrides): string[] => jobs(overrides).map((job) => (job.extra === undefined ? job.name : `${job.name}: ${job.extra}`));

/** The jobs of a caller, each followed by what its test and extra-commands steps print. */
export const runs = (overrides: Overrides, pick?: (part: string) => Picked): string[] =>
  jobs(overrides, pick).map((job) => [job.name, ...(job.tests === undefined ? [] : [`tests ${job.tests}`]), ...(job.extra === undefined ? [] : [`extra ${job.extra}`])].join(": "));
